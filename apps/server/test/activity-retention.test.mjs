import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

const day = 86_400_000;
const ago = (days) => new Date(Date.now() - days * day).toISOString();
const count = async (x, where = "1=1", ...bindings) =>
  (
    await x.db
      .prepare(`SELECT COUNT(*) AS n FROM activity_events WHERE ${where}`)
      .bind(...bindings)
      .first()
  ).n;
const traffic = async (x, server, n) => {
  const root = `/v1/servers/${server.id}`;
  const agent = (
    await x.call("user_alice", "POST", `${root}/participants`, {
      name: `agent-${randomUUID()}`,
      agentType: "Codex",
      requestKey: randomUUID(),
    })
  ).item;
  const general = (await x.call("user_alice", "GET", root)).generalConversationId;
  const messages = [];
  for (let i = 0; i < n; i++)
    messages.push(
      (
        await x.call("user_alice", "POST", `${root}/conversations/${general}/messages`, {
          participantId: agent.id,
          body: `retention sentinel ${i}`,
          requestKey: randomUUID(),
        })
      ).item,
    );
  return messages;
};
// A UUID per row, generated inside D1 so thousands of references insert in one statement.
const uuid = `lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))`;
const seedReferences = (x, account, server, rows, first, createdAt) =>
  x.db
    .prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i+1<?)
      INSERT INTO activity_events(account_id,server_id,message_id,sequence,created_at)
      SELECT ?,?,${uuid},?+i,? FROM n`,
    )
    .bind(rows, account.id, server.id, first, createdAt)
    .run();

test("activity retention prunes only references older than 30 days, in bounded batches, and the feed keeps working", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const busy = await x.server(account.id, { name: "Busy" });
  const recent = await x.server(account.id, { name: "Recent" });
  // An old backlog delivered first, so it has the lowest IDs, as on a long-running database.
  await seedReferences(x, account, busy, 2500, 100_000, ago(40));
  const busyMessages = await traffic(x, busy, 3);
  await x.control(`project?server=${busy.id}`);
  await traffic(x, recent, 2);
  await x.control(`project?server=${recent.id}`);
  const progress = await x.db
    .prepare("SELECT last_message_at FROM activity_progress WHERE server_id=?")
    .bind(busy.id)
    .first();
  assert.equal(progress.last_message_at, busyMessages.at(-1).createdAt);
  // Busy's real references fall outside the window; Recent's stay one day inside it.
  await x.db
    .prepare("UPDATE activity_events SET created_at=? WHERE server_id=? AND sequence<100000")
    .bind(ago(31), busy.id)
    .run();
  await x.db
    .prepare("UPDATE activity_events SET created_at=? WHERE server_id=?")
    .bind(ago(29), recent.id)
    .run();
  const path = `/v1/accounts/${account.id}/activity`;
  const before = await x.call("user_alice", "GET", `${path}?limit=2`);
  assert.deepEqual(
    before.items.map((item) => item.serverId),
    [recent.id, recent.id],
  );
  assert.ok(before.nextCursor, "older history continues into Busy before the prune");

  const first = await x.control("activity-prune", { rows: 1000, statements: 2 });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { deleted: 2000 });
  assert.equal(await count(x), 505);
  // The minute cron finishes the backlog with its default limits and stops once caught up.
  assert.equal((await x.scheduled()).outcome, "ok");
  assert.equal(await count(x), 2);
  assert.equal(await count(x, "server_id=?", recent.id), 2);
  assert.deepEqual(
    await (await x.control("activity-prune", { rows: 1000, statements: 5 })).json(),
    { deleted: 0 },
  );

  // A late-indexed reference with an old creation time sits behind newer deliveries; it is
  // still removed while the oldest window reaches it.
  await seedReferences(x, account, busy, 10, 200_000, ago(45));
  assert.equal(await count(x), 12);
  assert.deepEqual(
    await (await x.control("activity-prune", { rows: 1000, statements: 5 })).json(),
    { deleted: 10 },
  );

  // Readers: an older cursor into pruned references ends cleanly; the newest page and a live
  // cursor taken before the prune keep working; export progress still knows Busy's last message.
  const older = await x.call("user_alice", "GET", `${path}?cursor=${before.nextCursor}`);
  assert.deepEqual(older.items, []);
  assert.equal(older.nextCursor, null);
  const now = await x.call("user_alice", "GET", path);
  assert.equal(now.items.length, 2);
  assert.equal(now.nextCursor, null);
  const [late] = await traffic(x, busy, 1);
  await x.control(`project?server=${busy.id}`);
  const live = await x.call("user_alice", "GET", `${path}?cursor=${before.liveCursor}`);
  assert.deepEqual(
    live.items.map((item) => item.message.id),
    [late.id],
  );
  const home = await x.call("user_alice", "GET", `/v1/accounts/${account.id}/dashboard`);
  assert.equal(home.serverSelection, "all");
  assert.equal(home.servers.length, 2);
  assert.equal(home.feed.items[0].message.id, late.id);
  // Pruning never resets export progress, so nothing is exported again.
  const sequence = await x.db
    .prepare("SELECT sequence FROM activity_progress WHERE server_id=?")
    .bind(busy.id)
    .first();
  assert.equal(sequence.sequence, 4);
  assert.equal(await count(x, "server_id=?", busy.id), 1);
});

test("account search still asks a server whose references were all pruned before idle servers", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const servers = [];
  for (let i = 0; i < 21; i++)
    servers.push(await x.server(account.id, { name: `Server ${String(i).padStart(2, "0")}` }));
  // The last server by ID would be the one left out if it sorted with the idle servers.
  const active = servers.toSorted((a, b) => (a.id < b.id ? 1 : -1))[0];
  const root = `/v1/servers/${active.id}`;
  const agent = (
    await x.call("user_alice", "POST", `${root}/participants`, {
      name: "retained",
      agentType: "Codex",
      requestKey: randomUUID(),
    })
  ).item;
  const general = (await x.call("user_alice", "GET", root)).generalConversationId;
  const match = (
    await x.call("user_alice", "POST", `${root}/conversations/${general}/messages`, {
      participantId: agent.id,
      body: "needle after retention",
      requestKey: randomUUID(),
    })
  ).item;
  await x.control(`project?server=${active.id}`);
  await x.db.prepare("UPDATE activity_events SET created_at=?").bind(ago(31)).run();
  assert.deepEqual(
    await (await x.control("activity-prune", { rows: 1000, statements: 1 })).json(),
    { deleted: 1 },
  );
  const result = await x.call(
    "user_alice",
    "GET",
    `/v1/accounts/${account.id}/activity?query=needle`,
  );
  assert.deepEqual(result.search, {
    serverLimit: 20,
    searchedServers: 20,
    unavailableServers: 0,
    notSearchedServers: 1,
  });
  assert.deepEqual(
    result.items.map((item) => item.message.id),
    [match.id],
  );
});

test("a server database past a size threshold reports once per threshold per day", async (t) => {
  const events = [];
  const x = await start(t, {
    manualAlarms: true,
    telemetry: async (request) => {
      const lines = (await request.text()).trim().split("\n");
      for (let i = 1; i + 1 < lines.length; i += 2)
        if (JSON.parse(lines[i]).type === "event") events.push(JSON.parse(lines[i + 1]));
      return Response.json({});
    },
  });
  const storage = () => events.filter((event) => event.tags?.["talkto.code"] === "storage_size");
  const until = async (n) => {
    for (let i = 0; i < 100 && storage().length < n; i++) await delay(50);
    assert.equal(storage().length, n);
  };
  const account = await x.account();
  const server = await x.server(account.id);
  const size = (bytes) => x.control(`database-size?server=${server.id}`, { bytes });
  const flush = async (status = 200) => {
    const response = await x.control(`resources?server=${server.id}`, "flush");
    assert.equal(response.status, status, await response.clone().text());
  };
  await flush();
  await size(4_999_999_999);
  await flush();
  await size(6_000_000_000);
  await flush();
  await until(1);
  const [warning] = storage();
  assert.equal(warning.level, "warning");
  assert.equal(warning.tags["talkto.storage_threshold"], "5GB");
  assert.equal(warning.tags["talkto.storage_gb"], "6.0");
  assert.equal(warning.tags["talkto.operation"], "ServerStorage.size");
  assert.equal(warning.exception.values[0].type, "ServerStorageSize");
  assert.ok(!JSON.stringify(warning).includes(server.id), "no server ID reaches Sentry");
  // The same day's threshold is remembered in memory and, across a restart, in storage.
  await flush();
  await x.control(`resources?server=${server.id}`, "restart");
  await size(6_000_000_000);
  await flush();
  await size(9_000_000_000);
  await flush();
  await until(2);
  const error = storage()[1];
  assert.equal(error.level, "error");
  assert.equal(error.tags["talkto.storage_threshold"], "8GB");
  await flush();
  await delay(500);
  assert.deepEqual(
    storage().map((event) => event.tags["talkto.storage_threshold"]),
    ["5GB", "8GB"],
  );
});
