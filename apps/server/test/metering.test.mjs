import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { provider, event } from "./billing-provider.mjs";
import { startRemote } from "./metering-remote.mjs";
import { start } from "./platform-harness.mjs";
import { rpc } from "./mcp-wire.mjs";
import { plans } from "@talkto/api/pricing";

/** `publish: false` leaves the organization without a period, for tests that publish their own. */
const setup = async (t, allowance = 4, overdraft = 2, { publish = true, ...options } = {}) => {
  const x =
    process.env.TALKTO_METERING_REMOTE === undefined
      ? await start(t, { metering: true, ...options })
      : await startRemote(process.env.TALKTO_METERING_REMOTE);
  const account = await x.account();
  const period = {
    accountId: account.id,
    start: new Date(Date.now() - 3600000).toISOString(),
    end: new Date(Date.now() + 3600000).toISOString(),
    allowance,
    overdraft,
  };
  const control = async (path, data) => {
    const r = await x.control(path, data);
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const quota = (action = "", data) => control(`quota${action}?account=${account.id}`, data);
  if (publish) await quota("/publish", period);
  const credential = await x.mcpToken(account.organizationId);
  const server = async () => {
    const item = await x.server(account.id);
    const registered = await x.mcp(credential, "register_participant", {
      serverId: item.id,
      name: "meter-agent",
      agentType: "codex",
      requestKey: randomUUID(),
    });
    const participantId = registered.data.item.id;
    const target = { kind: "conversation", conversationId: registered.data.generalConversationId };
    const args = (requestKey = randomUUID()) => ({
      serverId: item.id,
      participantId,
      target,
      body: "Metered message",
      requestKey,
    });
    const send = (requestKey, error = false) =>
      x.mcp(credential, "send_message", args(requestKey), error);
    /** One send that may succeed or fail: its result, with `error` when it failed. */
    const attempt = async () => {
      const response = await x.raw(
        "/mcp",
        rpc("tools/call", { name: "send_message", arguments: args() }, credential),
      );
      return (await response.json()).result.structuredContent;
    };
    const meter = (action = "", data) => control(`meter${action}?server=${item.id}`, data);
    return { ...item, participantId, target, args, send, attempt, meter };
  };
  return { x, account, period, quota, server, credential, control };
};

test("one workspace budget covers servers, concurrent agents, replay, and HTTP/MCP exhaustion", async (t) => {
  const { x, quota, server, credential } = await setup(t);
  const a = await server();
  const b = await server();
  const key = randomUUID();
  const messages = await Promise.all([a.send(key), a.send(key), a.send(key)]);
  assert.equal(new Set(messages.map((r) => r.data.item.id)).size, 1);
  assert.equal(messages.filter((r) => r.data.created).length, 1);
  const held = await quota();
  assert.equal(held.used, 0);
  assert.equal(held.usageUpperBound, 6);
  const pending = await b.send(undefined, true);
  assert.equal(pending.error.code, "sending_unavailable");
  assert.equal(pending.error.retryable, true);
  await a.meter("/report");
  for (let i = 0; i < 5; i++) await b.send();
  await b.meter("/report");
  const full = await quota();
  assert.equal(full.used, 6);
  assert.equal(full.outstanding, 0);
  assert.equal(full.status, "exhausted");
  const denied = await a.send(undefined, true);
  assert.equal(denied.error.code, "message_allowance_exhausted");
  assert.equal(denied.error.action, "contact_workspace_owner");
  assert.equal((await a.send(key)).data.created, false);
  const path = `/v1/servers/${b.id}/conversations/${b.target.conversationId}/messages`;
  const response = await x.raw(path, {
    method: "POST",
    headers: { authorization: `Bearer ${await x.token()}`, "content-type": "application/json" },
    body: JSON.stringify({
      participantId: b.participantId,
      requestKey: randomUUID(),
      body: "over budget",
    }),
  });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get("www-authenticate"), null);
  assert.equal((await response.json()).error.code, denied.error.code);
  assert.equal((await x.call("user_alice", "GET", path)).items.length, 5);
  const reader = await x.mcp(credential, "register_participant", {
    serverId: b.id,
    name: "new-identity",
    agentType: "claude",
    requestKey: randomUUID(),
  });
  const updates = await x.mcp(credential, "get_updates", {
    serverId: b.id,
    participantId: reader.data.item.id,
    mode: "start",
    channelIds: [b.target.conversationId],
    directChats: "own",
    startAt: "beginning",
  });
  assert.equal(updates.data.messages.length, 5);
  assert.equal((await quota()).used, 6);
  const c = await server();
  assert.equal((await c.send(undefined, true)).error.code, "message_allowance_exhausted");
  assert.equal((await quota()).used, 6);
});

