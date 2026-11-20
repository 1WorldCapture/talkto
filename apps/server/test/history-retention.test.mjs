import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

const day = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

/** A server with two agents, a dormant channel and dated history seeded through real triggers. */
const setup = async (x, account, seeds) => {
  const server = await x.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const register = async (name) =>
    (
      await x.call("user_alice", "POST", `${root}/participants`, {
        name,
        agentType: "codex",
        requestKey: randomUUID(),
      })
    ).item;
  const alpha = await register("alpha");
  const beta = await register("beta");
  const general = (await x.call("user_alice", "GET", `${root}/channels`)).items[0];
  // A direct chat, so opening it writes no notice that would postdate the seeded history.
  const dormant = (
    await x.call("user_alice", "POST", `${root}/direct-chats`, {
      participantId: alpha.id,
      recipientId: beta.id,
    })
  ).item;
  const conversations = { general: general.id, dormant: dormant.id };
  const messages = seeds.map((seed) => ({
    participantId: seed.from === "beta" ? beta.id : alpha.id,
    conversationId: conversations[seed.in ?? "general"],
    at: iso(seed.at),
    body: seed.body,
  }));
  for (let i = 0; i < messages.length; i += 1000) {
    const seeded = await x.control("activity-seed", {
      serverId: server.id,
      messages: messages.slice(i, i + 1000),
    });
    assert.equal(seeded.status, 200, await seeded.text());
  }
  const send = (body) =>
    x.call("user_alice", "POST", `${root}/conversations/${general.id}/messages`, {
      participantId: beta.id,
      body,
      requestKey: randomUUID(),
    });
  return { server, root, alpha, beta, general, dormant, send };
};
const inspect = async (x, server) =>
  (await x.control(`history?server=${server.id}`, "inspect")).json();
const clock = (x, server, at) => x.control(`meter/configure?server=${server.id}`, { at: iso(at) });
const pass = async (x, server) => {
  const response = await x.control(`project?server=${server.id}`);
  assert.equal(response.status, 200, await response.text());
};
const plan = (x, account, name, from) =>
  x.control(`storage/plan?account=${account.id}`, {
    accountId: account.id,
    plan: name,
    start: iso(from),
    end: iso(from + 30 * day),
  });

