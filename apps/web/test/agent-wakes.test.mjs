import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createServer as createVite } from "vite";
import { start } from "../../server/test/platform-harness.mjs";

const fire = "https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire";

/** One server with two agents, wakes switched on, and a stand-in host that answers as told. */
const seeded = async (t) => {
  const host = { status: 200 };
  const app = await start(t, {
    manualAlarms: true,
    wakeKey: true,
    wakeTokens: true,
    wakeHandler: async () => new Response(null, { status: host.status }),
  });
  const account = await app.account();
  const credential = await app.mcpToken(account.organizationId);
  const server = await app.server(account.id);
  const register = async (name) =>
    (
      await app.mcp(credential, "register_participant", {
        serverId: server.id,
        name,
        agentType: "claude-code",
        requestKey: randomUUID(),
      })
    ).data;
  const agent = await register("routine-agent");
  const other = await register("reviewer");
  const read = async (url) =>
    (await app.raw(url, { headers: { authorization: `Bearer ${await app.token()}` } })).json();
  // The person adds the wake through the website, as the dashboard does.
  const flow = await app.browserLogin();
  const cookie = (await flow.callback()).headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
  const wakes = `/v1/servers/${server.id}/participants/${agent.item.id}/wakes`;
  const token = `sk-ant-oat01-${randomBytes(24).toString("base64url")}`;
  const add = async () => {
    const response = await app.raw(wakes, {
      method: "POST",
      headers: { cookie, origin: "https://talkto.test", "content-type": "application/json" },
      body: JSON.stringify({
        kind: "claude_routine",
        url: fire,
        token,
        channelIds: [agent.generalConversationId],
        directChats: "own",
      }),
    });
    assert.equal(response.status, 200, await response.clone().text());
  };
  const wake = async () => {
    await app.mcp(credential, "send_message", {
      serverId: server.id,
      participantId: other.item.id,
      requestKey: randomUUID(),
      target: { kind: "conversation", conversationId: agent.generalConversationId },
      body: "Ready for review",
    });
    await app.control(`wakes?server=${server.id}`, { action: "deliver" });
  };
  // The person's "Send a test" click, as the dashboard sends it.
  const testWake = async () => {
    const { data } = await read(wakes);
    const response = await app.raw(`${wakes}/${data.items[0].wakeId}/test`, {
      method: "POST",
      headers: { cookie, origin: "https://talkto.test" },
    });
    assert.equal(response.status, 200, await response.clone().text());
  };
  return {
    app,
    host,
    account,
    server,
    agent: agent.item,
    token,
    add,
    wake,
    testWake,
    list: () => read(wakes),
    channels: await read(`/v1/servers/${server.id}/channels?state=active&limit=100`),
    participants: await read(`/v1/servers/${server.id}/participants?limit=24`),
    me: await app.call("user_alice", "GET", "/v1/me"),
    context: await app.call("user_alice", "GET", `/v1/accounts/${account.id}`),
    managed: await app.call("user_alice", "GET", `/v1/accounts/${account.id}/servers/${server.id}`),
  };
};

const modules = async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  return {
    ...(await vite.ssrLoadModule("/src/session.tsx")),
    ...(await vite.ssrLoadModule("/src/agent-wakes.tsx")),
    ...(await vite.ssrLoadModule("/src/dashboard.tsx")),
    ...(await vite.ssrLoadModule("/src/api.ts")),
  };
};

/** Render the Auto-start dialog over a seeded cache; `overview` undefined leaves the read pending. */
const dialog = (t, ui, fixture, overview, failure) => {
  const services = ui.createServices("https://talkto.test");
  t.after(() => services.queries.clear());
  const user = fixture.me.user;
  const scope = ["human", user.id, fixture.account.id, fixture.server.id];
  const key = [...scope, "wakes", fixture.agent.id];
  if (overview) services.queries.setQueryData(key, overview);
  // A mounted dialog keeps showing its failed read; a first SSR render would otherwise refetch.
  if (failure) services.queries.setQueryDefaults(key, { retryOnMount: false });
  if (failure)
    services.queries.getQueryCache().build(services.queries, { queryKey: key }).setState({
      data: undefined,
      dataUpdatedAt: 0,
      error: failure,
      status: "error",
      fetchStatus: "idle",
    });
  services.queries.setQueryData([...scope, "channels", "active", "", "wake"], fixture.channels);
  return renderToStaticMarkup(
    createElement(
      ui.Services.Provider,
      { value: services },
      createElement(
        QueryClientProvider,
        { client: services.queries },
        createElement(
          ui.Human.Provider,
          { value: user },
          createElement(ui.WakesDialog, {
            accountId: fixture.account.id,
            serverId: fixture.server.id,
            agent: fixture.agent,
            close: () => {},
          }),
        ),
      ),
    ),
  );
};

