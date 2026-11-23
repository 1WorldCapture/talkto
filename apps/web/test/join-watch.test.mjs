import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer as createVite } from "vite";

// Connecting Antigravity right after Claude Code showed "Joined as" the Claude Code agent: the
// dialog compared against the agents from when it opened, or from a cached list, and took any
// newcomer when none had Antigravity's type (reported November 2026).
test("a walkthrough only names an agent that joined after it started", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { arrival, settleBaseline, startBaseline } = await vite.ssrLoadModule("/src/join-watch.ts");
  const isAgent = (participant) => !participant.kind;
  const human = { id: "h", agentType: "human", kind: "human" };
  const claude = { id: "c", agentType: "claude-code" };
  const agy = { id: "a", agentType: "antigravity" };
  const other = { id: "o", agentType: "custom-tool" };
  const settled = (since, updatedAt, agents) =>
    settleBaseline(startBaseline(since), { updatedAt, ids: agents.map((agent) => agent.id) });

  // Claude Code's walkthrough sees Claude Code join.
  const first = settled(100, 150, [human]);
  assert.equal(arrival(first, [human, claude], "claude-code", isAgent), claude);

  // Antigravity's walkthrough starts after that: Claude Code is part of its baseline.
  const second = settled(200, 250, [human, claude]);
  assert.equal(arrival(second, [human, claude], "antigravity", isAgent), null);
  assert.equal(arrival(second, [human, claude, agy], "antigravity", isAgent), agy);
  // An agent that reports another type still counts once it is new since this walkthrough.
  assert.equal(arrival(second, [human, claude, other], "antigravity", isAgent), other);

  // A list fetched before the walkthrough started (a cached one) never becomes its baseline.
  const waiting = settleBaseline(startBaseline(300), { updatedAt: 250, ids: ["h"] });
  assert.equal(waiting.ids, null);
  assert.equal(arrival(waiting, [human, claude], "antigravity", isAgent), null);
  const fresh = settleBaseline(waiting, { updatedAt: 310, ids: ["h", "c"] });
  assert.deepEqual([...fresh.ids], ["h", "c"]);
  // Once settled, a later list does not move the baseline.
  assert.equal(settleBaseline(fresh, { updatedAt: 400, ids: ["h", "c", "a"] }), fresh);
  // People are never taken for the agent.
  assert.equal(arrival(settled(0, 1, []), [human], null, isAgent), null);
});