test("Shop history: a grace period, then bounded batches delete what is older than 90 days, and readers stop cleanly", async (t) => {
  const x = await start(t, { manualAlarms: true });
  const now = Date.now();
  const account = await x.account();
  const old = Array.from({ length: 600 }, (_, i) => ({
    at: now - 200 * day + i * 1000,
    body: `ancient general ${i}`,
  }));
  const s = await setup(x, account, [
    ...old,
    { at: now - 100 * day, body: "ancient dormant first", in: "dormant" },
    { at: now - 100 * day + 1000, body: "ancient dormant last", in: "dormant" },
    ...[0, 1, 2].map((i) => ({ at: now - 10 * day + i, body: `recent ${i}` })),
  ]);
  const live = (await s.send("live after seeding")).item;
  const before = await inspect(x, s.server);
  assert.equal(before.messages.length, 606);
  const firstOld = before.messages[0];
  await plan(x, account, "shop", now - day);

  // The first sight of a window starts its grace: nothing is deleted yet.
  await pass(x, s.server);
  const pending = await inspect(x, s.server);
  assert.equal(pending.messages.length, 606);
  assert.equal(pending.state.applied.plan, null);
  assert.equal(pending.state.pending.plan, "shop");
  assert.equal(pending.retention.pruned_through_seq, null);

  // Thirty-one days later the window applies, two batches of 250 at a time.
  await clock(x, s.server, now + 31 * day);
  await pass(x, s.server);
  const first = await inspect(x, s.server);
  assert.equal(first.state.applied.plan, "shop");
  assert.equal(first.state.pending, null);
  assert.equal(first.messages.length, 106);
  assert.equal(first.retention.removed, 500);
  assert.equal(first.state.nextPruneAt, 0, "a backlog asks for the next pass");
  await pass(x, s.server);
  const done = await inspect(x, s.server);
  assert.deepEqual(
    done.messages.map((m) => m.body),
    ["ancient dormant last", "recent 0", "recent 1", "recent 2", "live after seeding"],
  );
  assert.equal(done.retention.removed, 601);
  assert.equal(done.retention.plan, "shop");
  assert.equal(done.retention.days, 90);
  assert.equal(done.retention.archived, 0);
  assert.ok(done.state.nextPruneAt > now + 31 * day, "a caught-up server waits an hour");
  // Search entries went with their rows; the dormant channel keeps its newest message.
  assert.deepEqual(
    done.search.map((row) => row.rowid),
    [done.messages[0].seq],
  );
  // Spaced out once caught up: another pass right away removes nothing and asks nothing.
  await pass(x, s.server);
  assert.equal((await inspect(x, s.server)).retention.removed, 601);
  // Retention is an additive extension: the recorded schema version is unchanged for rollback.
  assert.equal(
    (await (await x.control(`updates?server=${s.server.id}`, "inspect")).json()).version,
    11,
  );
  // Every other DELETE is still refused.
  const refused = await (await x.control(`history?server=${s.server.id}`, "delete")).json();
  assert.equal(refused.deleted, false);
  assert.match(refused.error, /message_immutable/);

  // Readers: the oldest page says where history begins, and nothing loops.
  const history = await x.call(
    "user_alice",
    "GET",
    `${s.root}/conversations/${s.general.id}/messages?limit=50`,
  );
  assert.deepEqual(
    history.items.map((m) => m.body),
    ["recent 0", "recent 1", "recent 2", "live after seeding"],
  );
  assert.equal(history.nextCursor, null);
  assert.equal(history.history.plan, "shop");
  assert.equal(history.history.days, 90);
  assert.equal(history.history.archived, false);
  assert.match(history.history.message, /90 days/);
  const paged = await x.call(
    "user_alice",
    "GET",
    `${s.root}/conversations/${s.general.id}/messages?limit=2`,
  );
  assert.ok(paged.nextCursor);
  assert.equal(paged.history, undefined, "only the page that reaches the start says so");
  const search = await x.call("user_alice", "GET", `${s.root}/messages/search?query=ancient`);
  assert.deepEqual(
    search.items.map((m) => m.body),
    ["ancient dormant last"],
  );
  assert.equal(search.history.plan, "shop");
  const missing = await x.call(
    "user_alice",
    "GET",
    `${s.root}/messages/${firstOld.id}/context`,
    undefined,
    404,
  );
  assert.match(missing.error.message, /90 days/);
  const context = await x.call("user_alice", "GET", `${s.root}/messages/${live.id}/context`);
  assert.equal(context.hasMoreBefore, false);
  assert.equal(context.history.plan, "shop");
  const feed = await x.call("user_alice", "GET", `${s.root}/messages?limit=50`);
  assert.equal(feed.nextCursor, null);
  assert.equal(feed.history.days, 90);
  const updates = await x.call("user_alice", "POST", `${s.root}/updates`, {
    participantId: s.alpha.id,
    mode: "start",
    channelIds: [s.general.id],
    directChats: "own",
    startAt: "beginning",
  });
  // The reader's own sends never come back to it; beta's message after the gap does.
  assert.deepEqual(
    updates.messages.map((m) => m.body),
    ["live after seeding"],
  );
  // Sending still works after a prune, and the agent's MCP read carries the same signal.
  await s.send("after the prune");
  const credential = await x.mcpToken(account.organizationId);
  const read = await x.mcp(credential, "read_messages", {
    serverId: s.server.id,
    mode: "history",
    conversationId: s.general.id,
    limit: 50,
  });
  assert.equal(read.data.history.plan, "shop");

  // An organization with no plan (the free trial, the card trial, nothing) keeps everything.
  const unplanned = await x.account();
  const kept = await setup(x, unplanned, [{ at: now - 400 * day, body: "ancient kept" }]);
  await kept.send("recent");
  await clock(x, kept.server, now + 400 * day);
  await pass(x, kept.server);
  await clock(x, kept.server, now + 800 * day);
  await pass(x, kept.server);
  const untouched = await inspect(x, kept.server);
  assert.equal(untouched.messages.length, 2);
  assert.equal(untouched.state.applied.plan, null);
  assert.equal(untouched.state.pending, null);
});