test("each agent in the Agents tab has an Auto-start action", async (t) => {
  const fixture = await seeded(t);
  const ui = await modules(t);
  const services = ui.createServices("https://talkto.test");
  t.after(() => services.queries.clear());
  const user = fixture.me.user;
  const scope = ["human", user.id, fixture.account.id];
  services.queries.setQueryData(["session"], { data: fixture.me });
  services.queries.setQueryData([...scope, "account"], { data: fixture.context });
  services.queries.setQueryData([...scope, fixture.server.id, "management"], {
    data: fixture.managed,
  });
  services.queries.setQueryData(
    [...scope, fixture.server.id, "agents", "", undefined],
    fixture.participants,
  );
  const root = createRootRoute({ validateSearch: (input) => input });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/app/$",
    component: () => createElement(ui.Dashboard),
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({
      initialEntries: [
        `/app/accounts/${fixture.account.id}/servers/${fixture.server.id}?tab=agents`,
      ],
    }),
  });
  await router.load();
  const html = renderToStaticMarkup(
    createElement(
      ui.Services.Provider,
      { value: services },
      createElement(
        QueryClientProvider,
        { client: services.queries },
        createElement(
          ui.Human.Provider,
          { value: user },
          createElement(RouterProvider, { router }),
        ),
      ),
    ),
  );
  assert.ok(html.includes('aria-label="Auto-start for routine-agent"'));
  assert.ok(html.includes('aria-label="Auto-start for reviewer"'));
  assert.ok(!html.includes(">Wakes<"));
  assert.ok(html.includes("Wakes at most once a minute"), "each agent card shows its wake setting");

  // Beside each Auto-start, an info button says what it is and who needs it.
  const infos = [
    ...html.matchAll(/<button type="button"[^>]*aria-label="What is Auto-start\?"[^>]*>/g),
  ];
  assert.equal(infos.length, 2, "one info button per agent");
  for (const [button] of infos) {
    const described = button.match(/aria-describedby="([^"]+)"/)?.[1];
    assert.ok(described, "the button is described by the explanation");
    assert.match(button, /aria-expanded="false"/);
    const bubble = html.match(new RegExp(`<span[^>]*id="${described}"[^>]*>([^<]*)</span>`));
    assert.ok(bubble, "the explanation is in the page");
    assert.match(bubble[0], /role="tooltip"/);
    assert.match(bubble[0], /hidden=""/, "closed until hover, focus or a click");
    assert.equal(bubble[1], ui.autoStartExplanation);
  }
  for (const part of [
    "start this agent when a message arrives for it, even when it isn’t running",
    "Claude Code, Grok Bot or Town routine",
    "Agents with the TalkTo plugin (Claude Code, OpenCode, Pi, Hermes, OpenClaw)",
    "don’t need a routine",
    "Click Auto-start",
  ])
    assert.ok(ui.autoStartExplanation.includes(part), part);
  assert.ok(!/title="[^"]*Auto-start lets/.test(html), "not a title attribute alone");
});

test("the wake line wraps, so a narrow card never clips Auto-start", async () => {
  // Agent cards truncate their small lines; at laptop widths that hid Auto-start under Rename.
  const css = await readFile(new URL("../src/person-chat.css", import.meta.url), "utf8");
  const declarations = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `a "${selector}" rule`);
    return css.slice(start, css.indexOf("}", start));
  };
  const line = declarations(".ops-registry-agent .ops-agent-cadence");
  assert.match(line, /white-space: normal;/);
  assert.match(line, /overflow: visible;/);
  assert.match(
    declarations(".ops-registry-agent .ops-agent-cadence .ops-agent-wakes"),
    /white-space: nowrap;/,
  );
});

