import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createServer as createVite } from "vite";
import * as Sentry from "@sentry/react";
import { QueryObserver } from "@tanstack/react-query";

test("real failed requests retain safe diagnostics through Query and Sentry", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { createServices } = await vite.ssrLoadModule("/src/session.tsx");
  const { request, ApiError } = await vite.ssrLoadModule("/src/api.ts");
  const privacy = await vite.ssrLoadModule("/../../packages/telemetry/src/privacy.ts");
  const events = [];
  const transactions = [];
  const received = [];
  Sentry.init({
    dsn: "https://test@sentry.test/1",
    environment: "test",
    tracesSampleRate: 1,
    defaultIntegrations: [],
    dataCollection: privacy.dataCollection,
    beforeSend: privacy.sanitizeError,
    beforeSendSpan: privacy.sanitizeSpan,
    beforeSendTransaction: privacy.sanitizeTransaction,
    transport: () => ({
      send: async (envelope) => {
        for (const [header, body] of envelope[1]) {
          if (header.type === "event") events.push(body);
          if (header.type === "transaction") transactions.push(body);
        }
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  t.after(() => Sentry.close());
  let mode = "status";
  const server = createServer((req, res) => {
    received.push({ mode, trace: req.headers["sentry-trace"] });
    if (mode === "transport") return req.socket.destroy();
    if (mode === "timeout") return;
    res.writeHead(mode === "status" ? 503 : 200, { "content-type": "application/json" });
    res.end(mode === "malformed" ? "PRIVATE_BROKEN_JSON" : '{"PRIVATE_BODY":"secret"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address?.port);
  const { api, queries } = createServices(`http://127.0.0.1:${address.port}`);
  t.after(() => queries.clear());
  const expected = [
    ["status", "StatusCodeError"],
    ["malformed", "SchemaError"],
    ["shape", "SchemaError"],
    ["transport", "TransportError"],
    ["timeout", "TimeoutError"],
  ];
  for (const [failureMode, kind] of expected) {
    mode = failureMode;
    await assert.rejects(
      queries.fetchQuery({
        queryKey: ["human", "PRIVATE_USER", "PRIVATE_WORKSPACE", "aggregate", "feed", failureMode],
        retry: false,
        queryFn: ({ signal }) =>
          request(
            api.platform.activity({
              params: { accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
              query: { query: "PRIVATE_SEARCH" },
            }),
            signal,
          ),
      }),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "connection_unavailable");
        assert.equal(error.diagnostic.kind, kind);
        if (failureMode === "status") {
          assert.equal(error.diagnostic.status, 503);
          assert.equal(error.diagnostic.route, "/v1/accounts/:id/activity");
          assert.equal(error.diagnostic.method, "GET");
        }
        if (failureMode === "transport") assert.equal(error.diagnostic.status, null);
        return true;
      },
    );
  }
  await Sentry.flush();
  assert.equal(events.length, 5);
  assert.deepEqual(
    events.map((e) => e.tags["talkto.failure_kind"]),
    expected.map(([, kind]) => kind),
  );
  assert.ok(events.every((e) => e.tags["talkto.query"] === "workspace.feed"));
  assert.equal(events[0].tags["talkto.http_status"], "503");
  assert.equal(events[0].tags["talkto.route"], "/v1/accounts/:id/activity");
  assert.equal(transactions.length, 5, "each failed request exports a span without a page span");
  for (let index = 0; index < expected.length; index++) {
    const event = events[index];
    const span = transactions.find(
      (entry) => entry.contexts.trace.span_id === event.contexts.trace.span_id,
    );
    assert.ok(span, "error belongs to its own request span");
    assert.equal(span.contexts.trace.trace_id, event.contexts.trace.trace_id);
    assert.equal(
      span.contexts.trace.status,
      expected[index][0] === "timeout" ? "deadline_exceeded" : "internal_error",
    );
    assert.equal(span.transaction, "/v1/accounts/:id/activity");
    assert.equal(
      received[index].trace,
      `${span.contexts.trace.trace_id}-${span.contexts.trace.span_id}-1`,
      "backend receives the same request trace and parent span",
    );
    assert.equal(event.tags["talkto.route"], "/v1/accounts/:id/activity");
  }
  assert.doesNotMatch(JSON.stringify(transactions), /PRIVATE_|aaaaaaaa-aaaa/);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|aaaaaaaa-aaaa/);
  const scrubbed = privacy.sanitizeError({
    tags: {
      "talkto.route": "https://PRIVATE_HOST/v1/accounts/PRIVATE_ID/activity?secret=PRIVATE_QUERY",
    },
  });
  assert.equal(scrubbed.tags["talkto.route"], "/v1/accounts/:id/activity");
});

test("route names keep this month's fixed segments and still mask every ID and secret", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const privacy = await vite.ssrLoadModule("/../../packages/telemetry/src/privacy.ts");
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  for (const [path, route] of [
    [`/v1/accounts/${id}/billing/checkout/confirm`, "/v1/accounts/:id/billing/checkout/confirm"],
    ["/webhooks/resend", "/webhooks/resend"],
    ["/webhooks/stripe-selfhost", "/webhooks/stripe-selfhost"],
    ["/email/unsubscribe?t=PRIVATE_TOKEN", "/email/unsubscribe"],
    ["/v1/me/email", "/v1/me/email"],
    ["/v1/me/deletion", "/v1/me/deletion"],
    [`/v1/signals/${id}/PRIVATE_SIGNAL.PRIVATE_SECRET`, "/v1/signals/:id/:id"],
  ])
    assert.equal(privacy.routeName(path), route);
  // Durable Object RPC names are fixed method names; anything else becomes the operation kind.
  for (const name of ["invokeAgent", "erase", "checkSignal", "reserveStorage", "alarm"]) {
    const event = privacy.sanitizeError({ transaction: name });
    assert.equal(event.transaction, name);
    const span = privacy.sanitizeSpan({
      op: "rpc",
      description: name,
      span_id: "1",
      trace_id: "1",
    });
    assert.equal(span.description, name);
  }
  assert.equal(privacy.sanitizeSpan({ op: "rpc", description: "PRIVATE_NAME" }).description, "rpc");
  // Tags outside the talkto namespace, or carrying free text, never leave.
  const event = privacy.sanitizeError({
    tags: {
      "talkto.failure_kind": "cpu_limit",
      "talkto.cf_version": id,
      "talkto.operation": "PRIVATE text with spaces? and punctuation!",
      server_id: id,
    },
  });
  assert.deepEqual(event.tags, { "talkto.failure_kind": "cpu_limit", "talkto.cf_version": id });
});

test("the polled free-start read retries a dropped connection before reporting, and never reports a cancel", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { createServices } = await vite.ssrLoadModule("/src/session.tsx");
  const { starterQuery } = await vite.ssrLoadModule("/src/dashboard-queries.ts");
  const { ApiError } = await vite.ssrLoadModule("/src/api.ts");
  const events = [];
  Sentry.init({
    dsn: "https://test@sentry.test/1",
    environment: "test",
    defaultIntegrations: [],
    transport: () => ({
      send: async (envelope) => {
        for (const [header, body] of envelope[1]) if (header.type === "event") events.push(body);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  t.after(() => Sentry.close());
  const body = JSON.stringify({
    data: { offer: null, status: "unavailable", grant: null, asOf: "2026-11-18T20:00:00.000Z" },
    meta: {
      requestId: "11111111-1111-4111-8111-111111111111",
      serverTime: "2026-11-18T20:00:00.000Z",
      instructions: { url: "https://talkto.test/instructions", text: "Instructions" },
    },
  });
  let drops = 0;
  let hang = false;
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (hang) return;
    if (drops > 0) {
      drops--;
      return req.socket.destroy();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address?.port);
  const { api, queries } = createServices(`http://127.0.0.1:${address.port}`);
  t.after(() => queries.clear());
  const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const options = starterQuery(api, "user_PRIVATE", accountId);

  // One dropped connection, as on a network change, is retried and answers without a report.
  drops = 1;
  const answer = await queries.fetchQuery(options);
  assert.equal(answer.data.status, "unavailable");
  assert.equal(hits, 2);
  await Sentry.flush();
  assert.equal(events.length, 0, "a recovered poll is not an error");

  // A read that stays unreachable is reported once, after its retries, under its own query name.
  queries.clear();
  hits = 0;
  drops = 3;
  await assert.rejects(queries.fetchQuery(options), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.diagnostic.kind, "TransportError");
    return true;
  });
  assert.equal(hits, 3);
  await Sentry.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].tags["talkto.route"], "/v1/accounts/:id/starter");
  assert.equal(events[0].tags["talkto.query"], "workspace.starter");

  // Leaving the page while the read is in flight cancels it without a report.
  queries.clear();
  hang = true;
  const observer = new QueryObserver(queries, options);
  const unsubscribe = observer.subscribe(() => undefined);
  while (hits < 4) await new Promise((resolve) => setTimeout(resolve, 10));
  unsubscribe();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await Sentry.flush();
  assert.equal(events.length, 1, "a canceled read is not reported");
});
