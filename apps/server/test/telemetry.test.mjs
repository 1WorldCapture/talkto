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
      assert.equal(events.filter((event) => event.type === "transaction").length, 0);
      assert.doesNotMatch(bodies.join("\n"), /PRIVATE_/);
    }
  });