test("plan changes: an upgrade applies at once, a downgrade waits its grace period, Factory never deletes without an archive", async (t) => {
  const x = await start(t, { manualAlarms: true });
  const now = Date.now();
  const account = await x.account();
  const group = (offset, label) =>
    Array.from({ length: 10 }, (_, i) => ({ at: now - offset * day + i, body: `${label} ${i}` }));
  const s = await setup(x, account, [
    ...group(400, "year-old"),
    ...group(200, "half-year"),
    ...group(50, "recent"),
  ]);
  await s.send("today");
  await plan(x, account, "studio", now - day);
  await pass(x, s.server);
  await clock(x, s.server, now + 31 * day);
  await pass(x, s.server);
  const studio = await inspect(x, s.server);
  assert.equal(studio.state.applied.plan, "studio");
  assert.equal(studio.messages.length, 21, "only what is older than a year went");

  // Downgrade to Shop: Studio's window holds for the grace period.
  await plan(x, account, "shop", now + 30 * day);
  await clock(x, s.server, now + 31 * day + 2 * 3_600_000);
  await pass(x, s.server);
  const grace = await inspect(x, s.server);
  assert.equal(grace.state.applied.plan, "studio");
  assert.equal(grace.state.pending.plan, "shop");
  assert.equal(grace.messages.length, 21);
  await clock(x, s.server, now + 50 * day);
  await pass(x, s.server);
  assert.equal((await inspect(x, s.server)).messages.length, 21, "still inside the grace");
  await clock(x, s.server, now + 62 * day);
  await pass(x, s.server);
  const shop = await inspect(x, s.server);
  assert.equal(shop.state.applied.plan, "shop");
  assert.deepEqual(
    shop.messages.map((m) => m.body),
    ["today"],
  );

  // Upgrade to Factory: no grace. This deployment has no archive, so nothing more is deleted.
  await plan(x, account, "factory", now + 60 * day);
  await clock(x, s.server, now + 62 * day + 2 * 3_600_000);
  await pass(x, s.server);
  const factory = await inspect(x, s.server);
  assert.equal(factory.state.applied.plan, "factory");
  assert.equal(factory.state.pending, null);
  await s.send("kept forever");
  await clock(x, s.server, now + 900 * day);
  await pass(x, s.server);
  assert.equal((await inspect(x, s.server)).messages.length, 2);
});

test("Factory moves year-old history to the archive, where it stays readable; leaving Factory removes it after the grace", async (t) => {
  const x = await start(t, { manualAlarms: true, transfers: true });
  const now = Date.now();
  const account = await x.account();
  const s = await setup(x, account, [
    ...Array.from({ length: 300 }, (_, i) => ({
      at: now - 500 * day + i * 1000,
      body: `ancient ${i}`,
      from: i % 2 ? "beta" : "alpha",
    })),
    ...[0, 1, 2, 3, 4].map((i) => ({ at: now - 10 * day + i, body: `recent ${i}` })),
  ]);
  await s.send("today");
  await plan(x, account, "factory", now - day);
  await pass(x, s.server);
  assert.equal((await inspect(x, s.server)).messages.length, 306);
  await clock(x, s.server, now + 31 * day);
  await pass(x, s.server);
  const moved = await inspect(x, s.server);
  assert.equal(moved.messages.length, 6);
  assert.equal(moved.retention.archived, 1);
  const objects = async () =>
    (await (await x.control("transfer-objects")).json()).keys.filter((key) =>
      key.startsWith(`archive/${s.server.id}/`),
    );
  assert.equal((await objects()).length, 2, "one object per batch of 250");

  const history = await x.call(
    "user_alice",
    "GET",
    `${s.root}/conversations/${s.general.id}/messages?limit=50`,
  );
  assert.equal(history.history.plan, "factory");
  assert.equal(history.history.archived, true);
  assert.equal(history.history.days, 365);
  assert.match(history.history.message, /archive/);

  // The archive reads oldest first, in bounded pages across objects, with sender context.
  const archived = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const result = await x.call("user_alice", "GET", `${s.root}/archive?${query}`);
    archived.push(...result.items);
    cursor = result.nextCursor;
    if (cursor === null) break;
  }
  assert.equal(cursor, null);
  assert.deepEqual(
    archived.map((m) => m.body),
    Array.from({ length: 300 }, (_, i) => `ancient ${i}`),
  );
  await x.call("user_alice", "GET", `${s.root}/archive?cursor=bogus`, undefined, 400);

  // Leaving Factory: after the grace, the server keeps 90 days and the archive goes.
  await plan(x, account, "shop", now + 30 * day);
  await clock(x, s.server, now + 31 * day + 2 * 3_600_000);
  await pass(x, s.server);
  assert.equal((await objects()).length, 2, "the archive stays during the grace");
  await clock(x, s.server, now + 62 * day);
  await pass(x, s.server);
  assert.deepEqual(await objects(), []);
  const empty = await x.call("user_alice", "GET", `${s.root}/archive`);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.nextCursor, null);
});