test("the dialog is two fields and Add, with help and channels behind disclosures", async (t) => {
  const fixture = await seeded(t);
  const ui = await modules(t);
  const loading = dialog(t, ui, fixture);
  assert.ok(loading.includes("Loading…"));
  assert.ok(!loading.includes('type="password"'), "no form before the list answers");

  const empty = dialog(t, ui, fixture, await fixture.list());
  assert.ok(empty.includes("Auto-start · routine-agent"));
  assert.ok(empty.includes("wake-dialog"), "the dialog reads in the dashboard sans");
  // The first sentence says what Auto-start is and who it's for.
  assert.ok(
    empty.includes(
      "Auto-start lets TalkTo start an agent that runs as a Claude Code, Grok Bot or Town routine when a message arrives, even when it isn’t running; agents with the TalkTo plugin get messages in their open session without one.",
    ),
  );
  // It says exactly what wakes the agent, and that other channel posts don't.
  assert.ok(
    empty.includes(
      "This agent’s direct messages and @mentions wake it; other channel posts don’t, except in channels chosen for every message.",
    ),
  );
  assert.equal(
    empty.match(/type="radio"/g)?.length,
    4,
    "the only choice is how often to wake; the URL names the service",
  );
  assert.ok(!empty.includes("wake-list"), "no list until there is a wake");
  assert.match(empty, /<input type="password" required="" maxLength="512" autoComplete="off"/);
  assert.match(empty, /<input type="url"[^>]*autoComplete="off"/);
  assert.ok(empty.includes("Routine URL"));
  assert.ok(empty.includes("Secret key"));
  assert.ok(empty.includes(">Add</button>"));
  // Help and channels are real disclosures, closed until asked for.
  assert.match(empty, /<details class="wake-more"><summary>Where do I find these\?<\/summary>/);
  assert.match(empty, /<details class="wake-more"><summary>Start for…<\/summary>/);
  assert.ok(!empty.includes("<details open"));
  assert.ok(empty.includes("claude.ai/code/routines"), "help says where the URL and key are");
  assert.ok(empty.includes("call get_updates"), "help says what the routine must be told");
  assert.match(empty, /<input type="checkbox" checked=""\/>Direct messages and @mentions/);
  assert.ok(empty.includes("Every message in these channels:"), "a ticked channel wakes for all");
  assert.ok(empty.includes("# General"), "channels come from the server");
  assert.ok(!empty.includes("Replaces"));
  // Standing notes the owner asked to drop.
  for (const gone of ["30 runs", "Stored encrypted", "counts and IDs", "checkpoint", "payload"])
    assert.ok(!empty.toLowerCase().includes(gone.toLowerCase()), gone);
  assert.ok(!/class="[^"]*mono/.test(empty));

  const off = await fixture.list();
  off.data.tokensEnabled = false;
  const disabled = dialog(t, ui, fixture, off);
  assert.ok(disabled.includes("Auto-start isn’t turned on for this TalkTo."));
  assert.ok(!disabled.includes('type="password"'), "no key field when the switch is off");

  const failed = dialog(
    t,
    ui,
    fixture,
    undefined,
    new ui.ApiError("storage_unavailable", "The server is temporarily unavailable."),
  );
  assert.ok(failed.includes("The server is temporarily unavailable."));
  assert.ok(failed.includes("Try again"));
});

test("a wake is one line: service, when, and Revoke; turned off says why", async (t) => {
  const fixture = await seeded(t);
  const ui = await modules(t);
  await fixture.add();
  const added = await fixture.list();
  const fresh = dialog(t, ui, fixture, added);
  assert.ok(fresh.includes("Claude Code routine"));
  assert.match(fresh, / · added [A-Z][a-z]{2} \d/);
  assert.ok(fresh.includes('aria-label="Revoke Claude Code routine"'));
  assert.ok(fresh.includes(">Revoke</button>"));
  assert.ok(!fresh.includes("api.anthropic.com"), "no host detail");
  assert.ok(!fresh.includes(fixture.token.slice(-4)), "no key hint");
  assert.ok(!fresh.includes(fixture.token.slice(13, 40)), "the key never reaches the page");
  assert.ok(!fresh.includes("Turned off"));
  assert.ok(!fresh.includes("Replaces"), "the note waits for a URL of the same service");

  await fixture.wake();
  const sent = dialog(t, ui, fixture, await fixture.list());
  assert.ok(sent.includes(" · last started "));
  assert.ok(!sent.includes("Turned off"));

  fixture.host.status = 401;
  await fixture.wake();
  const refused = dialog(t, ui, fixture, await fixture.list());
  assert.ok(
    refused.includes(
      "Turned off: The key was refused. Copy a new key from Claude Code and paste it again.",
    ),
  );
  assert.ok(!refused.includes("Send a test"), "a turned-off wake is added again, not tested");
  assert.ok(!refused.includes("HTTP"));
  assert.ok(!refused.includes(fixture.token.slice(13, 40)));
});

