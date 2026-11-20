import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { concurrently, start } from "./platform-harness.mjs";

const location = (server) => `/v1/accounts/${server.accountId}/servers/${server.id}`;
const remove = (x, server, status = 200) =>
  x.call("user_alice", "POST", `${location(server)}/delete`, { confirmation: server.name }, status);
const register = async (x, account, server) => {
  const token = await x.mcpToken(account.organizationId);
  const result = await x.mcp(token, "register_participant", {
    serverId: server.id,
    name: "deletion-proof",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  const participantId = result.data.item.id;
  const conversationId = result.data.generalConversationId;
  return {
    participantId,
    conversationId,
    token,
    send: (body = "Deletion proof", error = false) =>
      x.mcp(
        token,
        "send_message",
        {
          serverId: server.id,
          participantId,
          target: { kind: "conversation", conversationId },
          body,
          requestKey: randomUUID(),
        },
        error,
      ),
  };
};
const control = async (x, path, body) => {
  const response = await x.control(path, body);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
const empty = async (x, server) => {
  const state = await control(x, `deletion?server=${server.id}`);
  assert.deepEqual(state.keys, []);
  assert.equal(state.alarm, null);
  assert.deepEqual(
    state.tables.filter((table) => table.name !== "_cf_KV"),
    [],
  );
};

test("deletion requires the creator, exact name, and matching account; erases content and preserves unrelated servers", async (t) => {
  const x = await start(t, { manualAlarms: true });
  const account = await x.account();
  const requestKey = randomUUID();
  const server = await x.server(account.id, { name: "Disposable", requestKey });
  const other = await x.server(account.id, { name: "Keep me" });
  const actor = await register(x, account, server);
  const survivor = await register(x, account, other);
  const original = await actor.send("uniquetermdelete");
  await survivor.send("uniquetermkeep");
  await control(x, `project?server=${server.id}`);
  await control(x, `project?server=${other.id}`);
  // Cross the reference deletion batch boundary with real immutable message rows.
  for (let seed = 0; seed < 2; seed++)
    await control(x, "activity-seed", {
      serverId: server.id,
      messages: Array.from({ length: 501 }, () => ({
        participantId: actor.participantId,
        conversationId: actor.conversationId,
        body: "uniquetermdelete",
        at: new Date().toISOString(),
      })),
    });
  for (let i = 0; i < 21; i++) await control(x, `project?server=${server.id}`);
  const reservation = {
    ...server,
    requestKey,
    organizationId: account.organizationId,
    generalId: actor.conversationId,
  };
  const grant = await x.db
    .prepare(
      "SELECT id,server_id AS serverId,user_id AS userId,membership_id AS membershipId,principal_key AS principalKey,created_at AS createdAt,revoked_at AS revokedAt,revision,applied_revision AS appliedRevision FROM server_access WHERE server_id=?",
    )
    .bind(server.id)
    .first();
  await control(x, "member", x.member(account.organizationId));
  await x.call("user_alice", "PUT", `/v1/servers/${server.id}/access/user_bob`);
  await x.call(
    "user_bob",
    "POST",
    `${location(server)}/delete`,
    { confirmation: server.name },
    404,
  );
  const wrong = await x.account();
  await x.call(
    "user_alice",
    "POST",
    `/v1/accounts/${wrong.id}/servers/${server.id}/delete`,
    { confirmation: server.name },
    404,
  );
  await x.call(
    "user_alice",
    "POST",
    `${location(server)}/delete`,
    { confirmation: "disposable" },
    400,
  );
  assert.equal((await x.call("user_alice", "GET", location(server))).name, server.name);
  assert.deepEqual(await remove(x, server), { serverId: server.id, status: "deleted" });
  await empty(x, server);
  for (const table of ["server_access", "activity_events", "activity_progress"])
    assert.equal(
      (
        await x.db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE server_id=?`)
          .bind(server.id)
          .first()
      ).n,
      0,
    );
  const search = (term) =>
    x.call("user_alice", "GET", `/v1/accounts/${account.id}/activity?query=${term}`);
  assert.deepEqual((await search("uniquetermdelete")).items, []);
  assert.deepEqual(
    (await search("uniquetermkeep")).items.map((item) => item.serverId),
    [other.id],
  );
  const tombstone = await x.db.prepare("SELECT * FROM servers WHERE id=?").bind(server.id).first();
  assert.equal(tombstone.name, "Deleted server");
  assert.ok(tombstone.deletion_completed_at);
  assert.equal(tombstone.request_key, requestKey);
  assert.deepEqual(
    (await x.call("user_alice", "GET", `/v1/accounts/${account.id}/servers`)).items.map(
      (item) => item.id,
    ),
    [other.id],
  );
  await x.call("user_alice", "GET", location(server), undefined, 404);
  assert.equal((await actor.send("Must not commit", true)).error.code, "server_unavailable");
  await survivor.send();
  // Lost delete acknowledgments, old create requests, access delivery and projection cannot recreate content.
  await remove(x, server);
  await x.call(
    "user_alice",
    "POST",
    `/v1/accounts/${account.id}/servers`,
    { name: server.name, requestKey },
    404,
  );
  await x.control(`meter/configure?server=${server.id}`, { restart: true });
  assert.deepEqual(await control(x, "provision", reservation), { ok: false });
  await control(x, `apply?server=${server.id}`, grant);
  await control(x, "publish", {
    batch: {
      serverId: server.id,
      items: [original.data.item],
      through: original.data.item.sequence,
      caughtUp: true,
      asOf: new Date().toISOString(),
    },
    after: 0,
  });
  // The test subclass writes a pass counter; invoke alarm via the base path only in dedicated tests.
  await empty(x, server);
  assert.equal(
    (
      await x.db
        .prepare("SELECT COUNT(*) AS n FROM activity_events WHERE server_id=?")
        .bind(server.id)
        .first()
    ).n,
    0,
  );
});

// 1,000 real metered sends, each a full CPU-bound round trip: under a release run's load (server
// and web suites together) they took 31 s on boat even eight at a time, and over 60 s on a machine
// losing 40% of its CPU to steal.
const thousandSends = { timeout: 300_000 };
test(
  "39,000 of 40,000 messages stays consumed after deleting and replacing a server",
  thousandSends,
  async (t) => {
    const x = await start(t, { metering: true, manualAlarms: true });
    const account = await x.account();
    const server = await x.server(account.id);
    const actor = await register(x, account, server);
    const quota = (action = "", body) => control(x, `quota${action}?account=${account.id}`, body);
    await quota("/publish", {
      accountId: account.id,
      start: new Date(Date.now() - 3600000).toISOString(),
      end: new Date(Date.now() + 3600000).toISOString(),
      allowance: 40000,
      overdraft: 0,
    });
    // Seed prior committed usage via the real quota protocol, then leave one actual message unreported locally.
    await quota("/history", { serverId: server.id, count: 38999 });
    await actor.send();
    assert.equal((await quota()).used, 38999);
    await remove(x, server);
    assert.equal((await quota()).used, 39000);
    assert.equal((await quota()).available, 1000);
    await empty(x, server);
    const replacement = await x.server(account.id);
    const agent = await register(x, account, replacement);
    assert.equal((await quota()).allowance, 40000);
    // 1,000 real sends, eight in flight: the server object still commits and meters each one.
    await concurrently(1000, 8, () => agent.send());
    await control(x, `meter/report?server=${replacement.id}`);
    assert.equal((await quota()).used, 40000);
    assert.equal((await agent.send("Over budget", true)).error.code, "message_allowance_exhausted");
    await remove(x, replacement);
    assert.equal((await quota()).used, 40000);
    assert.equal((await quota()).available, 0);
  },
);

test("quota failure preserves the journal and deletion fence; lost closure replies retry without refunding spent messages", async (t) => {
  const x = await start(t, { metering: true, manualAlarms: true });
  const account = await x.account();
  const server = await x.server(account.id);
  const actor = await register(x, account, server);
  const quota = (action = "", body) => control(x, `quota${action}?account=${account.id}`, body);
  await quota("/publish", {
    accountId: account.id,
    start: new Date(Date.now() - 3600000).toISOString(),
    end: new Date(Date.now() + 3600000).toISOString(),
    allowance: 3,
    overdraft: 0,
  });
  await actor.send();
  await quota("/configure", { down: true });
  await remove(x, server, 503);
  assert.equal((await actor.send("After fence", true)).error.code, "server_unavailable");
  assert.equal((await control(x, `meter?server=${server.id}`)).usage.length, 1);
  assert.equal((await quota()).usageUpperBound, 3);
  await x.control(`meter/configure?server=${server.id}`, { restart: true });
  assert.equal((await actor.send("After eviction", true)).error.code, "server_unavailable");
  await quota("/configure", { loseClose: true });
  await remove(x, server, 503);
  assert.equal((await quota()).used, 1);
  assert.equal((await control(x, `meter?server=${server.id}`)).usage.length, 1);
  await remove(x, server);
  await remove(x, server);
  await empty(x, server);
  assert.equal((await quota()).used, 1);
  assert.equal((await quota()).available, 2);
});

test("deletion drains active projection work and a failed directory cleanup resumes without recreating storage", async (t) => {
  const x = await start(t, { manualAlarms: true });
  const account = await x.account();
  const server = await x.server(account.id);
  const actor = await register(x, account, server);
  await actor.send();
  await control(x, `resources?server=${server.id}`, "pause");
  const projection = control(x, `project?server=${server.id}`);
  await control(x, `resources?server=${server.id}`, "reached");
  // An atomic D1 failure after the object is erased must leave a resumable intent.
  await x.db
    .prepare(
      "CREATE TRIGGER fail_deletion_cleanup BEFORE UPDATE OF deletion_completed_at ON servers BEGIN SELECT RAISE(ABORT,'test interruption'); END",
    )
    .run();
  const deletion = remove(x, server, 503);
  const deadline = Date.now() + 5000;
  let state;
  do {
    state = await control(x, `deletion?server=${server.id}`);
    if (state.keys.includes("deleting")) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  assert.ok(state.keys.includes("deleting"));
  assert.ok(
    state.tables.some((table) => table.name === "messages"),
    "wait for admitted work before clearing SQLite",
  );
  assert.equal((await actor.send("After deletion begins", true)).error.code, "server_unavailable");
  await control(x, `resources?server=${server.id}`, "release");
  await projection;
  await deletion;
  await empty(x, server);
  assert.equal(
    (
      await x.db
        .prepare("SELECT deletion_completed_at AS completed FROM servers WHERE id=?")
        .bind(server.id)
        .first()
    ).completed,
    null,
  );
  await x.db.prepare("DROP TRIGGER fail_deletion_cleanup").run();
  await control(x, "sync");
  assert.ok(
    (
      await x.db
        .prepare("SELECT deletion_completed_at AS completed FROM servers WHERE id=?")
        .bind(server.id)
        .first()
    ).completed,
  );
  await empty(x, server);
});
