import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

for (const traceRate of [1, 0])
  test(`Sentry errors/privacy and Worker/both-DO continuity at trace rate ${traceRate}`, async (t) => {
    const events = [];
    const bodies = [];
    const listeners = new Set();
    const received = (predicate) => {
      if (events.some(predicate)) return Promise.resolve(events.find(predicate));
      return new Promise((resolve) => {
        const listener = () => {
          const event = events.find(predicate);
          if (event) {
            listeners.delete(listener);
            resolve(event);
          }
        };
        listeners.add(listener);
      });
    };
    let rejectTelemetry = false;
    const x = await start(t, {
      metering: true,
      traceRate,
      telemetry: async (request) => {
        const body = await request.text();
        bodies.push(body);
        const lines = body.trim().split("\n");
        for (let i = 1; i + 1 < lines.length; i += 2) {
          const header = JSON.parse(lines[i]);
          if (["event", "transaction"].includes(header.type)) events.push(JSON.parse(lines[i + 1]));
        }
        for (const listener of listeners) listener();
        return Response.json({}, { status: rejectTelemetry ? 503 : 200 });
      },
    });
    const account = await x.account();
    const server = await x.server(account.id, { name: "PRIVATE_MESSAGE_SENTINEL" });
    await x.call("user_alice", "GET", `/v1/servers/${server.id}/summary`);
    await x.control(`quota/publish?account=${account.id}`, {
      accountId: account.id,
      start: new Date(Date.now() - 1000).toISOString(),
      end: new Date(Date.now() + 3600000).toISOString(),
      allowance: 4,
      overdraft: 2,
    });
    const registered = await x.call("user_alice", "POST", `/v1/servers/${server.id}/participants`, {
      name: "PRIVATE_AGENT_SENTINEL",
      agentType: "codex",
      requestKey: randomUUID(),
    });
    await x.call(
      "user_alice",
      "POST",
      `/v1/servers/${server.id}/conversations/${registered.generalConversationId}/messages`,
      {
        participantId: registered.item.id,
        requestKey: randomUUID(),
        body: "PRIVATE_MESSAGE_SENTINEL",
      },
    );
    if (traceRate) {
      await received((event) =>
        event.spans?.some((span) => span.description === "Metering.consume"),
      );
      await received((event) =>
        event.spans?.some((span) => span.description === "Sqlite.resolveAccess"),
      );
      await received((event) =>
        event.spans?.some((span) => span.description === "Platform.createServer"),
      );
      const spans = events.flatMap((event) => event.spans ?? []);
      assert.ok(
        spans.some((span) => span.description === "Platform.createServer"),
        JSON.stringify(spans.map((s) => s.description)),
      );
      assert.ok(spans.some((span) => span.op?.startsWith("db")));
      assert.ok(spans.some((span) => span.description === "Metering.consume"));
      assert.ok(spans.some((span) => span.description === "TalkTo.append"));
      assert.ok(
        !spans.some((span) =>
          ["Sqlite.find", "Sqlite.read", "Sqlite.execute"].includes(span.description),
        ),
      );
      const traces = new Map();
      for (const event of events) {
        const trace = event.contexts?.trace;
        if (trace) traces.set(trace.trace_id, [...(traces.get(trace.trace_id) ?? []), event]);
      }
      assert.ok(
        [...traces.values()].some((group) => group.length > 2),
        "Worker, server DO and quota DO must share a trace",
      );
    }
    await x.control("database-down?value=true");
    const failed = await x.call("user_alice", "GET", `/v1/accounts/${account.id}`, undefined, 503);
    const error = await received(
      (event) => event.tags?.["talkto.request_id"] === failed.meta.requestId,
    );
    assert.equal(error.tags["talkto.code"], "storage_unavailable");
    // The Cloudflare location that ran the request is tagged, so a per-location outage shows where.
    const located = await x.raw(`/v1/accounts/${account.id}`, {
      headers: { authorization: `Bearer ${await x.token("user_alice")}` },
      cf: { colo: "TBS", city: "PRIVATE_CITY_SENTINEL" },
    });
    assert.equal(located.status, 503);
    const locatedId = (await located.json()).meta.requestId;
    const locatedError = await received((event) => event.tags?.["talkto.request_id"] === locatedId);
    assert.equal(locatedError.tags["talkto.colo"], "TBS");
    assert.ok(!JSON.stringify(locatedError).includes("PRIVATE_CITY_SENTINEL"));
    // An MCP tool that throws is reported once, with its cause, and names the tool.
    const tool = await x.mcp(await x.mcpToken(account.organizationId), "get_context", {}, true);
    assert.equal(tool.error.code, "internal_error");
    const toolError = await received(
      (event) => event.tags?.["talkto.request_id"] === tool.meta.requestId,
    );
    assert.equal(toolError.tags["talkto.operation"], "mcp.get_context");
    assert.equal(toolError.tags["talkto.stage"], "mcp");
    if (!traceRate) assert.equal(events.filter((event) => event.type === "transaction").length, 0);
    const denied = await x.raw("/v1/me?query=PRIVATE_QUERY_SENTINEL", {
      headers: {
        cookie: "PRIVATE_COOKIE_SENTINEL",
        authorization: "Bearer PRIVATE_TOKEN_SENTINEL",
      },
    });
    assert.equal(denied.status, 401);
    await x.control("database-down?value=false");
    rejectTelemetry = true;
    await x.call("user_alice", "GET", `/v1/accounts/${account.id}`);
    assert.doesNotMatch(
      bodies.join("\n"),
      /PRIVATE_|Bearer |user_alice@example\.com|user_bob@example\.com/,
    );
    assert.ok(
      events
        .filter((event) => event.exception && event.tags?.["talkto.stage"] !== "mcp")
        .every((event) => event.tags?.["talkto.code"] === "storage_unavailable"),
    );
    assert.equal(
      events.filter((event) => event.tags?.["talkto.request_id"] === tool.meta.requestId).length,
      1,
      "the Worker must not report the tool failure a second time",
    );
    if (!traceRate) {
      for (const stage of ["durable_object", "alarm", "worker"]) {
        const path =
          stage === "worker"
            ? "/__telemetry/error"
            : `/__telemetry/${stage === "alarm" ? "alarm" : "error"}?server=${server.id}`;
        try {
          await (await x.raw(path)).text();
        } catch {
          /* Workerd surfaces deliberate unhandled faults as rejections. */
        }
        const event = await received(
          (event) => event.tags?.["talkto.stage"] === `fixture.${stage}`,
        );
        assert.ok(event.exception.values[0].stacktrace.frames.length > 0);
        if (stage === "worker") assert.equal(event.tags["talkto.operation"], "fixture.uncaught");
      }
      // A CPU-limited Durable Object is named by a fixed failure kind; its message never leaves.
      try {
        await (await x.raw(`/__telemetry/cpu-limit?server=${server.id}`)).text();
      } catch {
        /* Workerd surfaces deliberate unhandled faults as rejections. */
      }
      const limited = await received(
        (event) => event.tags?.["talkto.stage"] === "fixture.cpu_limit",
      );
      assert.equal(limited.tags["talkto.failure_kind"], "cpu_limit");
      assert.equal(limited.exception.values[0].value, "Unexpected application failure");
      // A D1 store's safe failure carries its rejection's class, never the rejection itself.
      assert.equal((await x.raw("/__telemetry/d1-cause")).status, 200);
      const d1 = await received((event) => event.tags?.["talkto.request_id"] === "fixture-d1");
      assert.equal(d1.tags["talkto.failure_kind"], "connection_lost");
      assert.equal(d1.tags["talkto.operation"], "fixture.d1");
      assert.equal(d1.exception.values.length, 1);
      // Cloudflare's runtime flags are separate tags beside the unchanged failure kind.
      assert.equal((await x.raw("/__telemetry/runtime-flags")).status, 200);
      const flagged = await received(
        (event) => event.tags?.["talkto.request_id"] === "fixture-flags",
      );
      assert.equal(flagged.tags["talkto.failure_kind"], "overloaded");
      assert.equal(flagged.tags["talkto.cf_retryable"], "true");
      assert.equal(flagged.tags["talkto.cf_overloaded"], "true");
      assert.equal(flagged.tags["talkto.cf_remote"], "false");
      assert.equal(flagged.tags["talkto.step"], undefined);
      const kept = await received(
        (event) => event.tags?.["talkto.request_id"] === "fixture-kept-flags",
      );
      assert.equal(kept.tags["talkto.failure_kind"], "retryable");
      assert.equal(kept.tags["talkto.cf_retryable"], "true");
      assert.equal(kept.tags["talkto.cf_overloaded"], undefined);
      // A get_updates whose server-object call fails in the runtime names the step; the client
      // sees the same internal_error as before.
      const organization = await x.mcpToken(account.organizationId);
      for (const [step, waitSeconds] of [
        ["invoke", 0],
        ["first_read", 5],
      ]) {
        await x.raw(`/__telemetry/server-fault?server=${server.id}&step=${step}`);
        const updates = await x.mcp(
          organization,
          "get_updates",
          {
            serverId: server.id,
            participantId: registered.item.id,
            mode: "start",
            startAt: "now",
            channelIds: [],
            directChats: "own",
            waitSeconds,
          },
          true,
        );
        assert.equal(updates.error.code, "internal_error");
        assert.equal(
          updates.error.message,
          "An internal error occurred. Use the request ID for diagnosis. Retain creation request keys when retrying.",
        );
        assert.doesNotMatch(JSON.stringify(updates), /PRIVATE_|first_read|cf_|"step"/);
        const failed = await received(
          (event) => event.tags?.["talkto.request_id"] === updates.meta.requestId,
        );
        assert.equal(failed.tags["talkto.step"], step, step);
        assert.equal(failed.tags["talkto.operation"], "mcp.get_updates");
        assert.equal(failed.exception.values[0].value, "Unexpected application failure");
        // Each fault comes from the server object, so Cloudflare flags it remote.
        assert.equal(failed.tags["talkto.cf_remote"], "true", step);
      }
      // A watch that fails to open does not fail the call: it polls until its deadline and
      // answers with a page, and Sentry gets a warning tagged with the step and runtime flags.
      await x.raw(`/__telemetry/server-fault?server=${server.id}&step=watch`);
      const started = Date.now();
      const polled = await x.mcp(organization, "get_updates", {
        serverId: server.id,
        participantId: registered.item.id,
        mode: "start",
        startAt: "now",
        channelIds: [],
        directChats: "own",
        waitSeconds: 4,
      });
      assert.equal(polled.error, undefined);
      assert.ok(Date.now() - started >= 3_000, "the call is still held until its deadline");
      const fallback = await received((event) => event.tags?.["talkto.code"] === "watch_fallback");
      assert.equal(fallback.level, "warning");
      assert.equal(fallback.tags["talkto.step"], "watch");
      assert.equal(fallback.tags["talkto.operation"], "TalkTo.getUpdates");
      assert.equal(fallback.tags["talkto.cf_remote"], "true");
      assert.doesNotMatch(JSON.stringify(fallback), /PRIVATE_/);
      // A reset while the call is held closes the watch; its last read goes to a new stub, since
      // the old one fails every call after a reset, and the call answers with a page.
      const failures = () =>
        events.filter((event) => event.tags?.["talkto.code"] === "internal_error").length;
      const before = failures();
      await x.raw(`/__telemetry/server-fault?server=${server.id}&step=reset`);
      const reset = await x.mcp(organization, "get_updates", {
        serverId: server.id,
        participantId: registered.item.id,
        mode: "start",
        startAt: "now",
        channelIds: [],
        directChats: "own",
        waitSeconds: 4,
      });
      assert.equal(reset.error, undefined, JSON.stringify(reset.error));
      assert.equal(failures(), before);
      await x.raw(`/__telemetry/server-fault?server=${server.id}&step=none`);
      assert.equal(events.filter((event) => event.type === "transaction").length, 0);
      assert.doesNotMatch(bodies.join("\n"), /PRIVATE_/);
    }
  });

