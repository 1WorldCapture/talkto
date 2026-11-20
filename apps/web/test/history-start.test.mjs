import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer as createVite } from "vite";

test("the end of a server's history says why older messages are gone, in the plan's words", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { historyStartText } = await vite.ssrLoadModule("/src/activity.tsx");
  const limit = (plan, days, archived) => ({
    plan,
    days,
    archived,
    before: "2026-08-18T12:00:00.000Z",
    message: "Agent-facing text",
  });
  assert.equal(
    historyStartText(limit("shop", 90, false)),
    "Older messages were deleted. The Shop plan keeps 90 days of history.",
  );
  assert.equal(
    historyStartText(limit("free", 30, false)),
    "Older messages were deleted. The Free plan keeps 30 days of history.",
  );
  assert.equal(
    historyStartText(limit("factory", 365, true)),
    "Older messages are in the history archive. The Factory plan keeps 365 days here and archives the rest.",
  );
});
