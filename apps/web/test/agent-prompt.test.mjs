import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";

// The join prompt stays short: the MCP server's instructions carry the full procedure.
test("the join prompt names the server, the invitation key and the identity rule, briefly", async (t) => {
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { agentPrompt } = await vite.ssrLoadModule("/src/agent-prompt.ts");
  const server = { id: "3f6c1f4e-8a43-4b8e-9f52-1c2d3e4f5a6b", name: "Product studio" };
  const mcpUrl = "https://talkto.example/mcp";
  const requestKey = `onboarding:${server.id}:agent:0`;

  const invited = agentPrompt({
    server,
    mcpUrl,
    invitation: { requestKey, agentType: "claude-code" },
  });
  assert.ok(invited.includes('"Product studio"'));
  assert.ok(invited.includes(`serverId "${server.id}"`));
  assert.ok(invited.includes(`requestKey "${requestKey}"`));
  assert.ok(invited.includes('"claude-code"'), "the selected type is a hint for agentType");
  assert.ok(invited.includes(mcpUrl));
  assert.ok(invited.includes("https://talkto.example/instructions"));
  assert.match(invited, /Never use another task's participant/);
  // The agent saves the guide's note about TalkTo, and tells the person where.
  assert.match(invited, /save its short note about TalkTo/);
  // It sets up how new messages reach it from the guide, and says how, with no per-tool steps.
  assert.match(invited, /set up how new messages reach you, as it says for your tool/);
  assert.match(invited, /how new messages will reach you\./);
  // Names: unique to the project and machine, with examples, so two sessions never clash.
  assert.match(invited, /unique to this project and machine/);
  assert.match(invited, /billing-web-macbook/);
  assert.ok(invited.length < 1000, `short enough to read before pasting (${invited.length})`);
  // Protocol details belong to the server's instructions, not the pasted prompt.
  assert.doesNotMatch(invited, /create_watch|prepare_transfer|share_file|checkpoint/);

  const any = agentPrompt({ server, mcpUrl, invitation: { requestKey, agentType: null } });
  assert.ok(any.includes(`requestKey "${requestKey}"`));
  assert.ok(any.includes("your agentType (the app you run in)"));

  const plain = agentPrompt({ server, mcpUrl });
  assert.ok(plain.includes(`serverId "${server.id}"`));
  assert.doesNotMatch(plain, /onboarding:/, "no invitation key outside onboarding");
  assert.match(plain, /a new requestKey/);
  assert.match(plain, /reuse that participant/);
});

test("install prompts run only the guide's agent commands and leave sign-in to the person", async (t) => {
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { installPrompt } = await vite.ssrLoadModule("/src/agent-prompt.ts");
  const { agentGuides } = await vite.ssrLoadModule("/src/landing-parts.tsx");
  const doc = await vite.ssrLoadModule("@talkto/api/documentation");
  const claude = agentGuides.find((guide) => guide.id === "claude-code");
  const setup = claude.setup(doc.pluginDefaultMcpUrl);
  const commands = setup.steps.flatMap((step) => (step.by === "agent" ? step.lines : []));
  assert.deepEqual(commands, [
    "claude plugin marketplace add talkto-sh/talkto-plugin",
    "claude plugin install talkto-plugin@talkto",
  ]);
  const yours = setup.steps.filter((step) => step.by === "you").map((step) => step.text);
  const guides = await vite.ssrLoadModule("@talkto/api/agent-guides");
  const url = guides.installGuideUrl("https://talkto.sh", "claude-code");
  assert.equal(url, "https://talkto.sh/agents/claude-code.md");
  const prompt = installPrompt({ tool: claude.name, url, commands, yours });
  assert.ok(
    prompt.startsWith(`Install TalkTo in Claude Code for me: read ${url} and follow it.\n`),
    "the prompt leads with the install file",
  );
  for (const command of commands)
    assert.ok(prompt.includes(`\n${command}\n`) || prompt.includes(`\n${command}\n\n`));
  assert.match(prompt, /Don't sign in or join a TalkTo server yet/);
  assert.match(
    prompt,
    /- In Claude Code, run `\/reload-plugins`\. Then sign in: run `\/mcp`, select TalkTo, choose Authenticate and finish in the browser\./,
  );
  // Every agent step is a command to run; a guide whose agent cannot run commands has none.
  for (const guide of agentGuides)
    for (const step of guide.setup(doc.pluginDefaultMcpUrl).steps)
      if (step.by === "agent")
        assert.ok(step.lines?.length, `${guide.name}: an agent step has commands`);
});

// The join page's one prompt (join.tsx): install TalkTo when the agent has no TalkTo tools, wait
// for the person's sign-in, then join like the plain prompt. It holds no secret.
test("the invitation's join prompt installs TalkTo if needed, then joins under the agent's own name", async (t) => {
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { joinPrompt, agentPrompt } = await vite.ssrLoadModule("/src/agent-prompt.ts");
  const { promptTool } = await vite.ssrLoadModule("/src/join.tsx");
  const { findGuide } = await vite.ssrLoadModule("/src/agent-flow.tsx");
  const server = { id: "3f6c1f4e-8a43-4b8e-9f52-1c2d3e4f5a6b", name: "launch-room" };
  const mcpUrl = "https://talkto.sh/mcp";

  const claude = promptTool(findGuide("claude-code"), mcpUrl);
  assert.deepEqual(claude, {
    name: "Claude Code",
    installUrl: "https://talkto.sh/agents/claude-code.md",
    agentType: "claude-code",
  });
  const prompt = joinPrompt({ server, mcpUrl, tool: claude });
  assert.ok(prompt.startsWith('Join my TalkTo server "launch-room" (ID '));
  assert.match(
    prompt,
    /1\. If you don't have TalkTo's tools, install TalkTo in Claude Code: read https:\/\/talkto\.sh\/agents\/claude-code\.md and follow it\. Then ask me to sign in, and wait until I have\./,
  );
  // The install file says to wait for a message about joining; this prompt says it is that
  // message and to carry on with its own steps once the person has signed in.
  assert.match(
    prompt,
    /The guide says to wait for a message from me about joining a server; this is that message\. Once I have signed in, continue with step 2 below\./,
  );
  assert.doesNotMatch(prompt, /join prompt/);
  assert.ok(prompt.includes(`serverId "${server.id}"`));
  assert.match(prompt, /a new requestKey; keep the same values if you retry/);
  assert.match(prompt, /your agentType \("claude-code", or the app you actually run in\)/);
  assert.match(prompt, /unique to this project and machine/);
  assert.match(prompt, /Never use another task's participant/);
  assert.match(prompt, /Tell me the name you joined with/);
  assert.ok(prompt.includes("https://talkto.sh/instructions"));
  // No invitation, token or key from the page: the prompt can be pasted anywhere.
  assert.doesNotMatch(prompt, /sinv_|invitation_token|onboarding:|Bearer|sk_/);
  assert.ok(prompt.length < 1300, `short enough to read before pasting (${prompt.length})`);
  // Steps 2 to 5 are the plain prompt's, word for word.
  const plain = agentPrompt({ server, mcpUrl });
  const tail = (text) => text.slice(text.indexOf("\n2. "));
  assert.equal(
    tail(prompt),
    tail(plain).replace(
      "your agentType (the app you run in)",
      'your agentType ("claude-code", or the app you actually run in)',
    ),
  );

  // "Another tool" has no install file: it connects the MCP address, as the plain prompt says.
  assert.equal(promptTool(findGuide("mcp"), mcpUrl), null);
  const other = joinPrompt({ server, mcpUrl, tool: null });
  assert.match(other, /1\. If you don't have TalkTo's tools, connect https:\/\/talkto\.sh\/mcp\./);
  assert.match(other, /your agentType \(the app you run in\)/);
  assert.doesNotMatch(other, /agents\/.*\.md/);
});

// Setup's one message: install if needed, wait for the person's sign-in, then join with the slot's
// request key, so setup sees exactly this agent arrive.
test("setup's message installs from the tool's file, then joins with the slot's request key", async (t) => {
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { setupPrompt, agentPrompt } = await vite.ssrLoadModule("/src/agent-prompt.ts");
  const server = { id: "3f6c1f4e-8a43-4b8e-9f52-1c2d3e4f5a6b", name: "Alice’s server" };
  const mcpUrl = "https://talkto.example/mcp";
  const requestKey = `onboarding:a1b2c3d4-0000-4e5f-8a9b-1c2d3e4f5a6b:agent:1`;
  const installUrl = "https://talkto.example/agents/codex.md";
  const message = setupPrompt({
    server,
    mcpUrl,
    requestKey,
    tool: { name: "Codex", installUrl, agentType: "codex" },
  });
  assert.ok(message.startsWith(`Join my TalkTo server "Alice’s server" (ID ${server.id}).`));
  assert.ok(message.includes(`install TalkTo in Codex: read ${installUrl} and follow it`));
  assert.match(message, /ask me to sign in, and wait until I have/);
  // The install file says to wait for a join prompt; this message is that prompt.
  assert.ok(
    message.includes(
      "The guide says to wait for a message from me about joining a server; this is that message. Once I have signed in, continue with step 2 below.",
    ),
  );
  assert.ok(message.includes(`requestKey "${requestKey}"`));
  assert.ok(message.includes(`serverId "${server.id}"`));
  assert.ok(message.includes('"codex", or the app you actually run in'));
  assert.match(message, /Never use another task's participant/);
  assert.ok(message.includes("https://talkto.example/instructions"));
  assert.doesNotMatch(message, /reuse that participant|a new requestKey/);
  assert.ok(message.length < 1300, `short enough to read before pasting (${message.length})`);
  // The join steps are agentPrompt's, so both prompts ask for the same thing after connecting.
  const join = agentPrompt({ server, mcpUrl, invitation: { requestKey, agentType: "codex" } });
  assert.deepEqual(message.split("\n").slice(3), join.split("\n").slice(3));
  // Another tool connects the address itself.
  const other = setupPrompt({ server, mcpUrl, requestKey, tool: null });
  assert.ok(other.includes(`If you don't have TalkTo's tools, connect ${mcpUrl}.`));
  assert.ok(other.includes("your agentType (the app you run in)"));
  assert.ok(other.includes(`requestKey "${requestKey}"`));
});

// The joined screen claims only what TalkTo saw: the plugin the agent's sessions reported.
test("setup says an agent is listening only when TalkTo saw its plugin or hooks report", async (t) => {
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { listening } = await vite.ssrLoadModule("/src/onboarding.tsx");
  const agent = (plugin) => {
    const participant = {
      id: "agent",
      name: "billing-web-macbook",
      agentType: "codex",
      workingDirectory: null,
      joinedNote: null,
      createdAt: "2026-11-19T00:00:00.000Z",
      messageCount: 0,
      lastMessageAt: null,
    };
    if (plugin !== undefined)
      participant.plugin = { name: plugin, version: "0.4.0", seenAt: "2026-11-19T00:00:00.000Z" };
    return participant;
  };
  assert.equal(listening(agent("claude-code")), "idle");
  assert.equal(listening(agent("openclaw")), "idle");
  assert.equal(listening(agent("hooks")), "turns");
  assert.equal(listening(agent(undefined)), "unseen", "MCP alone reports nothing");
  assert.equal(listening(agent("someday-plugin")), "unseen", "never claims an unknown plugin");
});

// The hooks step's prompt (agent-flow.tsx, HooksOffer): the guide's own hook commands, what only
// the person does, and nothing secret. The hooks are public plugins: no address, key or token.
test("the hooks prompt carries each hooks agent's own commands and nothing secret", async (t) => {
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { hooksPrompt } = await vite.ssrLoadModule("/src/agent-prompt.ts");
  const guides = await vite.ssrLoadModule("@talkto/api/agent-guides");
  // A deployment of its own, so an address leaking into the prompt cannot hide behind talkto.sh.
  const mcpUrl = "https://hooks-check.example/mcp";
  const offered = guides.agentGuides.flatMap((guide) => {
    const hooks = guides.hooksOf(guide.setup(mcpUrl));
    return hooks === null ? [] : [{ guide, hooks }];
  });
  assert.deepEqual(
    offered.map(({ guide }) => guide.id).sort(),
    ["antigravity", "codex", "copilot", "cursor", "devin", "droid", "gemini", "grok"],
    "every tool whose guide offers the hooks",
  );
  const prompted = offered.filter(({ hooks }) => hooks.commands.length > 0);
  // Cursor and VS Code install them by clicks, so they have no prompt, only the manual steps.
  assert.deepEqual(prompted.map(({ guide }) => guide.id).sort(), [
    "antigravity",
    "codex",
    "devin",
    "droid",
    "gemini",
    "grok",
  ]);
  for (const { guide, hooks } of prompted) {
    const at = `${guide.id}: `;
    const prompt = hooksPrompt({
      tool: guide.name,
      commands: hooks.commands,
      otherwise: hooks.otherwise.map((step) => [step.text, ...(step.lines ?? [])].join("\n")),
      yours: hooks.yours.map((step) => step.text),
    });
    assert.ok(prompt.startsWith(`Install the TalkTo hooks in ${guide.name} for me.`), at);
    for (const line of hooks.commands) assert.ok(prompt.includes(`\n${line}\n`), `${at}${line}`);
    assert.ok(!prompt.includes("hooks-check.example"), `${at}no TalkTo address`);
    assert.doesNotMatch(prompt, /token|bearer|secret|password|sk-|whsec_|serverId|register_/i, at);
    // Every tool loads new hooks in a new session; the agent tells the person to start one.
    assert.match(prompt, /tell me what I have to do myself:\n(- .+\n)*- .*new session\.$/, at);
    assert.ok(prompt.length < 700, `${at}short (${prompt.length})`);
  }
  const codex = prompted.find(({ guide }) => guide.id === "codex");
  assert.equal(
    hooksPrompt({
      tool: "Codex",
      commands: codex.hooks.commands,
      otherwise: [],
      yours: codex.hooks.yours.map((step) => step.text),
    }),
    `Install the TalkTo hooks in Codex for me. They tell you when TalkTo messages are waiting, so you can answer without me asking.

Run these commands in your shell, in order:

codex plugin marketplace add talkto-sh/talkto-plugin
codex plugin add talkto-hooks@talkto

When you finish, tell me what I have to do myself:
- Trust the hooks in /hooks and start a new session.`,
  );
});
