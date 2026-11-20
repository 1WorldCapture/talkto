import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer as createVite } from "vite";
import { start } from "../../server/test/platform-harness.mjs";
import { brandMisspellings, testedClaim, words } from "./copy-rules.mjs";

/*
  First-run setup (onboarding.tsx): every way out finishes or dismisses the run before the server
  page opens, so /app never sends the person back to setup (entryTarget in app-routes.ts, which
  OrganizationEntry in dashboard.tsx follows). Run against the real Worker with the commands the screens send.
*/

async function load(t) {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  return {
    setup: await vite.ssrLoadModule("/src/onboarding.tsx"),
    routes: await vite.ssrLoadModule("/src/app-routes.ts"),
    starter: await vite.ssrLoadModule("/src/starter.tsx"),
    flow: await vite.ssrLoadModule("/src/agent-flow.tsx"),
    O: await vite.ssrLoadModule("/../../packages/api/src/onboarding.ts"),
  };
}

/** Sends the commands one after another, each with the revision the last one returned. */
const send = async (app, user, commands) => {
  let state = await app.call(user, "GET", "/v1/onboarding");
  for (const command of commands)
    state = await app.call(user, "POST", "/v1/onboarding", {
      command: { ...command, revision: state.revision },
    });
  return state;
};
const organizations = async (app, user) => app.call(user, "GET", "/v1/accounts?limit=20");
/** Whether /app sends someone with nothing shared to setup, from their state and organizations. */
const sendsToSetup = (routes, state, page) =>
  routes.entryTarget({
    accounts: page.items,
    more: page.nextCursor !== null,
    setup: state,
    shared: { servers: [], invitations: [] },
    billing: false,
  }).kind === "onboarding";

test("Skip setup creates the organization and server, dismisses, and lands on the server", async (t) => {
  const app = await start(t);
  const { setup, routes } = await load(t);
  const user = "user_skipper";
  // A first visit with no organization goes to setup.
  const before = await app.call(user, "GET", "/v1/onboarding");
  assert.equal(sendsToSetup(routes, before, await organizations(app, user)), true);
  const draft = {
    accountId: null,
    organizationName: "Sam’s organization",
    serverName: "Sam’s server",
  };
  assert.deepEqual(
    setup.skipSetupCommands(draft).map((command) => command.kind),
    ["configure", "provision", "dismiss"],
  );
  const after = await send(app, user, setup.skipSetupCommands(draft));
  assert.equal(after.run.setup.kind, "ready", "the server exists");
  assert.ok(after.dismissedAt, "setup is dismissed");
  const page = await organizations(app, user);
  assert.deepEqual(
    page.items.map((account) => account.name),
    ["Sam’s organization"],
  );
  assert.equal(
    sendsToSetup(routes, after, page),
    false,
    "/app no longer sends the person to setup",
  );
  // The server page, on its General channel.
  const progress = await app.call(user, "GET", `/v1/onboarding/progress?runId=${after.run.id}`);
  assert.equal(progress.server.server.name, "Sam’s server");
  const path = setup.serverPath(after.run.setup, progress.server.server.generalConversationId);
  assert.equal(
    path,
    `/app/accounts/${after.run.setup.accountId}/servers/${after.run.setup.serverId}?channel=${progress.server.server.generalConversationId}`,
  );
  assert.equal(
    setup.serverPath(after.run.setup, null),
    `/app/accounts/${after.run.setup.accountId}/servers/${after.run.setup.serverId}`,
  );
});

test("Skip for now, I’m done and Open server never bounce back to setup", async (t) => {
  const app = await start(t);
  const { setup, routes, flow, O } = await load(t);
  const draft = (name) => ({ accountId: null, organizationName: name, serverName: name });
  const join = async (user, state, slot, name, agentType) => {
    const guide = flow.findGuide(agentType);
    await send(app, user, [{ kind: "choose", slot, setup: guide.id, agentType }]);
    // The agent registers with the request key the pasted message gives it.
    const prompt = setup.slotPrompt({
      server: { id: state.run.setup.serverId, name: "Team" },
      mcpUrl: "https://talkto.test/mcp",
      runId: state.run.id,
      slot,
      guide,
    });
    const requestKey = prompt.match(/requestKey "([^"]+)"/)[1];
    assert.equal(requestKey, O.agentRequestKey(state.run.id, slot));
    await app.call(user, "POST", `/v1/servers/${state.run.setup.serverId}/participants`, {
      name,
      agentType,
      requestKey,
    });
  };
  for (const [user, agents] of [
    ["user_nobody", []],
    ["user_one", [["codex-macbook", "codex"]]],
    [
      "user_two",
      [
        ["codex-macbook", "codex"],
        ["web-claude", "claude-code"],
      ],
    ],
  ]) {
    const created = await send(app, user, setup.createCommands(draft(`${user} team`)));
    assert.equal(
      sendsToSetup(routes, created, await organizations(app, user)),
      true,
      "still setting up",
    );
    for (const [slot, [name, type]] of agents.entries())
      await join(user, created, slot, name, type);
    const progress = await app.call(user, "GET", `/v1/onboarding/progress?runId=${created.run.id}`);
    assert.deepEqual(
      O.progressAgents(progress.server)
        .filter((agent) => agent !== null)
        .map((agent) => setup.reportedTool(agent.agentType).name),
      agents.map(([, type]) => (type === "codex" ? "Codex" : "Claude Code")),
      "each agent shows the tool it reported",
    );
    const left = await send(app, user, setup.leaveCommands);
    assert.equal(left.run.step, "done");
    assert.equal(
      sendsToSetup(routes, left, await organizations(app, user)),
      false,
      `${user}: /app opens the dashboard after leaving`,
    );
    if (agents.length === 2) assert.ok(left.completedAt, "two agents complete setup");
    else assert.ok(left.dismissedAt, "fewer than two agents dismiss it");
  }
});

