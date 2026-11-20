import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";
import { load } from "./sources.mjs";

const { StuckReaders, stuckPolls } = await load("../src/stuck-readers.ts");

const serverId = "11111111-1111-4111-8111-111111111111";
const participantId = "22222222-2222-4222-8222-222222222222";
const poll = (checkpoint, plugin) => {
  const input = { serverId, participantId, mode: "poll", checkpoint };
  if (plugin !== undefined) input.plugin = plugin;
  return input;
};
const page = (count) => ({
  data: { messages: Array.from({ length: count }, (_, index) => ({ id: `m-${index}` })) },
});

test("a reader asking one checkpoint again and again while messages wait is reported once", () => {
  const readers = new StuckReaders();
  for (let call = 1; call < stuckPolls; call += 1)
    assert.equal(readers.observe(poll("cp-1"), page(2)), null);
  assert.deepEqual(readers.observe(poll("cp-1", "claude-code/0.2.0"), page(2)), {
    serverId,
    participantId,
    plugin: "claude-code/0.2.0",
    polls: stuckPolls,
  });
  assert.equal(readers.observe(poll("cp-1"), page(2)), null, "once per checkpoint");
});

test("readers that move on, find nothing waiting, or start are never reported", () => {
  const readers = new StuckReaders();
  for (let call = 0; call < stuckPolls * 2; call += 1)
    assert.equal(readers.observe(poll(`cp-${call}`), page(1)), null, "a new checkpoint each time");
  for (let call = 0; call < stuckPolls * 2; call += 1)
    assert.equal(readers.observe(poll("cp-idle"), page(0)), null, "an empty page");
  const begin = { serverId, participantId, mode: "start", startAt: "now", directChats: "own" };
  for (let call = 0; call < stuckPolls * 2; call += 1)
    assert.equal(readers.observe(begin, page(3)), null, "start calls");
  for (let call = 1; call < stuckPolls; call += 1) readers.observe(poll("cp-x"), page(1));
  readers.observe(poll("cp-x"), page(0));
  assert.equal(readers.observe(poll("cp-x"), page(1)), null, "an empty page starts the count over");
  const failure = { error: { code: "storage_unavailable", message: "no" }, meta: {} };
  assert.equal(readers.observe(poll("cp-x"), failure), null, "a failure is not a page");
});

test("a stuck reader reaches Sentry as a warning without IDs", async (t) => {
  const events = [];
  const x = await start(t, {
    telemetry: async (request) => {
      const lines = (await request.text()).trim().split("\n");
      for (let i = 1; i + 1 < lines.length; i += 2)
        if (JSON.parse(lines[i]).type === "event") events.push(JSON.parse(lines[i + 1]));
      return Response.json({});
    },
  });
  const account = await x.account();
  const server = await x.server(account.id);
  const credential = await x.mcpToken(account.organizationId);
  const register = async (name) =>
    (
      await x.mcp(credential, "register_participant", {
        serverId: server.id,
        name,
        agentType: "claude-code",
        requestKey: randomUUID(),
      })
    ).data;
  const reader = await register("Reader");
  const sender = await register("Sender");
  const started = await x.mcp(credential, "get_updates", {
    serverId: server.id,
    participantId: reader.item.id,
    mode: "start",
    startAt: "now",
    channelIds: [reader.generalConversationId],
    directChats: "own",
  });
  await x.mcp(credential, "send_message", {
    serverId: server.id,
    participantId: sender.item.id,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: reader.generalConversationId },
    body: "a page the reader never takes",
  });
  const stuck = () => events.filter((event) => event.tags?.["talkto.code"] === "stuck_reader");
  for (let call = 0; call < stuckPolls + 2; call += 1) {
    const answer = await x.mcp(credential, "get_updates", {
      serverId: server.id,
      participantId: reader.item.id,
      mode: "poll",
      checkpoint: started.data.checkpoint,
      plugin: "claude-code/0.2.0",
    });
    assert.equal(answer.data.messages.length, 1);
  }
  for (let i = 0; i < 100 && stuck().length === 0; i++) await delay(50);
  await delay(200);
  assert.equal(stuck().length, 1);
  const [event] = stuck();
  assert.equal(event.level, "warning");
  assert.equal(event.exception.values[0].type, "StuckReader");
  assert.equal(event.tags["talkto.plugin"], "claude-code 0.2.0");
  assert.equal(event.tags["talkto.polls"], String(stuckPolls));
  const text = JSON.stringify(event);
  assert.ok(!text.includes(server.id) && !text.includes(reader.item.id), "no IDs reach Sentry");
});