test("an R2 size check that fails twice is tagged with R2's safe failure kind", async (t) => {
  const events = [];
  const bodies = [];
  const x = await start(t, {
    transfers: true,
    traceRate: 0,
    telemetry: async (request) => {
      const body = await request.text();
      bodies.push(body);
      const lines = body.trim().split("\n");
      for (let i = 1; i + 1 < lines.length; i += 2)
        if (JSON.parse(lines[i]).type === "event") events.push(JSON.parse(lines[i + 1]));
      return Response.json({});
    },
  });
  const account = await x.account();
  const credential = await x.mcpToken(account.organizationId);
  const server = await x.server(account.id);
  const call = (name, args, error = false) =>
    x.mcp(credential, name, { serverId: server.id, ...args }, error);
  const sender = await call("register_participant", {
    name: "sender",
    agentType: "claude-code",
    requestKey: randomUUID(),
  });
  const prepared = await call("prepare_transfer", {
    participantId: sender.data.item.id,
    requestKey: randomUUID(),
    name: "report.pdf",
    kind: "file",
    bytes: 16,
    sha256: "a".repeat(64),
  });
  const key = `r30/${server.id}/${prepared.data.transferId}/payload`;
  await x.control(`transfer-object?key=${encodeURIComponent(key)}&bytes=16`);
  await x.control(`transfer-head-faults?server=${server.id}&count=2`);
  const failed = await call(
    "complete_transfer",
    {
      participantId: sender.data.item.id,
      requestKey: randomUUID(),
      target: { kind: "conversation", conversationId: sender.data.generalConversationId },
      transferId: prepared.data.transferId,
      body: "The report.",
    },
    true,
  );
  assert.equal(failed.error.code, "files_unavailable");
  const deadline = Date.now() + 10_000;
  const reported = () =>
    events.find((event) => event.tags?.["talkto.request_id"] === failed.meta.requestId);
  while (reported() === undefined && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  const event = reported();
  assert.ok(event, "the failure is reported");
  assert.equal(event.tags["talkto.code"], "files_unavailable");
  assert.equal(event.tags["talkto.stage"], "files");
  assert.equal(event.tags["talkto.operation"], "size");
  assert.equal(event.tags["talkto.failure_kind"], "r2_10001");
  // R2's message, the object key and the server ID never leave the Worker.
  const sent = bodies.join("\n");
  assert.doesNotMatch(sent, /PRIVATE_R2_FAILURE|internal error\. \(10001\)/);
  assert.ok(!sent.includes(key) && !sent.includes(server.id));
});