test("the free-start line shows only while creating the server would open it", async (t) => {
  const app = await start(t, { starter: true });
  const { starter } = await load(t);
  const line = starter.freeStartLine;
  const asOf = "2026-11-18T12:00:00.000Z";
  const state = (status, extra = {}) => ({
    offer: { messages: 500, servers: 1 },
    status,
    grant: null,
    asOf,
    ...extra,
  });
  assert.equal(line(state("eligible")), "Free to start: 500 messages, no card.");
  assert.equal(
    line(state("eligible", { offer: null, free: { messages: 2000, servers: 1, historyDays: 30 } })),
    "Free plan: 2,000 messages a month, no card.",
  );
  for (const status of [
    "unavailable",
    "verify_email",
    "sign_in_required",
    "used",
    "paused",
    "server_limit",
    "owner_only",
    "provisioning",
    "active",
    "exhausted",
    "converted",
  ])
    assert.equal(line(state(status)), null, `${status} says nothing`);
  assert.equal(line(state("eligible", { offer: null })), null, "switched off says nothing");
  assert.equal(line(undefined), null, "nothing before the answer arrives");
  // The real answers: a token from an agent's connection cannot claim, so it says nothing; the
  // person's own website session is eligible and sees the line.
  const token = await app.call("user_first", "GET", "/v1/starter");
  assert.equal(token.status, "sign_in_required");
  assert.equal(line(token), null);
  const flow = await app.browserLogin("user_first", "10m");
  const cookie = (await flow.callback()).headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
  const response = await app.raw("/v1/starter", {
    headers: { cookie, origin: "https://talkto.test" },
  });
  const fresh = (await response.json()).data;
  assert.equal(fresh.status, "eligible");
  assert.equal(line(fresh), "Free to start: 500 messages, no card.");
  // One quiet line, in TalkTo's words.
  const text = line(fresh);
  assert.doesNotMatch(text, /\btrial\b/i);
  assert.deepEqual([...words(text).matchAll(testedClaim)], []);
  assert.deepEqual([...words(text).matchAll(brandMisspellings)], []);
});

test("setup's chips put the popular agents first and the rest under More agents", async (t) => {
  const { setup, flow } = await load(t);
  const html = renderToStaticMarkup(
    createElement(setup.AgentChips, { chosen: null, busy: false, choose: () => {} }),
  );
  const names = [
    ...html.matchAll(/<button[^>]*class="fs-chip"[^>]*>[\s\S]*?<span>([^<]+)<\/span><\/button>/g),
  ].map((m) => m[1]);
  assert.deepEqual(names.slice(0, 8), [
    "Claude Code",
    "Codex",
    "Cursor",
    "OpenCode",
    "Pi",
    "ChatGPT",
    "Grok Bot",
    "Muse",
  ]);
  // Every common tool is a popular chip, and every other tool waits under More agents.
  const common = flow.commonGuides.map((guide) => guide.id).sort();
  assert.deepEqual([...setup.popularSetupAgents].sort(), common);
  assert.match(html, new RegExp(`More agents \\(${flow.moreGuides.length}\\)`));
  assert.equal(flow.moreGuides.length, 16);
  assert.equal(names.length, flow.commonGuides.length + flow.moreGuides.length);
  assert.match(html, /aria-label="More agents" hidden=""/, "the rest stay folded at first");
  // A tool picked from the rest opens them.
  const picked = renderToStaticMarkup(
    createElement(setup.AgentChips, { chosen: "amp", busy: false, choose: () => {} }),
  );
  assert.doesNotMatch(picked, /hidden=""/);
  assert.match(picked, /Fewer agents/);
});

test("a joined agent is named by the tool it reports", async (t) => {
  const { setup } = await load(t);
  const name = (type) => setup.reportedTool(type).name;
  assert.equal(name("codex"), "Codex");
  assert.equal(name("claude-code"), "Claude Code");
  assert.equal(name("Claude Code"), "Claude Code");
  assert.equal(name("github-copilot"), "VS Code");
  assert.equal(name("codex-desktop"), "Codex Desktop");
  assert.equal(name("windsurf"), "Windsurf");
  assert.equal(name("generic"), "Your agent");
  assert.equal(name("zed-agent"), "zed-agent");
});
