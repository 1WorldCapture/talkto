import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/*
  Watch mode (TALKTO_AGENT_OWNERSHIP=watch, hosted TalkTo's setting until November 26, 2026): an agent operation acting as
  another person's agent goes ahead, as before the November 20, 2026 refusal, and Sentry gets one
  warning per caller and agent in a few minutes, tagged with the operation and nothing private.
  Enforce mode is covered by agent-owner.test.mjs.
*/

test("watch mode lets another person's agent act and reports one private-free warning", async (t) => {
  const events = [];
  const bodies = [];
  const listeners = new Set();
  const received = (predicate) => {
    if (events.some(predicate)) return Promise.resolve(events.find(predicate));
    return new Promise((resolve) => {
      const listener = () => {
        const event = events.find(predicate);
        if (event) {
          listeners.delete(listener);
          resolve(event);
        }
      };
      listeners.add(listener);
    });
  };
  const x = await start(t, {
    agentOwnership: "watch",
    traceRate: 0,
    telemetry: async (request) => {
      const body = await request.text();
      bodies.push(body);
      const lines = body.trim().split("\n");
      for (let i = 1; i + 1 < lines.length; i += 2) {
        const header = JSON.parse(lines[i]);
        if (header.type === "event") events.push(JSON.parse(lines[i + 1]));
      }
      for (const listener of listeners) listener();
      return Response.json({});
    },
  });
  const account = await x.account();
  const server = await x.server(account.id, { name: "PRIVATE_SERVER_SENTINEL" });
  const alice = await x.mcpToken(account.organizationId);
  await x.control("member", x.member(account.organizationId, "user_bob"));
  await x.call("user_alice", "PUT", `/v1/servers/${server.id}/access/user_bob`);
  const bob = await x.mcpToken(account.organizationId, "user_bob");
  const call = (token, name, args, error = false) =>
    x.mcp(token, name, { serverId: server.id, ...args }, error);
  const register = async (name, token) =>
    (
      await call(token, "register_participant", {
        name,
        agentType: "codex",
        requestKey: randomUUID(),
      })
    ).data;
  const first = await register("PRIVATE_ANA", alice);
  const ana = first.item.id;
  const ben = (await register("PRIVATE_BEN", alice)).item.id;
  const dana = (await register("PRIVATE_DANA", bob)).item.id;
  const general = { kind: "conversation", conversationId: first.generalConversationId };
  const send = (token, participantId) =>
    call(token, "send_message", {
      participantId,
      requestKey: randomUUID(),
      target: general,
      body: "PRIVATE_BODY_SENTINEL",
    });
  const selection = { channelIds: [first.generalConversationId], directChats: "own" };
  const watched = () => events.filter((event) => event.tags?.["talkto.code"] === "agent_not_owned");

  // Each person's own agents report nothing.
  await send(alice, ana);
  await send(bob, dana);

  // Bob's connection acts as Alice's Ana: it goes ahead, shown as Ana, as before the refusal.
  const sent = await send(bob, ana);
  assert.equal(sent.error, undefined, JSON.stringify(sent.error));
  assert.equal(sent.data.item.senderId, ana);
  const warning = await received((event) => event.tags?.["talkto.code"] === "agent_not_owned");
  assert.equal(warning.level, "warning");
  assert.equal(warning.tags["talkto.operation"], "sendTo");
  assert.deepEqual(warning.fingerprint, ["talkto-agent-not-owned"]);
  assert.equal(warning.exception.values[0].type, "AgentNotOwned");

  // More from Bob as Ana in the same few minutes, in other operations, is not reported again.
  await send(bob, ana);
  const updates = await call(bob, "get_updates", {
    participantId: ana,
    mode: "start",
    startAt: "beginning",
    ...selection,
  });
  assert.equal(updates.error, undefined, JSON.stringify(updates.error));
  assert.ok(updates.data.messages.length > 0, JSON.stringify(updates.data));
  await call(bob, "create_signal", { participantId: ana, ...selection });
  // Bob acting as Ben is another pair, reported once under its own operation.
  await call(bob, "create_channel", {
    participantId: ben,
    name: "watched",
    requestKey: randomUUID(),
  });
  await received((event) => event.tags?.["talkto.operation"] === "createChannel");
  await delay(500);
  assert.deepEqual(
    watched()
      .map((event) => event.tags["talkto.operation"])
      .toSorted(),
    ["createChannel", "sendTo"],
  );

  // Tags name the operation only: no person, agent, server, message or email.
  for (const event of watched()) {
    const text = JSON.stringify(event);
    for (const secret of [ana, ben, dana, server.id, account.id, account.organizationId])
      assert.ok(!text.includes(secret), `the warning carries ${secret}`);
    assert.doesNotMatch(text, /PRIVATE_|user_alice|user_bob|example\.com/);
  }
  assert.doesNotMatch(bodies.join("\n"), /PRIVATE_/);
});