test("lost allocation and report replies survive retries and real DO eviction without minting capacity", async (t) => {
  const { x, account, quota, server } = await setup(t, 3, 1);
  const a = await server();
  await quota("/configure", { loseAllocate: true });
  const key = randomUUID();
  assert.equal((await a.send(key, true)).error.code, "sending_unavailable");
  assert.equal((await quota()).usageUpperBound, 4);
  // Abort the actual object: its next request constructs a fresh instance over persisted SQLite.
  await x.control(`meter/configure?server=${a.id}`, { restart: true });
  await a.send(key);
  assert.equal((await a.meter()).usage.length, 1);
  await quota("/configure", { loseClose: true });
  const lost = await x.control(`meter/report?server=${a.id}`);
  assert.equal(lost.status, 500);
  assert.equal((await quota()).used, 1);
  await x.control(`quota/restart?account=${account.id}`);
  await x.control(`meter/configure?server=${a.id}`, { restart: true });
  await a.meter("/report");
  assert.equal((await quota()).used, 1);
  assert.equal((await quota()).available, 3);
  for (let i = 0; i < 3; i++) await a.send();
  await a.meter("/report");
  assert.equal((await quota()).used, 4);
  assert.equal((await a.send(key)).data.created, false);
  assert.equal((await a.send(undefined, true)).error.code, "message_allowance_exhausted");
});

