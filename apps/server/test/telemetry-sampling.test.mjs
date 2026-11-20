import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";
import { provider } from "./billing-provider.mjs";

test("Cloudflare samples billing roots before routing and inherits explicit incoming decisions", async (t) => {
  const events = [];
  const x = await start(t, {
    traceRate: 0,
    telemetry: async (request) => {
      const lines = (await request.text()).trim().split("\n");
      for (let i = 1; i + 1 < lines.length; i += 2)
        if (JSON.parse(lines[i]).type === "transaction") events.push(JSON.parse(lines[i + 1]));
      return Response.json({});
    },
  });
  const paths = [
    "checkout",
    "checkout/cancel",
    "checkout/confirm",
    "renewal",
    "trial/convert",
    "portal",
  ];
  for (const path of paths) {
    const url = `/v1/accounts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/billing/${path}`;
    const root = await x.raw(url, { method: "POST" });
    await root.text();
    assert.equal(root.headers.get("x-test-trace-sampled"), "true", path);
    const child = await x.raw(url, {
      method: "POST",
      headers: {
        "sentry-trace": "11111111111111111111111111111111-2222222222222222-0",
        baggage: "sentry-sample_rate=1,sentry-sampled=true",
      },
    });
    await child.text();
    assert.equal(
      child.headers.get("x-test-trace-sampled"),
      "false",
      "critical child cannot override unsampled parent",
    );
  }
  for (const path of ["/v1/me", "/mcp", "/health"]) {
    const response = await x.raw(path);
    await response.text();
    assert.equal(response.headers.get("x-test-trace-sampled"), "false");
  }
  const inherited = await x.raw("/v1/me", {
    headers: {
      "sentry-trace": "33333333333333333333333333333333-4444444444444444-1",
      baggage: "sentry-sample_rate=0.01",
    },
  });
  await inherited.text();
  assert.equal(inherited.headers.get("x-test-trace-sampled"), "true");
  assert.ok(
    events.every((event) => event.contexts.trace.trace_id !== "11111111111111111111111111111111"),
  );
  for (const sampled of [0, 1]) {
    const traceId = sampled
      ? "55555555555555555555555555555555"
      : "66666666666666666666666666666666";
    const result = await (
      await x.raw("/__telemetry/inheritance?server=telemetry-inheritance", {
        headers: { "sentry-trace": `${traceId}-7777777777777777-${sampled}` },
      })
    ).json();
    assert.deepEqual(result.server, { sampled: Boolean(sampled), traceId });
    assert.deepEqual(result.quota, { sampled: Boolean(sampled), traceId });
  }
});

test("headerless customer checkout retains application and database diagnostics at routine rate zero", async (t) => {
  const stripe = provider();
  const envelopes = [];
  const received = Promise.withResolvers();
  const x = await start(t, {
    metering: true,
    traceRate: 0,
    stripeHandler: stripe.handler,
    telemetry: async (request) => {
      const body = await request.text();
      envelopes.push(body);
      const lines = body.trim().split("\n");
      for (let i = 1; i + 1 < lines.length; i += 2) {
        const event = JSON.parse(lines[i + 1]);
        if (event.transaction === "/v1/accounts/:id/billing/checkout") received.resolve(event);
      }
      return Response.json({});
    },
  });
  const account = await x.account();
  const checkout = await x.call(
    "user_alice",
    "POST",
    `/v1/accounts/${account.id}/billing/checkout`,
    { plan: "shop", requestKey: "telemetry-checkout" },
  );
  assert.equal(checkout.status, "open");
  const event = await received.promise;
  assert.ok(event.spans.some((span) => span.description?.startsWith("Billing.")));
  assert.ok(event.spans.some((span) => span.op?.startsWith("db")));
  assert.doesNotMatch(envelopes.join("\n"), /rk_test_|user_alice@example|telemetry-checkout/);
});
