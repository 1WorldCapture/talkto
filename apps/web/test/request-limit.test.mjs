import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { createServer as createVite } from "vite";

// Creating an organization and a server can take 5–15 seconds, so onboarding gives that one step
// a longer limit than the usual 15 seconds (two people gave up at it on November 18, 2026).
test("a request waits as long as its own limit, and times out past it", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { request, ApiError } = await vite.ssrLoadModule("/src/api.ts");
  const slow = Effect.sleep("60 millis").pipe(Effect.as("made"));
  assert.equal(await request(slow, undefined, "routine", "2 seconds"), "made");
  const late = await request(slow, undefined, "routine", "10 millis").then(
    () => null,
    (error) => error,
  );
  assert.ok(late instanceof ApiError);
  assert.equal(late.code, "connection_unavailable");
  assert.equal(late.diagnostic?.kind, "TimeoutError");
});
