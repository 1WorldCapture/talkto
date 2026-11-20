import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";
import * as Sentry from "@sentry/react";

test("browser query and mutation failures reach Sentry once, with permission and cancellation excluded", async (t) => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: "custom" });
  t.after(() => vite.close());
  const privacy = await vite.ssrLoadModule("/../../packages/telemetry/src/privacy.ts");
  const { createServices } = await vite.ssrLoadModule("/src/session.tsx");
  const { ApiError } = await vite.ssrLoadModule("/src/api.ts");
  const events = [];
  Sentry.init({
    dsn: "https://test@sentry.test/1",
    environment: "test",
    tracesSampleRate: 0,
    defaultIntegrations: [],
    dataCollection: privacy.dataCollection,
    beforeSend: privacy.sanitizeError,
    transport: () => ({
      send: async (envelope) => {
        for (const [header, body] of envelope[1]) {
          if (header.type === "event") events.push(body);
        }
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  t.after(() => Sentry.close());
  const { queries } = createServices("http://localhost");
  t.after(() => queries.clear());
  let attempts = 0;
  await assert.rejects(
    queries.fetchQuery({
      queryKey: ["transient"],
      retry: 2,
      retryDelay: 0,
      queryFn: () => {
        attempts++;
        throw new ApiError("storage_unavailable", "PRIVATE_MESSAGE_SENTINEL", "request-123");
      },
    }),
  );
  await assert.rejects(
    queries.fetchQuery({
      queryKey: ["permission"],
      queryFn: () => {
        throw new ApiError("forbidden", "PRIVATE_NAME_SENTINEL");
      },
    }),
  );
  await assert.rejects(
    queries.fetchQuery({
      queryKey: ["cancelled"],
      retry: false,
      queryFn: () => {
        throw new DOMException("PRIVATE_QUERY_SENTINEL", "AbortError");
      },
    }),
  );
  const mutation = queries.getMutationCache().build(queries, {
    mutationFn: () => {
      throw new ApiError("connection_unavailable", "PRIVATE_BODY_SENTINEL");
    },
  });
  await assert.rejects(mutation.execute());
  const billing = queries.getMutationCache().build(queries, {
    mutationFn: () => {
      throw new ApiError("billing_unavailable", "PRIVATE_BILLING", "request-billing", {
        kind: "StatusCodeError",
        method: "POST",
        route: "/v1/accounts/PRIVATE_ACCOUNT/billing/renewal",
        status: 503,
      });
    },
  });
  await assert.rejects(billing.execute());
  await Sentry.flush();
  assert.equal(attempts, 3);
  assert.equal(events.length, 3);
  assert.equal(events[0].tags["talkto.request_id"], "request-123");
  assert.deepEqual(
    events.map((event) => event.tags["talkto.code"]),
    ["storage_unavailable", "connection_unavailable", "billing_unavailable"],
  );
  assert.equal(events[2].tags["talkto.route"], "/v1/accounts/:id/billing/renewal");
  assert.equal(events[2].tags["talkto.http_method"], "POST");
  assert.equal(events[2].tags["talkto.http_status"], "503");
  assert.ok(events.every((event) => event.exception.values[0].stacktrace.frames.length > 0));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);

  const { bootstrapFailure } = await vite.ssrLoadModule("/src/telemetry.ts");
  bootstrapFailure(new TypeError("PRIVATE_MODULE_URL"), "module_load");
  bootstrapFailure(new Error("PRIVATE_MOUNT_DETAILS"), "mount");
  await Sentry.flush();
  assert.equal(events.length, 5);
  assert.deepEqual(
    events.slice(3).map((event) => event.tags),
    [
      { "talkto.operation": "app.bootstrap", "talkto.stage": "module_load" },
      { "talkto.operation": "app.bootstrap", "talkto.stage": "mount" },
    ],
  );
  assert.equal(events[3].exception.values[0].type, "TypeError");
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
});
