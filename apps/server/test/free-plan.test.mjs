import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";
import { event, provider } from "./billing-provider.mjs";

const nextMonth = (iso) => {
  const date = new Date(iso);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
};
const later = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

/** The Free plan's real Worker/D1/DO path, claimed through the website session as the free start is. */
const setup = async (t, options = {}) => {
  const x = await start(t, { metering: true, starter: true, unpaidServers: 1, ...options });
  const sessions = new Map();
  const cookie = async (user) => {
    if (!sessions.has(user)) {
      const callback = await (await x.browserLogin(user)).callback();
      sessions.set(
        user,
        callback.headers
          .getSetCookie()
          .find((value) => value.startsWith("__Host-talkto-session="))
          .split(";")[0],
      );
    }
    return sessions.get(user);
  };
  const site = async (user, method, path, value, status = 200) => {
    const response = await x.raw(path, {
      method,
      headers: {
        cookie: await cookie(user),
        origin: "https://talkto.test",
        "content-type": "application/json",
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result.data ?? result;
  };
  const account = await x.call("user_alice", "POST", "/v1/accounts", {
    name: "Team",
    requestKey: randomUUID(),
  });
  const claim = () =>
    site("user_alice", "POST", `/v1/accounts/${account.id}/starter`, {
      name: "First",
      requestKey: randomUUID(),
    });
  const state = () => site("user_alice", "GET", `/v1/accounts/${account.id}/starter`);
  const usage = async () => (await x.control(`quota?account=${account.id}`)).json();
  const quota = (input) => x.control(`quota/configure?account=${account.id}`, input);
  const policy = async () =>
    (
      await x.control(`quota/history-policy?account=${account.id}`, { accountId: account.id })
    ).json();
  return { x, site, account, claim, state, usage, quota, policy };
};
/** One agent that commits real messages over MCP. */
const agent = async (x, account, server) => {
  const credential = await x.mcpToken(account.organizationId);
  const registered = await x.mcp(credential, "register_participant", {
    serverId: server.id,
    name: "free-agent",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  const base = {
    serverId: server.id,
    participantId: registered.data.item.id,
    target: { kind: "conversation", conversationId: registered.data.generalConversationId },
    body: "Free plan message",
  };
  return (error = false) =>
    x.mcp(credential, "send_message", { ...base, requestKey: randomUUID() }, error);
};

test("with the Free plan switch off, the free trial is offered and works exactly as before", async (t) => {
  const { x, site, claim, state, usage, policy } = await setup(t);
  assert.deepEqual((await (await x.raw("/v1/offers")).json()).data, {
    starter: { messages: 500, servers: 1 },
  });
  const eligibility = await site("user_alice", "GET", "/v1/starter");
  assert.deepEqual(eligibility.offer, { messages: 500, servers: 1 });
  assert.equal(eligibility.free, undefined);
  const claimed = await claim();
  assert.equal(claimed.state.free, undefined);
  assert.equal(claimed.state.grant.allowance, 500);
  assert.equal(claimed.state.grant.renewsAt, undefined);
  const current = await usage();
  assert.deepEqual([current.kind, current.allowance, current.periodEnd], ["starter", 500, null]);
  assert.equal((await state()).status, "active");
  assert.deepEqual(await policy(), { plan: null, days: null, archive: false });
});

test("with the switch on, a new organization gets the Free plan: 2,000 messages a month on one server", async (t) => {
  const { x, site, account, claim, state, usage, quota, policy } = await setup(t, { free: true });
  assert.deepEqual((await (await x.raw("/v1/offers")).json()).data, {
    starter: null,
    free: { messages: 2000, servers: 1, historyDays: 30 },
  });
  const eligibility = await site("user_alice", "GET", "/v1/starter");
  assert.equal(eligibility.offer, null, "the one-time free trial is no longer offered");
  assert.deepEqual(eligibility.free, { messages: 2000, servers: 1, historyDays: 30 });
  assert.equal(eligibility.status, "eligible");

  const { server, state: opened } = await claim();
  assert.equal(opened.status, "active");
  assert.deepEqual(opened.free, { messages: 2000, servers: 1, historyDays: 30 });
  const renewsAt = nextMonth(opened.grant.activatedAt);
  assert.deepEqual(
    [opened.grant.allowance, opened.grant.used, opened.grant.remaining, opened.grant.renewsAt],
    [2000, 0, 2000, renewsAt],
  );
  const month = await usage();
  assert.deepEqual(
    [month.kind, month.allowance, month.overdraft, month.periodStart, month.periodEnd],
    ["free", 2000, 0, opened.grant.activatedAt, renewsAt],
  );
  const grant = await x.db.prepare("SELECT offer_version AS version FROM starter_grants").first();
  assert.equal(grant.version, "free-2026-11-16");
  assert.deepEqual(await policy(), { plan: "free", days: 30, archive: false });
  // One server: a second needs a plan.
  await x.call(
    "user_alice",
    "POST",
    `/v1/accounts/${account.id}/servers`,
    { name: "Second", requestKey: randomUUID() },
    403,
  );

  // Message 2,001 in the month is refused; nothing overdraws.
  const send = await agent(x, account, server);
  await send();
  await x.control(`meter/report?server=${server.id}`);
  const spent = await x.control(`quota/history?account=${account.id}`, {
    serverId: server.id,
    count: 1999,
  });
  assert.deepEqual([(await spent.json()).status], ["exhausted"]);
  const exhausted = await state();
  assert.deepEqual([exhausted.status, exhausted.grant.remaining], ["exhausted", 0]);
  assert.equal((await send(true)).error.code, "message_allowance_exhausted");

  // The next calendar month opens 2,000 again, and nothing carries over.
  const next = later(renewsAt, 3_600_000);
  await quota({ at: next });
  await x.control(`meter/configure?server=${server.id}`, { at: next });
  await send();
  const renewed = await state();
  assert.equal(renewed.status, "active");
  assert.deepEqual(
    [renewed.grant.allowance, renewed.grant.used, renewed.grant.renewsAt],
    [2000, 1, nextMonth(renewsAt)],
  );
  const second = await usage();
  assert.deepEqual(
    [second.kind, second.periodStart, second.periodEnd, second.allowance],
    ["free", renewsAt, nextMonth(renewsAt), 2000],
  );
});

test("turning the switch on moves free-trial organizations to Free; they keep it if it is turned off; a plan replaces it", async (t) => {
  const stripe = provider();
  const { x, account, claim, state, usage, quota, policy } = await setup(t, {
    stripeHandler: stripe.handler,
  });
  const { server } = await claim();
  const send = await agent(x, account, server);
  await send();
  await x.control(`meter/report?server=${server.id}`);
  assert.equal((await usage()).kind, "starter");
  assert.deepEqual(await policy(), { plan: null, days: null, archive: false });

  // The switch turns on: the next read moves the organization to Free from now.
  await quota({ free: true });
  const moved = await state();
  assert.equal(moved.status, "active");
  assert.deepEqual(moved.free, { messages: 2000, servers: 1, historyDays: 30 });
  assert.equal(moved.grant.allowance, 2000);
  const month = await usage();
  assert.equal(month.kind, "free");
  assert.equal(month.allowance, 2000, "the trial's unused messages do not carry over");
  assert.equal(month.carriedOver, 0);
  assert.equal(month.periodEnd, nextMonth(month.periodStart));
  assert.equal(moved.grant.renewsAt, month.periodEnd);
  assert.deepEqual(await policy(), { plan: "free", days: 30, archive: false });
  await send();

  // Switched off again: an organization already on Free keeps renewing it.
  await quota({ free: false, at: later(month.periodEnd, 60_000) });
  const kept = await usage();
  assert.deepEqual([kept.kind, kept.periodStart], ["free", month.periodEnd]);

  // Buying Shop ends Free when the paid month starts; nothing carries over.
  await sleep(1100);
  const billing = `/v1/accounts/${account.id}/billing`;
  const input = { plan: "shop", requestKey: "upgrade" };
  await x.call("user_alice", "POST", `${billing}/checkout`, input);
  const payment = stripe.complete([...stripe.sessions.keys()][0], "paid");
  await x.call("user_alice", "POST", `${billing}/checkout`, input);
  await event(x, payment.session.customer);
  assert.equal((await x.control("sync")).status, 200);
  // Back to the present, just after the paid month started; the renewed Free month never counts.
  await quota({ at: later(new Date().toISOString(), 5000) });
  await x.control(`meter/report?server=${server.id}`);
  const paid = await x.call("user_alice", "GET", billing);
  assert.equal(paid.usage.kind, "paid");
  assert.equal(paid.usage.carriedOver, 0);
  assert.equal(paid.usage.allowance, paid.paidPeriod.allowance);
  assert.equal((await state()).status, "converted");
  await send();
});

test("the Free plan includes one person and a 2 GB file pool; the free trial keeps 4 people and 5 GB", async (t) => {
  const invite = (s, email, status) =>
    s.x.call("user_alice", "POST", `/v1/accounts/${s.account.id}/invitations`, { email }, status);
  const pool = async (s) => (await s.x.control(`storage?account=${s.account.id}`)).json();

  const free = await setup(t, { free: true });
  // Before a claim the organization is unpaid: Shop's people and the unpaid pool.
  assert.equal((await pool(free)).limitBytes, 5_000_000_000);
  await free.claim();
  const refused = await invite(free, "second@example.com", 409);
  assert.equal(refused.error.code, "people_limit_reached");
  assert.match(refused.error.message, /Free includes 1 person/);
  assert.equal((await pool(free)).limitBytes, 2_000_000_000);

  const trial = await setup(t);
  await trial.claim();
  await invite(trial, "second@example.com");
  assert.equal((await pool(trial)).limitBytes, 5_000_000_000);
});