test("failed writes roll back usage, and delayed reporting cannot free capacity during an outage", async (t) => {
  const { quota, server, x } = await setup(t, 31, 2);
  const a = await server();
  const b = await server();
  await a.send();
  await a.meter("/configure", { failWrite: true });
  const response = await x.raw(
    `/v1/servers/${a.id}/conversations/${a.target.conversationId}/messages`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${await x.token()}`, "content-type": "application/json" },
      body: JSON.stringify({
        participantId: a.participantId,
        body: "rollback",
        requestKey: randomUUID(),
      }),
    },
  );
  assert.equal(response.status, 500);
  assert.equal((await a.meter()).usage.length, 1);
  await a.meter("/configure", { failWrite: false });
  await quota("/configure", { down: true });
  // Already-issued capacity remains usable, without a quota/Stripe/D1 call.
  for (let i = 0; i < 31; i++) await a.send();
  assert.equal((await a.send(undefined, true)).error.code, "sending_unavailable");
  assert.equal((await b.send(undefined, true)).error.code, "sending_unavailable");
  assert.equal((await quota()).usageUpperBound, 32);
  await quota("/configure", {});
  await a.meter("/report");
  await b.send();
  await b.meter("/report");
  assert.equal((await quota()).used, 33);
  assert.equal((await a.send(undefined, true)).error.code, "message_allowance_exhausted");
});

test("period expiry fences old capacity, renewal does not rollover, and delayed old reports do not change the new budget", async (t) => {
  const { quota, period, server } = await setup(t, 3, 1);
  const a = await server();
  const b = await server();
  const key = randomUUID();
  await a.send(key);
  const renewed = {
    ...period,
    start: period.end,
    end: new Date(Date.parse(period.end) + 3600000).toISOString(),
  };
  await quota("/publish", renewed);
  assert.equal(
    (await quota()).periodStart,
    period.start,
    "future entitlement must not replace current capacity early",
  );
  await quota("/configure", { at: period.end });
  await a.meter("/configure", { at: period.end });
  await b.meter("/configure", { at: period.end });
  await b.send();
  await b.meter("/report");
  await a.meter("/report");
  assert.equal((await quota()).used, 1);
  assert.equal((await a.send(key)).data.created, false);
  await quota("/publish", period);
  await quota("/publish", renewed);
  assert.equal((await quota()).used, 1);
  await a.send();
  await a.send();
  await a.send();
  await a.meter("/report");
  assert.equal((await quota()).used, 4);
  await quota("/configure", { at: renewed.end });
  await a.meter("/configure", { at: renewed.end });
  assert.equal((await a.send(undefined, true)).error.code, "message_payment_required");
});

test("abandoned allocation requests recover and return unused capacity through the alarm path", async (t) => {
  const { quota, server } = await setup(t, 2, 1);
  const a = await server();
  const b = await server();
  await quota("/configure", { loseAllocate: true });
  await a.send(undefined, true);
  await a.meter("/report");
  assert.equal((await quota()).used, 0);
  assert.equal((await quota()).available, 3);
  await b.send();
  await b.meter("/report");
  assert.equal((await quota()).used, 1);
});

test("only confirmed Stripe payment publishes allowance, and repeated billing reconciliation preserves consumption", async (t) => {
  const stripe = provider();
  const x = await start(t, { metering: true, stripeHandler: stripe.handler });
  const account = await x.account();
  const server = await x.server(account.id);
  const token = await x.mcpToken(account.organizationId);
  const reg = await x.mcp(token, "register_participant", {
    serverId: server.id,
    name: "billing-proof",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  const args = {
    serverId: server.id,
    participantId: reg.data.item.id,
    target: { kind: "conversation", conversationId: reg.data.generalConversationId },
    requestKey: randomUUID(),
    body: "after payment",
  };
  assert.equal(
    (await x.mcp(token, "send_message", args, true)).error.code,
    "message_payment_required",
  );
  const path = `/v1/accounts/${account.id}/billing`;
  const state = () => x.call("user_alice", "GET", path);
  assert.equal((await state()).usage.status, "payment_required");
  await x.call("user_alice", "POST", `${path}/checkout`, {
    plan: "shop",
    requestKey: randomUUID(),
  });
  assert.equal((await state()).usage.status, "payment_required");
  const paid = stripe.complete([...stripe.sessions.keys()][0]);
  assert.equal((await x.control("sync")).status, 200);
  const ready = await state();
  assert.equal(ready.usage.allowance, plans.shop.messages);
  assert.equal(ready.usage.overdraft, 500);
  await x.mcp(token, "send_message", args);
  assert.equal((await x.control(`meter/report?server=${server.id}`)).status, 200);
  assert.equal((await state()).usage.used, 1);
  await event(x, paid.session.customer);
  await x.control("sync");
  assert.equal((await state()).usage.used, 1);
  assert.equal((await x.mcp(token, "send_message", args)).data.created, false);
  stripe.control.down = true;
  await x.control("database-down?value=true");
  await x.mcp(token, "send_message", { ...args, requestKey: randomUUID() });
  await x.control("database-down?value=false");
  assert.equal((await state()).usage.usageUpperBound, 33);
});

test("metered units accumulate, refill across block boundaries, and exhaust instead of looping", async (t) => {
  const { account, quota, server } = await setup(t, 40, 0);
  const a = await server();
  const spend = (units, kind = "message") =>
    a.meter("/spend", { accountId: account.id, serverId: a.id, units, kind });
  await a.send();
  assert.deepEqual(await spend(3), { ok: true, failure: null });
  assert.deepEqual(await spend(5, "share"), { ok: true, failure: null });
  const journal = await a.meter();
  assert.deepEqual(
    journal.usage.map((row) => row.units).sort((x, y) => x - y),
    [1, 3, 5],
  );
  assert.deepEqual(
    journal.usage.filter((row) => row.kind === "share").map((row) => row.units),
    [5],
  );
  assert.equal(journal.allocation[0].used, 9);
  assert.equal(journal.allocation[0].capacity, 32);
  // Nine of thirty-two are spent, so a thirty-unit spend settles the block and takes a new one.
  assert.deepEqual(await spend(30), { ok: true, failure: null });
  assert.equal((await quota()).used, 9);
  assert.equal((await quota()).usageUpperBound, 40);
  await a.meter("/report");
  assert.equal((await quota()).used, 39);
  assert.equal((await quota()).available, 1);
  // One unit remains in the period, so a ten-unit spend can never be funded: report, do not loop.
  assert.deepEqual(await spend(10), { ok: false, failure: "MessageAllowanceExhausted" });
  await a.send();
  assert.deepEqual(await spend(2), { ok: false, failure: "MessageAllowanceExhausted" });
  assert.equal((await quota()).used, 40);
  assert.equal((await quota()).status, "exhausted");
  assert.equal((await a.send(undefined, true)).error.code, "message_allowance_exhausted");
});

test("a usage journal written before metered units upgrades in place and keeps its committed rows", async (t) => {
  const { account, quota, server } = await setup(t, 40, 0);
  const a = await server();
  await a.send();
  const downgraded = await a.meter("/legacy-usage");
  assert.equal(downgraded.usage.length, 1);
  assert.equal("units" in downgraded.usage[0], false);
  assert.equal("kind" in downgraded.usage[0], false);
  assert.deepEqual(
    await a.meter("/spend", { accountId: account.id, serverId: a.id, units: 4, kind: "share" }),
    { ok: true, failure: null },
  );
  const upgraded = await a.meter();
  assert.deepEqual(
    upgraded.usage.map((row) => row.units).sort((x, y) => x - y),
    [1, 4],
  );
  assert.deepEqual(upgraded.usage.map((row) => row.kind).sort(), ["message", "share"]);
  assert.equal(upgraded.allocation[0].used, 5);
  await a.meter("/report");
  assert.equal((await quota()).used, 5);
});

test("the file share surcharge defaults to zero and rejects a value that cannot fit a block", async (t) => {
  const settings = async (options) => {
    const x = await start(t, { metering: true, ...options });
    const response = await x.control("metering-settings");
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  assert.deepEqual(await settings({}), { ok: true, shareUnits: 0 });
  assert.deepEqual(await settings({ shareUnits: 31 }), { ok: true, shareUnits: 31 });
  assert.deepEqual(await settings({ shareUnits: 32 }), { ok: false, operation: "configuration" });
  assert.deepEqual(await settings({ shareUnits: -1 }), { ok: false, operation: "configuration" });
});

const minute = 60_000;
/** Run a server's alarm pass now, as Cloudflare would, and return the alarm it leaves. */
const pass = async (x, item) => (await x.control(`resources?server=${item.id}`, "flush")).json();
/** Move the metering clocks of the quota object and the given servers. */
const at = async (quota, servers, ms) => {
  const time = new Date(ms).toISOString();
  await quota("/configure", { at: time });
  for (const item of servers) await item.meter("/configure", { at: time });
};
const until = async (check, what) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(what);
};

test("a block stays open between sends: a later send makes no quota call and writes far fewer rows", async (t) => {
  const { x, account, quota, server } = await setup(t, 10_000, 500, { manualAlarms: true });
  const a = await server();
  await a.send();
  await pass(x, a);
  const quotaCost = async () => (await x.control(`quota/cost?account=${account.id}`)).json();
  await quotaCost();
  await x.control(`cost?server=${a.id}`, "start");
  await a.send();
  const after = await pass(x, a);
  const local = await (await x.control(`cost?server=${a.id}`, "take")).json();
  const remote = await quotaCost();
  t.diagnostic(
    JSON.stringify({
      serverRows: local.rowsWritten,
      serverAlarms: local.alarms,
      quotaRows: remote.rows,
      allocates: remote.allocates,
      closes: remote.closes,
    }),
  );
  // No quota call and no quota row: the block from the first send funds this one.
  assert.equal(remote.allocates + remote.closes, 0);
  assert.equal(remote.rows, 0);
  // The message, its usage row and three alarms; no allocation rows on the server either.
  assert.ok(local.rowsWritten + local.alarms <= 19, JSON.stringify(local));
  // Reported usage trails the open block, which the upper bound shows.
  const usage = await quota();
  assert.equal(usage.used, 0);
  assert.equal(usage.usageUpperBound, 32);
  assert.ok(after.alarm !== null && after.alarm - Date.now() > 25 * minute, `${after.alarm}`);
});

test("an idle server holding a block wakes once, at the hold's end, and closes it then", async (t) => {
  const { x, quota, server } = await setup(t, 10_000, 500, { manualAlarms: true });
  const a = await server();
  const sent = Date.now();
  await a.send();
  await a.send();
  // The pass leaves one alarm, at the hold's end, not one every 5 seconds.
  const first = await pass(x, a);
  assert.ok(first.alarm !== null, "no alarm for the held block");
  assert.ok(first.alarm - sent > 29 * minute && first.alarm - sent < 31 * minute, `${first.alarm}`);
  // Another pass before then (a wake, a repair) keeps the block and the same alarm.
  const again = await pass(x, a);
  assert.ok(Math.abs(again.alarm - first.alarm) < 5_000, `${again.alarm} vs ${first.alarm}`);
  assert.equal((await quota()).used, 0);
  // At the hold's end the pass closes the block and leaves no alarm.
  await at(quota, [a], sent + 30 * minute + 1_000);
  assert.equal((await pass(x, a)).alarm, null);
  const usage = await quota();
  assert.equal(usage.used, 2);
  assert.equal(usage.outstanding, 0);
});

test("near the limit a block gets the short hold, and blocks held elsewhere are asked to close", async (t) => {
  const { x, account, quota, server } = await setup(t, 64, 0, { manualAlarms: true });
  const a = await server();
  const b = await server();
  // A takes 32 of 64, and 32 are left: A may hold its block.
  await a.send();
  const held = await pass(x, a);
  assert.ok(held.alarm !== null && held.alarm - Date.now() > 25 * minute, `${held.alarm}`);
  assert.equal((await quota()).outstanding, 32);
  // B takes the last 32. That is close to the limit: B gets the short hold, and the quota object
  // asks A to close its block, so A's unused 31 are free again.
  await b.send();
  await x.control(`quota/alarm?account=${account.id}`);
  await until(async () => (await quota()).used === 1, "A's held block was not closed");
  assert.equal((await quota()).usageUpperBound, 33);
  assert.equal((await pass(x, b)).alarm, null);
  const usage = await quota();
  assert.equal(usage.used, 2);
  assert.equal(usage.outstanding, 0);
  assert.equal(usage.available, 62);
});

test("a full block closes at the next pass", async (t) => {
  const { x, quota, server } = await setup(t, 10_000, 500, { manualAlarms: true });
  const a = await server();
  for (let i = 0; i < 32; i++) await a.send();
  assert.equal((await pass(x, a)).alarm, null);
  const usage = await quota();
  assert.equal(usage.used, 32);
  assert.equal(usage.outstanding, 0);
});

test("billing shows the exact count while servers hold blocks, asking only the servers that hold one", async (t) => {
  const { x, account, quota, server } = await setup(t, 10_000, 500, {
    manualAlarms: true,
    stripeHandler: provider().handler,
  });
  const path = `/v1/accounts/${account.id}/billing`;
  const usage = async () => (await x.call("user_alice", "GET", path)).usage;
  const a = await server();
  const b = await server();
  // A server that never sent holds no block and is never asked, so its failure changes nothing.
  const idle = await server();
  await idle.meter("/configure", { failUnreported: true });
  assert.equal((await usage()).counted, undefined);
  for (let i = 0; i < 3; i++) await a.send();
  for (let i = 0; i < 2; i++) await b.send();
  // Before: only the range 0–64 was known. Now the count is exact before any report.
  const held = await usage();
  assert.deepEqual([held.used, held.usageUpperBound, held.counted], [0, 64, 5]);
  // Counting is read-only: both blocks are still open and unreported.
  assert.deepEqual([(await quota()).used, (await quota()).outstanding], [0, 64]);
  assert.equal((await a.meter()).allocation.length, 1);
  // A reported block counts once, and a send on the block A takes next counts at once.
  await a.meter("/report");
  await a.send();
  const later = await usage();
  assert.deepEqual([later.used, later.counted], [3, 6]);
  // A holder that cannot answer leaves the range, never a wrong number.
  await b.meter("/configure", { failUnreported: true });
  const unknown = await usage();
  assert.deepEqual([unknown.used, unknown.usageUpperBound, unknown.counted], [3, 67, undefined]);
  await b.meter("/configure", { failUnreported: false });
  // Once every block is reported, `used` is exact and nothing more is added.
  await a.meter("/report");
  await b.meter("/report");
  const settled = await usage();
  assert.deepEqual([settled.used, settled.outstanding, settled.counted], [6, 0, undefined]);
});

test("a held block survives a lost reply and restarts: nothing lost or minted, no new block", async (t) => {
  const { x, account, quota, server } = await setup(t, 10_000, 500, { manualAlarms: true });
  const a = await server();
  const sent = Date.now();
  await quota("/configure", { loseAllocate: true });
  const key = randomUUID();
  assert.equal((await a.send(key, true)).error.code, "sending_unavailable");
  await a.send(key);
  await a.send();
  await a.send();
  await pass(x, a);
  await x.control(`meter/configure?server=${a.id}`, { restart: true });
  await x.control(`quota/restart?account=${account.id}`);
  await a.send();
  await a.send();
  const calls = await (await x.control(`quota/cost?account=${account.id}`)).json();
  assert.equal(calls.allocates, 0);
  assert.equal((await quota()).usageUpperBound, 32);
  await at(quota, [a], sent + 30 * minute + 1_000);
  assert.equal((await pass(x, a)).alarm, null);
  const usage = await quota();
  assert.equal(usage.used, 5);
  assert.equal(usage.outstanding, 0);
  assert.equal(usage.available, 10_500 - 5);
  assert.equal((await a.meter()).usage.length, 5);
});

test("a block granted in its period's last 31 minutes gets the short hold; one before is held a minute short of the end", async (t) => {
  const { x, quota, server, period } = await setup(t, 10_000, 500, { manualAlarms: true });
  const a = await server();
  const end = Date.parse(period.end);
  // 40 minutes before the end: a full hold, which ends ten minutes before the period does.
  await at(quota, [a], end - 40 * minute);
  const real = Date.now();
  await a.send();
  const held = await pass(x, a);
  assert.ok(
    held.alarm !== null && Math.abs(held.alarm - (real + 30 * minute)) < minute,
    `${held.alarm}`,
  );
  await at(quota, [a], end - 10 * minute + 1_000);
  assert.equal((await pass(x, a)).alarm, null);
  assert.equal((await quota()).used, 1);
  // Twenty minutes before the end: the short hold, so the block is reported at the next pass.
  await at(quota, [a], end - 20 * minute);
  await a.send();
  assert.equal((await pass(x, a)).alarm, null);
  const usage = await quota();
  assert.equal(usage.periodStart, period.start);
  assert.equal(usage.used, 2);
  assert.equal(usage.outstanding, 0);
});

test("a quota object from before holds gives none: the block closes at the next pass", async (t) => {
  const { x, quota, server } = await setup(t, 10_000, 500, { manualAlarms: true });
  const a = await server();
  await quota("/configure", { legacyHold: true });
  await a.send();
  assert.equal((await pass(x, a)).alarm, null);
  assert.equal((await quota()).used, 1);
});

/**
 * Whether `check` comes to hold within `millis` of real time (recall retries back off by seconds).
 * Tests go on either way, so a failure still reports everything they measure.
 */
const settles = async (check, millis = 10_000) => {
  const deadline = Date.now() + millis;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};
/** Messages a server sent of `count` tries, and the error codes of the rest. */
const tries = async (item, count) => {
  const refused = [];
  for (let i = 0; i < count; i++) {
    const result = await item.attempt();
    if (result.error !== undefined) refused.push(result.error.code);
  }
  return { sent: count - refused.length, refused };
};

test("a refund asks a server holding a block to close it, and the block stops funding sends", async (t) => {
  const { x, account, quota, server, period } = await setup(t, 10_000, 500, {
    manualAlarms: true,
  });
  const a = await server();
  await a.send();
  assert.ok((await pass(x, a)).alarm - Date.now() > 25 * minute, "the block is held");
  const revoked = await quota("/revoke", {
    accountId: account.id,
    start: period.start,
    at: new Date().toISOString(),
  });
  assert.equal(revoked.ok, true);
  // The quota object's alarm asks the server at once; the block closes with its one message.
  const closed = await settles(async () => (await quota()).outstanding === 0);
  const after = await tries(a, 3);
  t.diagnostic(JSON.stringify({ closed, ...after }));
  assert.ok(closed, "the held block stayed open");
  assert.equal((await quota()).used, 1);
  assert.deepEqual(await quota("/recalls"), []);
  assert.equal(after.sent, 0);
  assert.equal((await a.meter()).usage.length, 1);
});

test("a recall the server fails is asked again, across a quota restart, until the block closes", async (t) => {
  const { x, account, quota, server, period } = await setup(t, 10_000, 500, {
    manualAlarms: true,
  });
  const a = await server();
  const sent = Date.now();
  await a.send();
  await pass(x, a);
  // The server fails the first two requests to close its block.
  await a.meter("/configure", { failReports: 2 });
  const refund = { accountId: account.id, start: period.start, at: new Date().toISOString() };
  assert.equal((await quota("/revoke", refund)).ok, true);
  const tried = await settles(async () =>
    (await quota("/recalls")).some((recall) => recall.attempts >= 1),
  );
  // The recall is stored, so a restart of the quota object does not lose it, and billing's replay
  // of the refund changes nothing else.
  await x.control(`quota/restart?account=${account.id}`);
  assert.equal((await quota("/revoke", refund)).ok, true);
  const closed = await settles(async () => (await quota()).outstanding === 0);
  // 29 minutes after the refund, inside what was the block's hold, nothing more can be sent.
  await at(quota, [a], sent + 29 * minute);
  const late = await tries(a, 31);
  t.diagnostic(JSON.stringify({ tried, closed, sent: late.sent, of: 31 }));
  assert.ok(tried && closed, "the recall was not retried until the block closed");
  assert.equal((await quota()).used, 1);
  assert.deepEqual(await quota("/recalls"), []);
  assert.equal(late.sent, 0);
  assert.equal((await a.meter()).usage.length, 1);
});

test("a recall naming a block the server has replaced leaves the new block open", async (t) => {
  const { quota, server } = await setup(t, 10_000, 500, { manualAlarms: true });
  const a = await server();
  for (let i = 0; i < 32; i++) await a.send();
  const first = (await a.meter()).allocation[0].id;
  // The full block is replaced by the next send, before the recall the quota object sent for it.
  await a.send();
  const second = (await a.meter()).allocation[0].id;
  assert.notEqual(second, first);
  await a.meter("/report", { id: first });
  const after = (await a.meter()).allocation;
  t.diagnostic(JSON.stringify({ replacementOpen: after.some((row) => row.id === second) }));
  assert.deepEqual(
    after.map((row) => [row.id, row.state]),
    [[second, "active"]],
  );
  assert.equal((await quota()).outstanding, 32);
  // A recall naming the block it holds closes it.
  await a.meter("/report", { id: second });
  assert.deepEqual((await a.meter()).allocation, []);
  const usage = await quota();
  assert.equal(usage.used, 33);
  assert.equal(usage.outstanding, 0);
});

test("a replayed grant in a revoked period gets no hold", async (t) => {
  const { x, account, quota, server, period } = await setup(t, 10_000, 500, {
    manualAlarms: true,
  });
  const a = await server();
  await quota("/configure", { loseAllocate: true });
  const key = randomUUID();
  assert.equal((await a.send(key, true)).error.code, "sending_unavailable");
  // The server cannot be asked to close the block, so only its own retry replays the grant.
  await a.meter("/configure", { failReports: 100 });
  await quota("/revoke", {
    accountId: account.id,
    start: period.start,
    at: new Date().toISOString(),
  });
  // The retry replays the grant: the block funds this message, then closes at the next pass.
  await a.send(key);
  const replayed = await pass(x, a);
  const after = await tries(a, 3);
  t.diagnostic(
    JSON.stringify({
      holdMinutes: replayed.alarm === null ? 0 : Math.round((replayed.alarm - Date.now()) / minute),
      sentAfter: after.sent,
    }),
  );
  assert.equal(replayed.alarm, null);
  assert.equal((await quota()).outstanding, 0);
  assert.equal(after.sent, 0);
});

test("a send refused while another server holds unused capacity gets it within seconds", async (t) => {
  const { x, quota, server } = await setup(t, 96, 0, { manualAlarms: true });
  const a = await server();
  const b = await server();
  // A holds a block with one message in it, and fails the first request to close it.
  await a.send();
  await pass(x, a);
  await a.meter("/configure", { failReports: 1 });
  // B spends the other 64: its blocks get the short hold, and then it is refused.
  let refused = null;
  for (let i = 0; i < 64 && refused === null; i++) {
    const result = await b.attempt();
    if (result.error !== undefined) refused = result.error.code;
    if (i % 32 === 31) await pass(x, b);
  }
  await pass(x, b);
  const outcomes = [];
  const began = Date.now();
  for (let i = 0; i < 5; i++) {
    const result = await b.attempt();
    outcomes.push(result.error?.code ?? "sent");
    if (result.error === undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  t.diagnostic(JSON.stringify({ refused, outcomes, seconds: (Date.now() - began) / 1000 }));
  assert.equal(outcomes.at(-1), "sent", "B was refused while A held 31 unused messages");
  const usage = await quota();
  assert.equal(usage.used + usage.outstanding <= 96, true);
});

/** A Free month starting at `start`: it ends at the next UTC month boundary. */
const freeMonth = (accountId, start) => {
  const date = new Date(start);
  return {
    accountId,
    start: new Date(start).toISOString(),
    end: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString(),
    allowance: 2000,
    overdraft: 0,
    kind: "free",
  };
};
/** The periods a server's journalled messages were counted in, with how many each. */
const counted = async (item) => {
  const counts = {};
  for (const row of (await item.meter()).usage)
    counts[row.period_start] = (counts[row.period_start] ?? 0) + 1;
  return counts;
};

test("a paid purchase ends a Free month at once: the block a server holds closes, later sends are paid", async (t) => {
  const { x, account, quota, server } = await setup(t, 0, 0, {
    manualAlarms: true,
    publish: false,
  });
  // Mid-month on both clocks, so no hold is shortened by the month's end.
  const now = new Date();
  const month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const mid = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 12);
  const free = freeMonth(account.id, month);
  assert.equal((await quota("/publish", free)).ok, true);
  const a = await server();
  await at(quota, [a], mid);
  await a.send();
  assert.ok((await pass(x, a)).alarm - Date.now() > 25 * minute, "the Free block is held");
  await at(quota, [a], mid + minute);
  const paid = {
    accountId: account.id,
    start: new Date(mid + minute).toISOString(),
    end: new Date(mid + minute + 30 * 86_400_000).toISOString(),
    allowance: 10_000,
    overdraft: 0,
    kind: "paid",
  };
  assert.equal((await quota("/publish", paid)).ok, true);
  const closed = await settles(async () => (await quota("/free-month")).reserved === 1);
  // The server's test clock again, in case it left memory while waiting.
  await at(quota, [a], mid + minute);
  for (let i = 0; i < 5; i++) await a.send();
  const periods = await counted(a);
  t.diagnostic(JSON.stringify({ closed, free: periods[free.start], paid: periods[paid.start] }));
  assert.ok(closed, "the Free block stayed open");
  assert.deepEqual(periods, { [free.start]: 1, [paid.start]: 5 });
});

test("a paid purchase ends the free start at once: the held block's unused part carries, later sends are paid", async (t) => {
  const { x, account, quota, server } = await setup(t, 0, 0, {
    manualAlarms: true,
    publish: false,
  });
  const starter = {
    accountId: account.id,
    start: new Date(Date.now() - 3_600_000).toISOString(),
    end: null,
    allowance: 500,
    overdraft: 0,
    kind: "starter",
  };
  assert.equal((await quota("/publish", starter)).ok, true);
  const a = await server();
  await a.send();
  assert.ok((await pass(x, a)).alarm - Date.now() > 25 * minute, "the starter block is held");
  const paid = {
    accountId: account.id,
    start: new Date().toISOString(),
    end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    allowance: 10_000,
    overdraft: 0,
    kind: "paid",
  };
  assert.equal((await quota("/publish", paid)).ok, true);
  const closed = await settles(async () => (await quota("/starter")).reserved === 1);
  const carried = (await quota()).carriedOver;
  for (let i = 0; i < 5; i++) await a.send();
  const periods = await counted(a);
  t.diagnostic(
    JSON.stringify({ closed, carried, starter: periods[starter.start], paid: periods[paid.start] }),
  );
  assert.ok(closed, "the starter block stayed open");
  // Every free message not sent carries: 468 unreserved at the purchase and the block's 31.
  assert.equal(carried, 499);
  assert.deepEqual(periods, { [starter.start]: 1, [paid.start]: 5 });
});

test("joining Free ends the free start at once: the held block closes, later sends count on Free", async (t) => {
  const { x, account, quota, server } = await setup(t, 0, 0, {
    manualAlarms: true,
    publish: false,
  });
  const starter = {
    accountId: account.id,
    start: new Date(Date.now() - 3_600_000).toISOString(),
    end: null,
    allowance: 500,
    overdraft: 0,
    kind: "starter",
  };
  assert.equal((await quota("/publish", starter)).ok, true);
  const a = await server();
  await a.send();
  assert.ok((await pass(x, a)).alarm - Date.now() > 25 * minute, "the starter block is held");
  // The Free switch turns on; the next read of the quota object moves the organization to Free.
  await quota("/configure", { free: true });
  const usage = await quota();
  assert.equal(usage.kind, "free");
  const closed = await settles(async () => (await quota("/starter")).reserved === 1);
  for (let i = 0; i < 5; i++) await a.send();
  const periods = await counted(a);
  t.diagnostic(
    JSON.stringify({ closed, starter: periods[starter.start], free: periods[usage.periodStart] }),
  );
  assert.ok(closed, "the starter block stayed open");
  assert.deepEqual(periods, { [starter.start]: 1, [usage.periodStart]: 5 });
});

/** The usage warnings handed to the email outbox: period start (from its key) and threshold. */
const warnings = async (x) =>
  (
    await x.db.prepare("SELECT key FROM email_outbox WHERE kind='allowance' ORDER BY key").all()
  ).results.map((row) => row.key);

test("a usage warning waits for the held block that crossed it, and goes out when it closes", async (t) => {
  const { x, account, quota, server, period } = await setup(t, 1000, 0, {
    manualAlarms: true,
    email: "fake",
  });
  await quota("/history", { serverId: randomUUID(), count: 799 });
  const a = await server();
  const sent = Date.now();
  await a.send();
  await pass(x, a);
  // The 800th message is in a held block: the quota object has not seen it yet.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(await warnings(x), []);
  // At the hold's end the block closes, and the 80% warning is queued for this period.
  await at(quota, [a], sent + 30 * minute + 1_000);
  await pass(x, a);
  assert.ok(await settles(async () => (await warnings(x)).length === 1), "no 80% warning");
  assert.deepEqual(await warnings(x), [`allowance:${account.id}:${period.start}:80`]);
});

test("a usage warning crossed in a period's last half hour is not lost to the renewal", async (t) => {
  const { x, account, quota, server, period } = await setup(t, 1000, 0, {
    manualAlarms: true,
    email: "fake",
  });
  await quota("/history", { serverId: randomUUID(), count: 799 });
  const a = await server();
  const end = Date.parse(period.end);
  // Twenty minutes before the end, the 800th message.
  await at(quota, [a], end - 20 * minute);
  await a.send();
  await pass(x, a);
  // The period renews, and the server's next pass comes after the end.
  const renewal = {
    accountId: account.id,
    start: period.end,
    end: new Date(end + 3_600_000).toISOString(),
    allowance: 1000,
    overdraft: 0,
  };
  assert.equal((await quota("/publish", renewal)).ok, true);
  await at(quota, [a], end + 1_000);
  await pass(x, a);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const queued = await warnings(x);
  t.diagnostic(JSON.stringify(queued));
  assert.equal(queued.length, 1, "the 80% warning was lost");
  assert.equal(queued[0], `allowance:${account.id}:${period.start}:80`);
});
