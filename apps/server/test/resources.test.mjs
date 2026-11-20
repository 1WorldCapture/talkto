import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

const count = async (x, table) =>
  (await x.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
const create = (x, account, input, status = 200, user = "user_alice") =>
  x.call(user, "POST", `/v1/accounts/${account.id}/servers`, input, status);
const resource = async (x, server, action = "inspect", status = 200) => {
  const response = await x.control(`resources?server=${server.id}`, action);
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
};
const paid = async (x, account) => {
  await x.db.batch([
    x.db
      .prepare(
        "INSERT INTO workspace_billing(account_id,provider_scope) VALUES(?,'test') ON CONFLICT DO NOTHING",
      )
      .bind(account.id),
    x.db
      .prepare(
        "INSERT INTO billing_periods(account_id,subscription_id,invoice_id,line_id,plan,plan_version,start,end,allowance) VALUES(?,?,?,?,?,'test',?,?,40000)",
      )
      .bind(
        account.id,
        `sub_${account.id}`,
        `in_${account.id}`,
        `line_${account.id}`,
        "shop",
        new Date(Date.now() - 60000).toISOString(),
        new Date(Date.now() + 86400000).toISOString(),
      ),
  ]);
};
const setup = async (t, options = {}) => {
  const x = await start(t, { manualAlarms: true, ...options });
  const account = await x.account();
  const server = await x.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const agent = (
    await x.call("user_alice", "POST", `${root}/participants`, {
      name: "Resources",
      agentType: "codex-desktop",
      requestKey: "register",
    })
  ).item;
  const general = (await x.call("user_alice", "GET", root)).generalConversationId;
  const send = (requestKey = randomUUID(), status = 200) =>
    x.call(
      "user_alice",
      "POST",
      `${root}/conversations/${general}/messages`,
      {
        participantId: agent.id,
        requestKey,
        body: `Message ${requestKey}`,
      },
      status,
    );
  const publish = async () => {
    const response = await x.control(`quota/publish?account=${account.id}`, {
      accountId: account.id,
      start: new Date(Date.now() - 60000).toISOString(),
      end: new Date(Date.now() + 86400000).toISOString(),
      allowance: 10,
      overdraft: 0,
    });
    assert.equal(response.status, 200);
  };
  const quota = async () => (await x.control(`quota?account=${account.id}`)).json();
  const meter = async () => (await x.control(`meter?server=${server.id}`)).json();
  return { x, account, server, root, agent, general, send, publish, quota, meter };
};

test("unpaid resource admission stays atomic across owners' organizations with trials disabled", async (t) => {
  const x = await start(t, { unpaidServers: 1, manualAlarms: true, metering: true });
  const accounts = await Promise.all([x.account(), x.account()]);
  const credential = await x.token();
  const input = { name: "Reserved", requestKey: "one-server" };
  const responses = await Promise.all(
    accounts.map((account) =>
      x.raw(`/v1/accounts/${account.id}/servers`, {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    ),
  );
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 403]);
  assert.equal(await count(x, "servers"), 1);
  assert.equal(await count(x, "server_access"), 1);
  const index = responses.findIndex((response) => response.status === 200);
  const original = (await responses[index].json()).data;
  const replay = await create(x, accounts[index], input);
  assert.equal(replay.id, original.id);
  await create(x, accounts[index], { ...input, name: "Changed" }, 409);
  assert.equal((await resource(x, original)).alarm, null, "provisioning does not start empty work");
  assert.equal(await count(x, "activity_progress"), 0);
});

test("operator-granted organizations have unlimited messages and servers without weakening access or other budgets", async (t) => {
  const id = randomUUID();
  const x = await start(t, {
    unlimitedAccounts: [id],
    metering: true,
    unpaidServers: 1,
    serversPerHour: 1,
    unpaidServersPerDay: 1,
    manualAlarms: true,
  });
  const original = await x.account();
  // Model an existing organization whose ID was verified before an operator configured the grant.
  await x.db.prepare("UPDATE accounts SET id=? WHERE id=?").bind(id, original.id).run();
  const account = await x.call("user_alice", "GET", `/v1/accounts/${id}`);
  const server = await x.server(id);
  await x.server(id);
  await x.server(id);
  await create(x, account, { name: "Denied", requestKey: "denied" }, 404, "user_bob");
  const root = `/v1/servers/${server.id}`;
  const participant = (
    await x.call("user_alice", "POST", `${root}/participants`, {
      name: "Owner",
      agentType: "codex-desktop",
      requestKey: "agent",
    })
  ).item;
  const general = (await x.call("user_alice", "GET", root)).generalConversationId;
  const input = {
    participantId: participant.id,
    requestKey: "unlimited",
    body: "No payment needed.",
  };
  await x.call("user_alice", "POST", `${root}/conversations/${general}/messages`, input);
  await x.call("user_bob", "POST", `${root}/conversations/${general}/messages`, input, 404);
  assert.equal(
    (await x.call("user_alice", "GET", `/v1/accounts/${id}/billing`, undefined, 503)).error.code,
    "billing_unavailable",
  );
  assert.equal((await resource(x, server)).messages, 1);
  assert.equal(await count(x, "billing_periods"), 0);
  assert.equal(await count(x, "billing_trials"), 0);

  // The same owner receives no exemption in a different organization, and its budget is unspent.
  const other = await x.account();
  const limited = await x.server(other.id);
  await create(x, other, { name: "Capped", requestKey: "capped" }, 403);
  const limitedRoot = `/v1/servers/${limited.id}`;
  const otherParticipant = (
    await x.call("user_alice", "POST", `${limitedRoot}/participants`, {
      name: "Limited",
      agentType: "codex-desktop",
      requestKey: "agent",
    })
  ).item;
  const otherGeneral = (await x.call("user_alice", "GET", limitedRoot)).generalConversationId;
  await x.call(
    "user_alice",
    "POST",
    `${limitedRoot}/conversations/${otherGeneral}/messages`,
    {
      ...input,
      participantId: otherParticipant.id,
    },
    402,
  );
  const outsider = await x.call("user_bob", "POST", "/v1/accounts", {
    name: "Other owner",
    requestKey: "other",
  });
  await create(x, outsider, { name: "Daily cap", requestKey: "capped" }, 403, "user_bob");
});

test("organization and server velocity are durable, owner-wide and retry safe", async (t) => {
  const x = await start(t, {
    unpaidServers: 10,
    serversPerHour: 2,
    organizationsPerHour: 1,
    manualAlarms: true,
  });
  const input = { name: "Team", requestKey: "organization" };
  const account = await x.call("user_alice", "POST", "/v1/accounts", input);
  await x.call("user_alice", "POST", "/v1/accounts", { ...input, requestKey: "second" }, 403);
  assert.equal((await x.call("user_alice", "POST", "/v1/accounts", input)).id, account.id);
  assert.equal(await count(x, "accounts"), 1);
  const one = await create(x, account, { name: "One", requestKey: "one" });
  await x.control("member", x.member(account.organizationId));
  await create(x, account, { name: "Two", requestKey: "two" }, 200, "user_bob");
  await create(x, account, { name: "Three", requestKey: "three" }, 403, "user_bob");
  assert.equal((await create(x, account, { name: "One", requestKey: "one" })).id, one.id);
  assert.equal(await count(x, "servers"), 2);
  assert.equal(await count(x, "server_access"), 2);
});

test("an interrupted unpaid reservation retains its stock slot and resumes without another admission", async (t) => {
  const x = await start(t, { unpaidServers: 1, manualAlarms: true });
  const account = await x.account();
  const other = await x.account();
  const serverId = randomUUID();
  const input = { name: "Interrupted", requestKey: "resume" };
  await x.db
    .prepare(
      "INSERT INTO servers(id,account_id,name,created_by,request_key,general_id,created_at,status) VALUES(?,?,?,'user_alice',?,?,?,'provisioning')",
    )
    .bind(
      serverId,
      account.id,
      input.name,
      input.requestKey,
      randomUUID(),
      new Date().toISOString(),
    )
    .run();
  await x.control(`fail-provision?server=${serverId}`);
  await create(x, account, input, 503);
  await create(x, other, { name: "Blocked", requestKey: "blocked" }, 403);
  assert.equal(await count(x, "servers"), 1);
  const resumed = await create(x, account, input);
  assert.equal(resumed.id, serverId);
  assert.equal(resumed.status, "ready");
  assert.equal(await count(x, "servers"), 1);
  assert.equal(await count(x, "server_access"), 1);
});

test("paid admission has no stock cap, and payment cannot replenish daily unpaid admissions", async (t) => {
  const x = await start(t, {
    unpaidServers: 1,
    unpaidServersPerDay: 1,
    serversPerHour: 5,
    manualAlarms: true,
  });
  const account = await x.account();
  await x.server(account.id);
  await paid(x, account);
  await x.server(account.id);
  await x.server(account.id);
  const other = await x.call("user_bob", "POST", "/v1/accounts", {
    name: "Other",
    requestKey: "other",
  });
  await create(x, other, { name: "Blocked", requestKey: "blocked" }, 403, "user_bob");
  assert.deepEqual(
    (
      await x.db
        .prepare(
          "SELECT admission_kind,COUNT(*) AS n FROM servers GROUP BY admission_kind ORDER BY admission_kind",
        )
        .all()
    ).results,
    [
      { admission_kind: "paid", n: 2 },
      { admission_kind: "unpaid", n: 1 },
    ],
  );
});

test("pending trial stock remains one even when the unpaid pilot cap is larger", async (t) => {
  const x = await start(t, { unpaidServers: 3, manualAlarms: true });
  const account = await x.account();
  await x.db
    .prepare(
      "INSERT INTO billing_trials(account_id,provider_scope,owner_id,email_key,claimed_at) VALUES(?,'test','user_alice','email',?)",
    )
    .bind(account.id, Date.now())
    .run();
  await x.server(account.id);
  await create(x, account, { name: "Blocked", requestKey: "blocked" }, 403);
  assert.equal(await count(x, "servers"), 1);
});

test("missing or invalid admission policy fails before reservation while discovery remains readable", async (t) => {
  for (const options of [
    { provisioningMissing: true },
    { unpaidServers: "invalid" },
    { unlimitedAccounts: ["owner@example.com"] },
  ]) {
    const x = await start(t, options);
    await x.call(
      "user_alice",
      "POST",
      "/v1/accounts",
      { name: "Blocked", requestKey: "blocked" },
      503,
    );
    assert.equal(await count(x, "accounts"), 0);
    assert.equal(await count(x, "servers"), 0);
    await x.call("user_alice", "GET", "/v1/accounts");
  }
});

test("a denied send and quiet reads leave no recurring alarm or quota allocation", async (t) => {
  const { x, account, server, root, agent, send, meter } = await setup(t, { metering: true });
  assert.equal((await resource(x, server)).alarm, null);
  assert.equal((await send("unpaid", 402)).error.code, "message_payment_required");
  assert.ok((await resource(x, server)).alarm !== null);
  assert.equal((await meter()).allocation.length, 0, "confirmed denial acquired no capacity");
  assert.equal((await resource(x, server, "flush")).alarm, null);
  const baseline = await resource(x, server);
  await x.call("user_alice", "GET", root);
  await x.call("user_alice", "GET", `${root}/participants`);
  await x.call("user_alice", "GET", `${root}/messages`);
  await x.mcp(await x.mcpToken(account.organizationId), "get_updates", {
    serverId: server.id,
    participantId: agent.id,
    mode: "start",
    channelIds: [],
    directChats: "own",
    startAt: "now",
  });
  for (let i = 0; i < 3; i++) assert.equal((await x.control("resource-repair")).status, 200);
  assert.deepEqual(await resource(x, server), baseline);
  assert.equal(baseline.messages, 0);
  assert.equal(
    (await x.call("user_alice", "GET", `/v1/accounts/${account.id}/activity`)).freshness
      .pendingServers,
    0,
  );
});

test("message commits during projection shutdown retain the next wake and index once", async (t) => {
  const { x, server, send } = await setup(t);
  await send("first");
  await resource(x, server, "pause");
  const flushing = resource(x, server, "flush");
  await resource(x, server, "reached");
  await send("during-flush");
  await resource(x, server, "release");
  assert.ok((await flushing).alarm !== null);
  assert.equal(await count(x, "activity_events"), 1);
  assert.equal((await resource(x, server, "flush")).alarm, null);
  assert.equal(await count(x, "activity_events"), 2);
  await send("during-flush");
  await resource(x, server, "flush");
  assert.equal(await count(x, "activity_events"), 2);
});

test("projection failure cannot strand quota recovery and lost allocation replies survive restart", async (t) => {
  const { x, account, server, send, publish, quota, meter } = await setup(t, { metering: true });
  await publish();
  await x.control(`quota/configure?account=${account.id}`, { loseAllocate: true });
  assert.equal((await send("lost-allocation", 503)).error.code, "sending_unavailable");
  assert.equal((await meter()).allocation[0].state, "pending");
  await x.db
    .prepare(
      "CREATE TRIGGER resource_projection_failure BEFORE INSERT ON activity_progress BEGIN SELECT RAISE(ABORT,'injected projection failure'); END",
    )
    .run();
  await resource(x, server, "restart", 503);
  await resource(x, server, "flush", 503);
  assert.ok((await resource(x, server)).alarm !== null);
  assert.equal((await meter()).allocation.length, 0, "quota settled despite failed projection");
  assert.equal((await quota()).available, 10);
  assert.equal((await quota()).used, 0);
  await x.db.prepare("DROP TRIGGER resource_projection_failure").run();
  assert.equal((await resource(x, server, "flush")).alarm, null);
  await send("lost-allocation");
  await x.control(`quota/configure?account=${account.id}`, { loseClose: true });
  await resource(x, server, "flush", 503);
  assert.equal((await meter()).allocation[0].state, "closing");
  assert.equal((await quota()).used, 1);
  await resource(x, server, "restart", 503);
  assert.equal((await resource(x, server, "flush")).alarm, null);
  assert.equal((await quota()).used, 1);
  assert.equal((await meter()).allocation.length, 0);
  assert.equal(await count(x, "activity_events"), 1);
});

test("bounded backlog, legacy startup and the quiet safety audit recover missed wakeups", async (t) => {
  const { x, account, server, send } = await setup(t);
  assert.equal((await x.control("resource-repair")).status, 200);
  assert.equal((await resource(x, server)).alarm, null);
  const baseline = (await resource(x, server)).passes;
  for (let i = 0; i < 51; i++) await send(`backlog-${i}`);
  assert.ok((await resource(x, server, "flush")).alarm !== null);
  assert.equal(await count(x, "activity_events"), 50);
  assert.equal((await resource(x, server, "flush")).alarm, null);
  assert.equal(await count(x, "activity_events"), 51);
  await send("missed-wake");
  await resource(x, server, "clear-alarm");
  await resource(x, server, "restart", 503);
  await x.db.prepare("UPDATE activity_progress SET checked_at='2020-01-01T00:00:00.000Z'").run();
  const quiet = await x.call("user_alice", "GET", `/v1/accounts/${account.id}/activity`);
  assert.equal(
    quiet.freshness.pendingServers,
    0,
    "a historical check time alone is not reported as a known backlog",
  );
  assert.equal(
    quiet.freshness.indexedThrough,
    "2020-01-01T00:00:00.000Z",
    "do not fabricate a current observation",
  );
  assert.equal((await x.control("resource-repair")).status, 200);
  assert.equal(await count(x, "activity_events"), 52);
  assert.equal((await resource(x, server)).alarm, null);
  assert.equal((await resource(x, server)).passes, baseline + 3);
});

test("repair leaves idle caught-up servers asleep and still finds every server that needs it", async (t) => {
  const { x, server, send } = await setup(t);
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const hour = 3_600_000;
  const day = 24 * hour;
  const checkedAt = async () =>
    (await x.db.prepare("SELECT checked_at FROM activity_progress").first()).checked_at;
  const repair = () => x.control("resource-repair").then((r) => assert.equal(r.status, 200));
  // Never exported: the first pass exports it.
  await repair();
  assert.equal(await count(x, "activity_progress"), 1);
  await send("indexed");
  assert.equal((await resource(x, server, "flush")).alarm, null);
  const passes = () => resource(x, server).then((r) => r.passes);
  const baseline = await passes();

  // Caught up and checked two hours ago: the hourly audit woke it, the repair no longer does.
  await x.db
    .prepare("UPDATE activity_progress SET checked_at=?")
    .bind(ago(2 * hour))
    .run();
  for (let i = 0; i < 3; i++) await repair();
  assert.equal(await passes(), baseline, "an idle caught-up server is not woken");

  // A lost alarm on a caught-up server waits for its next send, which exports both messages.
  await send("missed-wake");
  await resource(x, server, "clear-alarm");
  await repair();
  assert.equal(await passes(), baseline);
  assert.equal(await count(x, "activity_events"), 1);
  await send("next-send");
  assert.equal((await resource(x, server, "flush")).alarm, null);
  assert.equal(await count(x, "activity_events"), 3);

  // ... or for the weekly sweep, whichever comes first.
  await send("missed-again");
  await resource(x, server, "clear-alarm");
  await x.db
    .prepare("UPDATE activity_progress SET checked_at=?")
    .bind(ago(6 * day))
    .run();
  await repair();
  assert.equal(await count(x, "activity_events"), 3, "six days is inside the sweep interval");
  await x.db
    .prepare("UPDATE activity_progress SET checked_at=?")
    .bind(ago(8 * day))
    .run();
  const before = await passes();
  await repair();
  assert.equal(await passes(), before + 1);
  assert.equal(await count(x, "activity_events"), 4);
  assert.ok(Date.parse(await checkedAt()) > Date.now() - hour, "the sweep records its check");

  // A server whose last export was behind is repaired at once, however recently it was checked.
  await send("behind");
  await resource(x, server, "clear-alarm");
  await x.db.prepare("UPDATE activity_progress SET caught_up=0").run();
  await repair();
  assert.equal(await passes(), before + 2);
  assert.equal(await count(x, "activity_events"), 5);
  assert.equal(
    (await x.db.prepare("SELECT caught_up FROM activity_progress").first()).caught_up,
    1,
  );
  await repair();
  assert.equal(await passes(), before + 2, "once caught up it is left alone");
});

test("failed repair batches rotate so a later server with a missed wake can recover", async (t) => {
  const { x, account, server: healthy, send } = await setup(t);
  for (let i = 0; i < 20; i++) await x.server(account.id);
  // Make the healthy server the last candidate without depending on random IDs.
  await send("missed-wake-behind-failures");
  await resource(x, healthy, "flush");
  await x.db.prepare("UPDATE activity_progress SET checked_at='2020-01-01T00:00:00.000Z'").run();
  await send("recover-behind-failures");
  await resource(x, healthy, "clear-alarm");
  const baseline = (await resource(x, healthy)).passes;
  await x.db
    .prepare(`CREATE TRIGGER fail_repair_batch BEFORE INSERT ON activity_progress
    WHEN NEW.server_id <> '${healthy.id}'
    BEGIN SELECT RAISE(ABORT,'injected server-specific failure'); END`)
    .run();
  assert.equal((await x.control("resource-repair")).status, 503);
  assert.equal((await resource(x, healthy)).passes, baseline);
  assert.equal(await count(x, "activity_events"), 1);
  // A fresh runtime must retain the rotation, while failures remain in place.
  await x.persistenceCheckpoint();
  assert.equal((await x.control("resource-repair")).status, 503);
  assert.equal((await resource(x, healthy)).passes, baseline + 1);
  assert.equal(await count(x, "activity_events"), 2);
  assert.equal(
    await count(x, "activity_progress"),
    1,
    "attempts do not report failed servers as caught up",
  );
  await x.db.prepare("DROP TRIGGER fail_repair_batch").run();
  for (let i = 0; i < 2; i++) assert.equal((await x.control("resource-repair")).status, 200);
  assert.equal(await count(x, "activity_progress"), 21, "failed servers remain retryable");
  assert.equal(await count(x, "activity_events"), 2, "recovery does not duplicate messages");
});
