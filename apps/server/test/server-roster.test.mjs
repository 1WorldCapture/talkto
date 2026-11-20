import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

test("server roster includes nine agents, ranks recent senders and reports bounded overflow", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const server = await app.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const get = (path) => app.call("user_alice", "GET", root + path);
  const add = async (name, agentType = "codex-desktop") =>
    (
      await app.call("user_alice", "POST", root + "/participants", {
        name,
        agentType,
        requestKey: randomUUID(),
      })
    ).item;
  assert.deepEqual((await get("/summary")).participants, []);
  const alphabetic = [];
  for (let i = 0; i < 7; i++) alphabetic.push(await add(`agent-${i}`));
  const overseer = await add("overseer", "claude-code");
  const zulu = await add("zulu");
  const general = (await get("/channels")).items[0];
  const now = Date.now();
  const seed = await app.control("activity-seed", {
    serverId: server.id,
    messages: [
      ...alphabetic.slice(0, 3).map((agent) => ({
        participantId: agent.id,
        conversationId: general.id,
        at: new Date(now - 3000).toISOString(),
        body: "Earlier activity",
      })),
      {
        participantId: zulu.id,
        conversationId: general.id,
        at: new Date(now - 2000).toISOString(),
        body: "Previous sender",
      },
      {
        participantId: overseer.id,
        conversationId: general.id,
        at: new Date(now - 1000).toISOString(),
        body: "Latest sender",
      },
    ],
  });
  assert.equal(seed.status, 200, await seed.text());
  const summary = await get("/summary");
  assert.equal(summary.server.participantCount, 9);
  assert.equal(summary.participants.length, 9);
  assert.deepEqual(
    summary.participants.map((agent) => agent.name),
    ["overseer", "zulu", ...alphabetic.map((agent) => agent.name)],
  );
  assert.equal(summary.participants[0].agentType, "claude-code");
  for (let i = 0; i < 6; i++) await add(`extra-${i}`);
  const bounded = await get("/summary");
  assert.equal(bounded.server.participantCount, 15);
  assert.equal(bounded.participants.length, 12);
  assert.equal(bounded.participants[0].id, overseer.id);
  const directory = await get("/participants?limit=100");
  assert.equal(directory.items.length, 15);
  assert.equal(directory.items[0].name, "agent-0", "directory cursors retain alphabetic order");
  await app.call("user_bob", "GET", root + "/summary", undefined, 404);
});
