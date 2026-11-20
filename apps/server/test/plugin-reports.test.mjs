import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Effect } from "effect";
import { rpc } from "./mcp-wire.mjs";
import { start } from "./platform-harness.mjs";
import { load } from "./sources.mjs";

const P = await load("../../../packages/api/src/plugins.ts");
const Reports = await load("../src/plugin-reports.ts");

/** One server, Ana and Ben over Alice's MCP connection, and helpers for plugin reports. */
const setup = async (t) => {
  const x = await start(t);
  const account = await x.account();
  const server = await x.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const credential = await x.mcpToken(account.organizationId);
  const register = async (name) =>
    (
      await x.mcp(credential, "register_participant", {
        serverId: server.id,
        name,
        agentType: "codex",
        requestKey: randomUUID(),
      })
    ).data;
  const first = await register("Ana");
  const ana = first.item.id;
  const ben = (await register("Ben")).item.id;
  const general = first.generalConversationId;
  const scope = {
    serverId: server.id,
    participantId: ana,
    channelIds: [general],
    directChats: "own",
  };
  const updates = (extra = {}, error = false) =>
    x.mcp(
      credential,
      "get_updates",
      { ...scope, mode: "start", startAt: "now", limit: 5, ...extra },
      error,
    );
  const participant = (id = ana) => x.call("user_alice", "GET", `${root}/participants/${id}`);
  return { x, server, root, credential, ana, ben, general, scope, updates, participant };
};

test("get_updates records the plugin a call names and answers with its newest version", async (t) => {
  const s = await setup(t);
  const before = await s.updates();
  assert.equal(before.data.latestPluginVersion, undefined, "no plugin, no field");
  assert.equal((await s.participant()).plugin, undefined, "nothing recorded yet");

  const page = await s.updates({ plugin: "claude-code/0.1.0" });
  assert.equal(page.data.latestPluginVersion, P.latestPluginVersions["claude-code"]);
  const seen = (await s.participant()).plugin;
  assert.equal(seen.name, "claude-code");
  assert.equal(seen.version, "0.1.0");
  assert.match(seen.seenAt, /^\d{4}-\d{2}-\d{2}T/);

  // The same report again within a day is not written again.
  const poll = await s.x.mcp(s.credential, "get_updates", {
    serverId: s.server.id,
    participantId: s.ana,
    mode: "poll",
    checkpoint: page.data.checkpoint,
    plugin: "claude-code/0.1.0",
  });
  assert.equal(poll.data.latestPluginVersion, P.latestPluginVersions["claude-code"]);
  assert.deepEqual((await s.participant()).plugin, seen);

  // A new version replaces it at once; Ben, who reported nothing, has nothing.
  await s.updates({ plugin: "claude-code/0.3.0" });
  assert.equal((await s.participant()).plugin.version, "0.3.0");
  assert.equal((await s.participant(s.ben)).plugin, undefined);

  // The agent list the dashboard reads carries it too.
  const listed = await s.x.call("user_alice", "GET", `${s.root}/participants?limit=10`);
  assert.equal(listed.items.find((item) => item.id === s.ana).plugin.version, "0.3.0");
  assert.equal(
    listed.items.find((item) => item.id === s.ben).plugin,
    undefined,
    "agents without a report keep their exact shape",
  );
});

test("an unknown plugin is recorded without a newest version; a malformed one is refused", async (t) => {
  const s = await setup(t);
  const page = await s.updates({ plugin: "muse/1.2.3" });
  assert.equal(page.data.latestPluginVersion, undefined);
  assert.equal((await s.participant()).plugin.name, "muse");
  const refused = await s.updates({ plugin: "Claude Code 0.3" }, true);
  assert.equal(refused.error.code, "invalid_input");
});

test("a waiting get_updates that a message wakes still names the newest version", async (t) => {
  const s = await setup(t);
  const started = await s.updates();
  const waiting = s.x.mcp(s.credential, "get_updates", {
    serverId: s.server.id,
    participantId: s.ana,
    mode: "poll",
    checkpoint: started.data.checkpoint,
    waitSeconds: 10,
    plugin: "opencode/0.2.0",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.ben,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: s.general },
    body: "Wake up",
  });
  const page = await waiting;
  assert.equal(page.data.messages.length, 1);
  assert.equal(page.data.latestPluginVersion, P.latestPluginVersions.opencode);
});

test("a call that names a plugin may wait up to 50 seconds; any other is refused as before", async (t) => {
  const s = await setup(t);
  const started = await s.updates();
  const poll = (extra, error = false) =>
    s.x.mcp(
      s.credential,
      "get_updates",
      {
        serverId: s.server.id,
        participantId: s.ana,
        mode: "poll",
        checkpoint: started.data.checkpoint,
        ...extra,
      },
      error,
    );
  const refused = async (extra) => (await poll(extra, true)).error;

  // A longer wait without a plugin is refused in exactly the words it always was.
  for (const waitSeconds of [21, 50, 60, -1]) {
    const bare = await refused({ waitSeconds });
    assert.equal(bare.code, "invalid_input");
    assert.equal(
      bare.message,
      "Arguments do not match get_updates: waitSeconds must be a value between 0 and 20. See the tool's input schema or talkto://instructions.",
      `waitSeconds ${waitSeconds}`,
    );
  }
  // A call that names a plugin may ask for up to 50, and not more.
  const over = await refused({ waitSeconds: 51, plugin: "claude-code/0.3.4" });
  assert.equal(over.code, "invalid_input");
  assert.match(over.message, /waitSeconds must be a value between 0 and 50\./);

  // A plugin's 50-second wait is held, and a message ends it at once.
  const asked = Date.now();
  const waiting = poll({ waitSeconds: 50, plugin: "claude-code/0.3.4" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.ben,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: s.general },
    body: "Wake up",
  });
  const page = await waiting;
  assert.equal(page.data.messages.length, 1);
  assert.ok(Date.now() - asked < 20_000, "the message answered the wait, not its deadline");
  assert.equal(page.data.latestPluginVersion, P.latestPluginVersions["claude-code"]);

  // Every client still reads 20 as the longest wait: in get_updates' input and in every
  // get_updates next action that a tool's output schema describes.
  const listed = await (await s.x.raw("/mcp", rpc("tools/list", {}, s.credential))).json();
  const bounds = [
    ...JSON.stringify(listed.result.tools).matchAll(/"waitSeconds":\{[^{}]*"maximum":(\d+)/g),
  ].map((match) => Number(match[1]));
  assert.ok(bounds.length > 1);
  assert.deepEqual(new Set(bounds), new Set([20]));
});

