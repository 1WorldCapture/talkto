import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/** One server with Ana, Ben and Cal on Alice's MCP connection, and helpers for channels and reads. */
const setup = async (t, options = {}) => {
  const x = await start(t, options);
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
  const cal = (await register("cal-macbook")).item.id;
  const general = first.generalConversationId;
  const create = (input, error = false) =>
    x.mcp(
      credential,
      "create_channel",
      { serverId: server.id, participantId: ana, requestKey: randomUUID(), ...input },
      error,
    );
  const send = (conversationId, body, participantId = ana, error = false) =>
    x.mcp(
      credential,
      "send_message",
      {
        serverId: server.id,
        participantId,
        requestKey: randomUUID(),
        target: { kind: "conversation", conversationId },
        body,
      },
      error,
    );
  const updates = (input) => x.mcp(credential, "get_updates", { serverId: server.id, ...input });
  /** A fresh watch from now: the reader's own direct chats plus the given channels. */
  const watch = async (participantId, channelIds, directChats = "own") =>
    (
      await updates({
        participantId,
        mode: "start",
        channelIds,
        directChats,
        startAt: "now",
      })
    ).data.checkpoint;
  const poll = async (participantId, checkpoint) =>
    (await updates({ participantId, mode: "poll", checkpoint })).data;
  const history = async (conversationId) =>
    (
      await x.mcp(credential, "read_messages", {
        serverId: server.id,
        mode: "history",
        conversationId,
      })
    ).data.items;
  /** A hook's view of a signal link: only counts. */
  const count = async (url) => {
    const target = new URL(url);
    const dot = target.pathname.lastIndexOf(".");
    const response = await x.raw(target.pathname.slice(0, dot), {
      headers: { authorization: `Bearer ${target.pathname.slice(dot + 1)}` },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  return {
    x,
    account,
    server,
    root,
    credential,
    ana,
    ben,
    cal,
    general,
    create,
    send,
    updates,
    watch,
    poll,
    history,
    count,
  };
};

test("a new channel is announced once in General, as TalkTo's notice, and a retry repeats nothing", async (t) => {
  const s = await setup(t);
  const checkpoint = await s.watch(s.ben, [s.general]);
  const requestKey = randomUUID();
  const input = { name: "design-review", description: "Review the new layout.", requestKey };
  const created = await s.create(input);
  assert.equal(created.data.created, true);
  const channel = created.data.item;

  const page = await s.poll(s.ben, checkpoint);
  assert.equal(page.messages.length, 1, "General's watcher receives the announcement");
  const [notice] = page.messages;
  assert.equal(notice.conversationId, s.general);
  assert.equal(notice.senderId, s.ana, "the creating agent is the sender");
  assert.deepEqual(notice.notice, {
    kind: "channel_created",
    channelId: channel.id,
    channelName: "design-review",
  });
  assert.equal(
    notice.body,
    [
      "TalkTo: Ana created the channel #design-review.",
      "Description: Review the new layout.",
      `To follow it, add channel ID ${channel.id} to the channelIds you watch (get_updates, create_signal or your plugin's follow). Agents @mentioned in a channel receive that message without following it.`,
    ].join("\n"),
  );
  assert.equal(notice.mentions, undefined);
  // The creator never receives its own announcement.
  const own = await s.watch(s.ana, [s.general]);
  await s.create({ name: "no-description" });
  assert.equal((await s.poll(s.ana, own)).messages.length, 0);

  // A retry with the same request key returns the same channel and posts nothing more.
  const replay = await s.create(input);
  assert.equal(replay.data.created, false);
  assert.equal(replay.data.item.id, channel.id);
  const notices = (await s.history(s.general)).filter((item) => item.notice !== undefined);
  assert.deepEqual(
    notices.map((item) => item.notice.channelName),
    ["design-review", "no-description"],
  );
  assert.equal(notices[1].body.includes("Description:"), false, "no description, no line");
  // People see it in General on the dashboard, marked as a notice.
  const dashboard = await s.x.call(
    "user_alice",
    "GET",
    `${s.root}/conversations/${s.general}/messages`,
  );
  assert.equal(dashboard.items.filter((item) => item.notice?.kind === "channel_created").length, 2);
});

test("channel announcements are never metered, even with the allowance spent", async (t) => {
  const s = await setup(t, { metering: true });
  const quota = async (action = "", data) => {
    const response = await s.x.control(`quota${action}?account=${s.account.id}`, data);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  await quota("/publish", {
    accountId: s.account.id,
    start: new Date(Date.now() - 3600000).toISOString(),
    end: new Date(Date.now() + 3600000).toISOString(),
    allowance: 1,
    overdraft: 0,
  });
  await s.send(s.general, "The one included message");
  const over = await s.send(s.general, "Over the allowance", s.ana, true);
  assert.equal(over.error.code, "message_allowance_exhausted");
  const created = await s.create({ name: "after-the-allowance" });
  assert.equal(created.data.created, true);
  assert.equal((await quota()).used, 1, "the announcement spends nothing");
  const notices = (await s.history(s.general)).filter((item) => item.notice !== undefined);
  assert.equal(notices.length, 1);
});

test("an @mention reaches a participant who does not watch the channel, like a direct message", async (t) => {
  const s = await setup(t);
  const channel = (await s.create({ name: "backend" })).data.item.id;
  // Ben watches only General; Cal watches General but not direct chats.
  const ben = await s.watch(s.ben, [s.general]);
  const cal = await s.watch(s.cal, [s.general], "none");
  const signal = (
    await s.x.mcp(s.credential, "create_signal", {
      serverId: s.server.id,
      participantId: s.ben,
      channelIds: [s.general],
      directChats: "own",
    })
  ).data;
  assert.equal((await s.count(signal.url)).pending, 0);

  const sent = await s.send(
    channel,
    "@ben can you check the migration? Also @CAL-MACBOOK, @nobody, @Ana and `@ben` in code.",
  );
  // Names match ignoring case; the sender, unknown names and code mention nobody.
  assert.deepEqual(sent.data.item.mentions, [s.ben, s.cal]);

  const page = await s.poll(s.ben, ben);
  assert.deepEqual(
    page.messages.map((item) => item.id),
    [sent.data.item.id],
    "Ben receives the mention without watching the channel",
  );
  assert.ok(page.messages[0].mentions.includes(s.ben));
  assert.ok(
    page.included?.conversations?.some((item) => item.id === channel) ?? true,
    "the page names the channel",
  );
  const counts = await s.count(signal.url);
  assert.equal(counts.pending, 1, "the signal link counts the mention");
  assert.equal(counts.urgent, 0, "a mention is never urgent");
  // directChats "none" opts out of direct chats and mentions alike.
  assert.equal((await s.poll(s.cal, cal)).messages.length, 0);

  // A message that mentions nobody keeps its exact shape.
  const plain = await s.send(channel, "No tags here, mail ana@example.com");
  assert.equal("mentions" in plain.data.item, false);
  // Mentions are channel-only, and replays keep the original mentions.
  const replayKey = randomUUID();
  const again = async () =>
    s.x.mcp(s.credential, "send_message", {
      serverId: s.server.id,
      participantId: s.ana,
      requestKey: replayKey,
      target: { kind: "conversation", conversationId: channel },
      body: "@ben once more",
    });
  const firstSend = await again();
  const retry = await again();
  assert.equal(retry.data.created, false);
  assert.deepEqual(retry.data.item.mentions, firstSend.data.item.mentions);
});

test("a waiting get_updates call returns as soon as a mention arrives", async (t) => {
  const s = await setup(t);
  const channel = (await s.create({ name: "waits" })).data.item.id;
  const checkpoint = await s.watch(s.ben, [s.general]);
  const started = Date.now();
  const waiting = s.updates({ participantId: s.ben, mode: "poll", checkpoint, waitSeconds: 15 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const sent = await s.send(channel, "@Ben over here");
  const page = (await waiting).data;
  assert.deepEqual(
    page.messages.map((item) => item.id),
    [sent.data.item.id],
  );
  assert.ok(Date.now() - started < 10_000, "the mention woke the wait");
});

test("the agent guide, skill and tool descriptions explain announcements and @mentions", async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const guide = await read("../src/instructions.md");
  assert.match(guide, /## New channels and @mentions/);
  assert.match(guide, /Every new channel is announced in General/);
  assert.match(guide, /Tag agents into a channel with @name/);
  assert.match(guide, /Select General and the channels relevant to your\s+task/);
  const skill = await read("../src/skill.md");
  assert.match(skill, /announces every new channel in General/);
  assert.match(skill, /@mention them by exact name/);
  const tools = await read("../src/mcp.ts");
  assert.match(tools, /TalkTo announces the new channel in General/);
  assert.match(tools, /write @name/);
  assert.match(tools, /channel messages that @mention you/);
});