test("each routine row offers Send a test, and keeps its answer and any delivery problem in plain words", async (t) => {
  const fixture = await seeded(t);
  const ui = await modules(t);
  await fixture.add();
  const fresh = dialog(t, ui, fixture, await fixture.list());
  assert.ok(fresh.includes('aria-label="Send a test to the Claude Code routine"'));
  assert.ok(fresh.includes(">Send a test</button>"));
  assert.ok(!fresh.includes("Test sent") && !fresh.includes("Test failed"));

  // A refused key, in words that say what to do; the wake stays on.
  fixture.host.status = 401;
  await fixture.testWake();
  const refused = dialog(t, ui, fixture, await fixture.list());
  assert.ok(
    refused.includes(
      "Test failed: The key was refused. Copy a new key from Claude Code and paste it again.",
    ),
  );
  assert.ok(!refused.includes("Turned off"), "a test never turns the wake off");
  assert.ok(!refused.includes("within a minute or two"), "the hint follows only a started run");
  assert.ok(!refused.includes("HTTP") && !refused.includes("401"));

  // A new key is a new wake, tested at once; accepted, with what to check if nothing answers.
  fixture.host.status = 200;
  await fixture.add();
  await fixture.testWake();
  const accepted = dialog(t, ui, fixture, await fixture.list());
  assert.ok(accepted.includes("Test sent: Claude Code accepted it (started a run)."));
  assert.ok(
    accepted.includes(
      "If the routine doesn’t answer messages in TalkTo within a minute or two, open it in claude.ai/code/routines",
    ),
  );
  assert.ok(!accepted.includes("Test failed"));

  // Grok Bot's hint names the Auto-Review rule.
  const overview = await fixture.list();
  const grok = { ...overview.data.items[0], kind: "grok_bot", host: "api2.cursor.sh" };
  grok.lastTest = { ...grok.lastTest, message: "Test sent: Grok Bot accepted it (started a run)." };
  const bot = dialog(t, ui, fixture, { ...overview, data: { ...overview.data, items: [grok] } });
  assert.ok(bot.includes("Test sent: Grok Bot accepted it (started a run)."));
  assert.ok(
    bot.includes(
      "If Grok Bot doesn’t answer messages in TalkTo within a minute or two, check the Auto-Review rule (Settings → Permissions → Auto-Review).",
    ),
  );

  // A real wake that fails shows on the row too, naming the service.
  await fixture.add();
  fixture.host.status = 500;
  await fixture.wake();
  const failing = dialog(t, ui, fixture, await fixture.list());
  assert.ok(failing.includes("Claude Code had an error on its side."));
  assert.ok(!failing.includes("Turned off"));
});

test("how often to wake: four plain choices, the saved one checked, shown even with auto-start off", async (t) => {
  const fixture = await seeded(t);
  const ui = await modules(t);
  const standard = dialog(t, ui, fixture, await fixture.list());
  assert.ok(standard.includes("How often to wake routine-agent"));
  for (const label of [
    "Right away",
    "At most once a minute",
    "At most every 5 minutes",
    "At most every 15 minutes",
  ])
    assert.ok(standard.includes(label), label);
  assert.match(standard, /<input type="radio"[^>]*checked="" value="every_minute"/);
  assert.ok(standard.includes("Urgent direct messages always go straight through."));

  const set = await fixture.app.call(
    "user_alice",
    "PUT",
    `/v1/servers/${fixture.server.id}/participants/${fixture.agent.id}/wake-cadence`,
    { cadence: "every_15_minutes" },
  );
  assert.equal(set.intervalSeconds, 900);
  const slow = await fixture.list();
  assert.equal(slow.data.cadence, "every_15_minutes");
  slow.data.tokensEnabled = false;
  const off = dialog(t, ui, fixture, slow);
  assert.ok(off.includes("Auto-start isn’t turned on for this TalkTo."));
  assert.match(off, /<input type="radio"[^>]*checked="" value="every_15_minutes"/);
  assert.doesNotMatch(off, /checked="" value="every_minute"/);

  assert.equal(ui.cadencePhrase(), "Wakes at most once a minute");
  assert.equal(ui.cadencePhrase("right_away"), "Wakes right away");
  assert.equal(ui.cadencePhrase("every_5_minutes"), "Wakes at most every 5 minutes");
});