test("a signal check's TalkTo-Plugin header is recorded and answered; a bad header is ignored", async (t) => {
  const s = await setup(t);
  const minted = await s.x.mcp(s.credential, "create_signal", s.scope);
  const check = async (headers = {}) => {
    const url = new URL(minted.data.url);
    const dot = url.pathname.lastIndexOf(".");
    const response = await s.x.raw(url.pathname.slice(0, dot), {
      headers: { authorization: `Bearer ${url.pathname.slice(dot + 1)}`, ...headers },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const old = await check();
  assert.equal(old.latestPluginVersion, undefined, "hooks before 0.3.0 send no header");
  assert.equal((await s.participant()).plugin, undefined);

  const counts = await check({ "TalkTo-Plugin": "hooks/0.2.0" });
  assert.equal(counts.latestPluginVersion, P.latestPluginVersions.hooks);
  assert.deepEqual(
    { name: (await s.participant()).plugin.name, version: (await s.participant()).plugin.version },
    { name: "hooks", version: "0.2.0" },
  );

  const odd = await check({ "TalkTo-Plugin": "not a plugin" });
  assert.equal(odd.pending, 0);
  assert.equal(odd.latestPluginVersion, undefined);
  assert.equal((await s.participant()).plugin.version, "0.2.0");
});

test("plugin versions compare by number, and only older reports get an update", () => {
  assert.ok(P.compareVersions("0.2.0", "0.10.0") < 0);
  assert.ok(P.compareVersions("1.0.0", "0.99.99") > 0);
  assert.equal(P.compareVersions("0.3.0", "0.3.0"), 0);
  assert.deepEqual(P.parseRelease("claude-code/0.3.0"), { name: "claude-code", version: "0.3.0" });
  assert.equal(P.parseRelease("claude-code 0.3.0"), null);
  assert.equal(
    P.updateFor({ name: "claude-code", version: "0.0.1" }),
    P.latestPluginVersions["claude-code"],
  );
  assert.equal(P.updateFor({ name: "claude-code", version: "99.0.0" }), null);
  assert.equal(P.updateFor({ name: "muse", version: "0.0.1" }), null);
  assert.equal(
    P.updatesLink("https://talkto.sh", "hermes"),
    "https://talkto.sh/docs/updates/#hermes-agent",
  );
});

test("a report is written on a change or once a day, never on every poll", () => {
  const writes = [];
  let stored = null;
  const tx = {
    pluginReport: () => Effect.succeed(stored),
    notePlugin: (participantId, report, at) =>
      Effect.sync(() => {
        writes.push(at);
        stored = { ...report, seenAt: at };
      }),
  };
  const note = (release, at) => Effect.runSync(Reports.note(tx, "ana", release, at));
  assert.equal(note(null, "2026-11-16T00:00:00.000Z"), null);
  assert.equal(note("hooks/0.2.0", "2026-11-16T00:00:00.000Z"), P.latestPluginVersions.hooks);
  note("hooks/0.2.0", "2026-11-16T12:00:00.000Z");
  assert.equal(writes.length, 1, "the same report within a day is not written");
  note("hooks/0.3.0", "2026-11-16T12:00:01.000Z");
  assert.equal(writes.length, 2, "a new version is written at once");
  note("hooks/0.3.0", "2026-11-17T12:00:01.000Z");
  assert.equal(writes.length, 3, "a day later the same report refreshes seenAt");
});

test("the server's newest plugin versions are the versions the plugin manifests ship", async () => {
  const Release = await import(new URL("../../../tools/plugin-release.mjs", import.meta.url).href);
  assert.deepEqual(Release.mismatches(), [], "run pnpm plugin:release (docs/plugin-release.md)");
  assert.deepEqual(Object.keys(Release.plugins).toSorted(), [...P.pluginNames].toSorted());
});

test("agents never receive another agent's plugin report, so older connections keep reading", async (t) => {
  const s = await setup(t);
  await s.updates({ plugin: "claude-code/0.3.2" });
  assert.equal((await s.participant()).plugin.version, "0.3.2", "the dashboard still sees it");

  const context = await s.x.mcp(s.credential, "get_context", {
    serverId: s.server.id,
    participant: { name: "Ben" },
  });
  const listed = context.data.participants.items.find((item) => item.id === s.ana);
  assert.equal(listed.name, "Ana");
  assert.equal("plugin" in listed, false, "get_context lists Ana without her plugin");

  await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.ana,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: s.general },
    body: "hello",
  });
  const history = await s.x.mcp(s.credential, "read_messages", {
    serverId: s.server.id,
    mode: "history",
    conversationId: s.general,
    position: { kind: "latest" },
    limit: 5,
  });
  const sender = history.included.participants.find((item) => item.id === s.ana);
  assert.equal("plugin" in sender, false, "included senders carry no plugin either");
});