/** Page back through General to the page that reaches the start of its stored history. */
const oldestPage = async (x, s) => {
  let query = "limit=50";
  for (let page = 0; page < 10; page++) {
    const result = await x.call(
      "user_alice",
      "GET",
      `${s.root}/conversations/${s.general.id}/messages?${query}`,
    );
    if (result.nextCursor === null) return result;
    query = `limit=50&position=${encodeURIComponent(JSON.stringify({ kind: "cursor", cursor: result.nextCursor }))}`;
  }
  throw new Error("History never reached its start");
};
/** 600 messages of 1,000 bytes each, 40 days old: inside every window, heavy for a small cap. */
const heavy = (now) =>
  Array.from({ length: 600 }, (_, i) => ({
    at: now - 40 * day + i * 1000,
    body: `heavy ${i} ${"x".repeat(990)}`,
  }));

test("past the storage cap, a server deletes its oldest messages before their window is up, in bounded batches", async (t) => {
  const x = await start(t, { manualAlarms: true, historyCaps: true });
  const now = Date.now();
  const account = await x.account();
  const s = await setup(x, account, [
    ...heavy(now),
    ...[0, 1, 2].map((i) => ({ at: now - day + i, body: `recent ${i}` })),
  ]);
  const before = await inspect(x, s.server);
  // Each message weighs its UTF-8 body plus 512 bytes, counted by triggers as it is written.
  assert.equal(
    before.size.bytes,
    before.messages.reduce((sum, m) => sum + Buffer.byteLength(m.body) + 512, 0),
  );
  await x.control(`quota/configure?account=${account.id}`, { historyCapBytes: 300_000 });
  await plan(x, account, "shop", now - day);
  // The grace period holds for the cap as for the window.
  await pass(x, s.server);
  assert.equal((await inspect(x, s.server)).messages.length, 603);
  await clock(x, s.server, now + 31 * day);
  await pass(x, s.server);
  const after = await inspect(x, s.server);
  // Two batches of 250, the oldest first, until the server is under 95% of its share.
  assert.equal(after.retention.removed, 500);
  assert.equal(after.messages.length, 103);
  assert.equal(after.messages[0].body.startsWith("heavy 500 "), true);
  assert.ok(after.size.bytes <= 285_000, String(after.size.bytes));
  assert.equal(after.size.capped, 1);
  assert.equal(after.retention.plan, "shop");
  // Readers learn why history ends before its 90 days.
  const oldest = await oldestPage(x, s);
  assert.match(
    oldest.history.message,
    /up to 2 GB of history per organization and 8 GB per server/,
  );
  assert.match(oldest.history.message, /before their 90 days were up/);
  // Under the cap, the next pass removes nothing.
  await clock(x, s.server, now + 32 * day);
  await pass(x, s.server);
  assert.equal((await inspect(x, s.server)).retention.removed, 500);
});

test("on Factory, history past the storage cap moves to the archive early instead", async (t) => {
  const x = await start(t, { manualAlarms: true, transfers: true, historyCaps: true });
  const now = Date.now();
  const account = await x.account();
  const s = await setup(x, account, heavy(now));
  await x.control(`quota/configure?account=${account.id}`, { historyCapBytes: 300_000 });
  await plan(x, account, "factory", now - day);
  await pass(x, s.server);
  await clock(x, s.server, now + 31 * day);
  await pass(x, s.server);
  const after = await inspect(x, s.server);
  assert.equal(after.retention.removed, 500);
  assert.equal(after.retention.archived, 1);
  const keys = (await (await x.control("transfer-objects")).json()).keys.filter((key) =>
    key.startsWith(`archive/${s.server.id}/`),
  );
  assert.equal(keys.length, 2);
  const archived = await x.call("user_alice", "GET", `${s.root}/archive?limit=10`);
  assert.equal(archived.items[0].body.startsWith("heavy 0 "), true);
  const oldest = await oldestPage(x, s);
  assert.match(oldest.history.message, /moved to the organization's history archive early/);
});
