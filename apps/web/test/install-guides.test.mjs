import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer as createVite } from "vite";

/*
  The install files the Worker serves at /agents/<id>.md come from the same recipes as the Connect
  agents dialog and onboarding. Each must explain TalkTo, give every command the recipe gives, say
  what the agent must not do, and hand the sign-in to the person.
*/
test("every install file carries its recipe's commands and leaves sign-in to the person", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const guides = await vite.ssrLoadModule("@talkto/api/agent-guides");
  const doc = await vite.ssrLoadModule("@talkto/api/documentation");
  for (const origin of ["https://talkto.sh", "https://talkto.example"]) {
    const mcpUrl = doc.mcpEndpoint(origin);
    for (const guide of guides.agentGuides) {
      const at = `${guide.name} (${origin}): `;
      const path = guides.installGuidePath(guide.id);
      assert.equal(path, `/agents/${guide.id}.md`);
      assert.equal(guides.installGuideId(path), guide.id);
      const text = guides.installGuide(path, origin);
      assert.ok(text?.startsWith(`# Install TalkTo in ${guide.name}\n`), `${at}title`);
      assert.match(text, /shared channels and direct chats/, `${at}says what TalkTo is`);
      assert.match(text, /## What gets installed/, `${at}says what gets installed`);
      assert.match(text, /Do not join a TalkTo server or call `register_participant` yet/);
      assert.match(text, /Do not sign in to TalkTo for the person/);
      assert.doesNotMatch(text, /YOUR-TALKTO-HOST|\{\{[A-Z_]+\}\}|undefined/, `${at}filled`);
      assert.ok(text.includes(`${origin}${guides.agentGuideUrl(guide.id)}`), `${at}links its page`);
      assert.ok(text.includes(doc.instructionsUrl(origin)), `${at}links the agent guide`);
      const setup = guide.setup(mcpUrl);
      for (const step of setup.steps) {
        assert.ok(text.includes(step.text), `${at}has "${step.text}"`);
        for (const line of step.lines ?? []) assert.ok(text.includes(line), `${at}gives ${line}`);
        if (step.address) assert.ok(text.includes(`\`${mcpUrl}\``), `${at}gives the address`);
      }
      const person = setup.steps.filter((step) => step.by === "you");
      if (guides.runsCommands(setup) && person.length > 0) {
        const handOver = text.slice(text.indexOf("## When you finish"));
        assert.match(handOver, /They are required/, `${at}the sign-in is required`);
        for (const step of person) assert.ok(handOver.includes(step.text), `${at}hands over`);
      }
      const { signIn } = guides.setupParts(setup);
      if (!guides.runsCommands(setup) && signIn.length > 0)
        assert.match(text, /## Sign in: only the person can do this/, `${at}own sign-in section`);
      const ways = guides.connectWays(guide, setup);
      if (ways !== null) {
        assert.match(text, /## Two ways to connect/, `${at}names its two ways`);
        for (const way of ways) assert.ok(text.includes(way.title), `${at}way ${way.title}`);
      }
      if (setup.wake !== undefined) {
        const wake = text.slice(text.indexOf("## Then make it answer on its own"));
        assert.ok(wake.length < text.length, `${at}has the optional wake`);
        for (const step of setup.wake.steps) assert.ok(wake.includes(step.text), `${at}wake step`);
      }
    }
  }
  assert.equal(guides.installGuide("/agents/nope.md", "https://talkto.sh"), null);
  assert.equal(guides.installGuide("/agents/claude.svg", "https://talkto.sh"), null);
  assert.equal(guides.installGuide("/agents/../claude-code.md", "https://talkto.sh"), null);
  const claude = guides.installGuide("/agents/claude-code.md", "https://talkto.sh");
  assert.ok(claude.includes("claude plugin marketplace add talkto-sh/talkto-plugin"));
  assert.ok(claude.includes("`/mcp`"), "Claude Code's hand-over names /mcp");
  // Auto-update is off for third-party marketplaces; only the person can turn it on.
  assert.match(
    claude.slice(claude.indexOf("## Then recommend")),
    /Run `\/plugin`, open the \*\*Marketplaces\*\* tab, select `talkto` and choose \*\*Enable auto-update\*\*/,
  );
  assert.ok(
    claude.includes("https://talkto.sh/agents/claude-code-routines.md"),
    "Claude Code's routine way links the routine install file",
  );
  // An app that adds TalkTo itself connects and waits: the walkthrough's join prompt follows, and an
  // agent that joined on its own here registered with a key the wizard never saw.
  for (const guide of guides.agentGuides.filter((item) => item.addsItself === true)) {
    const [first] = guide.setup("https://talkto.sh/mcp").steps;
    const [sentence] = first?.lines ?? [];
    assert.ok(
      sentence?.includes("Don't join a server yet"),
      `${guide.id} waits for the join prompt`,
    );
    assert.doesNotMatch(
      sentence,
      /join the server I choose/,
      `${guide.id} does not join by itself`,
    );
  }
  // Waking is optional and shows where the guide documents it: Grok Bot, Town, routines, ChatGPT.
  for (const id of ["grok-bot", "town", "claude-code-routines", "chatgpt"])
    assert.ok(guides.findAgentGuide(id).setup("https://talkto.sh/mcp").wake, `${id} can wake`);
});
