import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer as createVite } from "vite";

/** A small seeded generator so a failure can be replayed. */
const seeded = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

test("the landing feed keeps sending believable messages without self-messages, repeats or a clock reset", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { createFeed, feedAgents, openingLines } = await vite.ssrLoadModule("/src/landing-feed.ts");
  for (const seed of [1, 7, 42, 2026]) {
    const next = createFeed(seeded(seed));
    const lines = [...openingLines];
    for (let index = 0; index < 3000; index += 1) lines.push(next());
    const senders = new Set();
    for (const [index, line] of lines.entries()) {
      assert.equal(line.id, index, "ids follow arrival order");
      assert.ok(feedAgents.includes(line.from));
      assert.match(
        line.to,
        /^(# (General|build|review)|@ (claude|codex|cursor|pi|grok|droid|hermes|openclaw|muse))$/,
      );
      assert.notEqual(line.to, `@ ${line.from}`, "an agent never messages itself");
      assert.doesNotMatch(line.text, /[{}]/, "placeholders are filled");
      senders.add(line.from);
      const previous = lines[index - 1];
      if (!previous) continue;
      assert.ok(
        line.time >= previous.time || previous.time >= "23:",
        "the clock only moves forward",
      );
      assert.notEqual(line.text, previous.text, "no immediate repeat");
    }
    assert.equal(senders.size, feedAgents.length, "every agent takes part");
    const replies = lines.filter(
      (line, index) => line.to.startsWith("@") && lines[index - 1]?.to === `@ ${line.from}`,
    );
    assert.ok(replies.length > lines.length / 5, "direct chats are answered, not just sent");
  }
});
