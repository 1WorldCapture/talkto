import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";
import * as Sentry from "@sentry/react";
// The app's own Effect: Vite leaves dependencies to Node, so src/api.ts imports this same module.
// Loading it through Vite instead transformed all of its 186 files for a second copy.
import { Effect } from "effect";

test("shared root policy classifies before sampling and preserves incoming decisions", async (t) => {
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { sample, classifyRequest } = await vite.ssrLoadModule(
    "/../../packages/telemetry/src/sampling.ts",
  );
  const context = {
    name: "root",
    inheritOrSampleWith: () => {
      throw new Error("Do not reselect parents");
    },
  };
  const billing = [
    "checkout",
    "checkout/cancel",
    "checkout/confirm",
    "renewal",
    "trial/convert",
    "portal",
  ];
  for (const path of billing) {
    const url = `https://talkto.test/v1/accounts/private/billing/${path}`;
    assert.equal(classifyRequest("POST", url), "billing");
    assert.equal(sample({ ...context, normalizedRequest: { method: "POST", url } }), 1);
    assert.equal(classifyRequest("GET", url), "routine");
    assert.equal(
      sample({
        ...context,
        normalizedRequest: { method: "POST", url },
        parentSampled: false,
        parentSampleRate: 1,
      }),
      0,
    );
  }
  for (const url of [
    "/mcp",
    "/v1/accounts/private/billing",
    "/webhooks/stripe",
    "/v1/accounts/private/billing/checkout/unknown",
  ])
    assert.equal(sample({ ...context, normalizedRequest: { method: "POST", url } }), 0.01);
  assert.equal(sample({ ...context, normalizedRequest: { url: "/health" } }), 0);
  for (const op of ["pageload", "navigation", "faas.cron", "function", "rpc"])
    assert.equal(sample({ ...context, attributes: { "sentry.op": op } }), 0.01);
  assert.equal(sample({ ...context, attributes: { "talkto.work": "billing" } }), 1);
  assert.equal(sample({ ...context, parentSampled: true, parentSampleRate: 0.01 }), 1);
});

test("browser billing classification reaches the installed SDK at request start", async (t) => {
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { sample } = await vite.ssrLoadModule("/../../packages/telemetry/src/sampling.ts");
  const { request } = await vite.ssrLoadModule("/src/api.ts");
  const decisions = [];
  const transactions = [];
  Sentry.init({
    dsn: "https://test@sentry.test/1",
    defaultIntegrations: [],
    tracesSampler: (context) => {
      const rate = sample(context);
      decisions.push({
        work: context.attributes?.["talkto.work"],
        rate,
        parentSampled: context.parentSampled,
      });
      return rate === 0.01 ? 0 : rate;
    },
    transport: () => ({
      send: async (envelope) => {
        transactions.push(...envelope[1].filter(([h]) => h.type === "transaction"));
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  t.after(() => Sentry.close());
  const originalPropagation = Sentry.getCurrentScope().getPropagationContext();
  const pagePropagation = {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    parentSpanId: "bbbbbbbbbbbbbbbb",
    sampled: false,
    sampleRand: 0.9,
    dsc: { trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sample_rate: "0.01", sampled: "false" },
  };
  Sentry.getCurrentScope().setPropagationContext(pagePropagation);
  t.after(() => Sentry.getCurrentScope().setPropagationContext(originalPropagation));
  const page = Sentry.startInactiveSpan({ name: "/app", op: "pageload", parentSpan: null });
  assert.equal(page.isRecording(), false);
  await Sentry.withActiveSpan(page, () => request(Effect.succeed("done"), undefined, "billing"));
  await Sentry.withActiveSpan(page, () => request(Effect.succeed("done"), undefined, "billing"));
  await request(Effect.succeed("done"));
  assert.deepEqual(Sentry.getCurrentScope().getPropagationContext(), pagePropagation);
  page.end();
  await Sentry.flush();
  assert.equal(decisions.find((entry) => entry.work === "billing").rate, 1);
  assert.equal(decisions.find((entry) => entry.work === "billing").parentSampled, undefined);
  assert.equal(decisions.find((entry) => entry.work === "routine").rate, 0.01);
  assert.equal(transactions.length, 2);
  assert.equal(new Set(transactions.map(([, event]) => event.contexts.trace.trace_id)).size, 2);
  assert.ok(
    transactions.every(([, event]) => event.contexts.trace.trace_id !== pagePropagation.traceId),
  );
});
