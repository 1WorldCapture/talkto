import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createServer as createVite } from "vite";
import * as Sentry from "@sentry/react";

for (const rate of [1, 0])
  test(`request isolation, retries and cancellation at trace rate ${rate}`, async (t) => {
    const vite = await createVite({
      server: { middlewareMode: true, hmr: false },
      appType: "custom",
    });
    t.after(() => vite.close());
    const { createServices } = await vite.ssrLoadModule("/src/session.tsx");
    const { request } = await vite.ssrLoadModule("/src/api.ts");
    const privacy = await vite.ssrLoadModule("/../../packages/telemetry/src/privacy.ts");
    const transactions = [];
    const events = [];
    Sentry.init({
      dsn: "https://test@sentry.test/1",
      environment: "test",
      tracesSampleRate: rate,
      defaultIntegrations: [],
      dataCollection: privacy.dataCollection,
      beforeSend: privacy.sanitizeError,
      beforeSendSpan: privacy.sanitizeSpan,
      beforeSendTransaction: privacy.sanitizeTransaction,
      transport: () => ({
        send: async (envelope) => {
          for (const [header, body] of envelope[1]) {
            if (header.type === "transaction") transactions.push(body);
            if (header.type === "event") events.push(body);
          }
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    });
    t.after(() => Sentry.close());
    const received = [];
    const held = Promise.withResolvers();
    const cancelStarted = Promise.withResolvers();
    const cancelClosed = Promise.withResolvers();
    const server = createServer((req, res) => {
      const mode = new URL(req.url, "http://localhost").searchParams.get("query");
      received.push({ mode, trace: req.headers["sentry-trace"] });
      const reject = () => {
        res.writeHead(503, { "content-type": "application/json" });
        res.end("PRIVATE_BODY");
      };
      if (mode === "slow") {
        held.resolve(reject);
        return;
      }
      if (mode === "cancel") {
        cancelStarted.resolve();
        res.on("close", () => cancelClosed.resolve());
        return;
      }
      reject();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const { api, queries } = createServices(`http://127.0.0.1:${server.address().port}`);
    t.after(() => queries.clear());
    const read = (mode, retry = false) =>
      queries.fetchQuery({
        queryKey: ["human", "PRIVATE_USER", "PRIVATE_ACCOUNT", "aggregate", "feed", mode],
        retry,
        retryDelay: 0,
        queryFn: ({ signal }) =>
          request(
            api.platform.activity({
              params: { accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
              query: { query: mode },
            }),
            signal,
          ),
      });
    const page = Sentry.startInactiveSpan({ name: "/app", op: "pageload", parentSpan: null });
    let slow;
    Sentry.withActiveSpan(page, () => {
      slow = assert.rejects(read("slow"));
    });
    const release = await held.promise;
    page.end();
    await assert.rejects(read("fast"));
    await Sentry.flush();
    assert.equal(events.length, 1, "the fast failure finishes before the held request");
    release();
    await slow;
    await Sentry.flush();
    const requests = () =>
      transactions.filter((entry) => entry.contexts.trace.op === "http.client");
    assert.equal(requests().length, 2 * rate, "request survives its page span ending");
    for (const [index, mode] of ["fast", "slow"].entries()) {
      const event = events[index];
      const sent = received.find((entry) => entry.mode === mode);
      assert.equal(
        sent.trace,
        `${event.contexts.trace.trace_id}-${event.contexts.trace.span_id}-${rate}`,
      );
      if (rate)
        assert.ok(
          requests().some((entry) => entry.contexts.trace.span_id === event.contexts.trace.span_id),
        );
    }
    await assert.rejects(read("retry", 2));
    await Sentry.flush();
    assert.equal(received.filter((entry) => entry.mode === "retry").length, 3);
    assert.equal(requests().length, 5 * rate, "each retry has a distinct span");
    assert.equal(events.length, 3, "only final retry failure alerts");
    const final = events.at(-1).contexts.trace;
    assert.equal(received.at(-1).trace, `${final.trace_id}-${final.span_id}-${rate}`);
    assert.equal(new Set(requests().map((entry) => entry.contexts.trace.span_id)).size, 5 * rate);
    const cancelled = assert.rejects(read("cancel"));
    await cancelStarted.promise;
    await queries.cancelQueries();
    await cancelled;
    await cancelClosed.promise;
    await Sentry.flush();
    assert.equal(requests().length, 6 * rate);
    if (rate) assert.equal(requests().at(-1).contexts.trace.status, "cancelled");
    assert.equal(events.length, 3, "cancellation never alerts");
    for (const span of requests())
      assert.equal(span.contexts.trace.data["http.request.method"], "GET");
    assert.doesNotMatch(JSON.stringify({ events, transactions }), /PRIVATE_|aaaaaaaa-aaaa/);
  });
