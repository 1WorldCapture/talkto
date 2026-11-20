import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/*
  Share links (docs/share-links-spec.md) on the real Worker, D1 and Durable Objects: attribution,
  self-referral refusals, the 50-messages-on-2-days rule, the 30-day window, the limit of 10 and
  bonuses that are added exactly once.
*/

const day = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

const setup = async (t, options = {}) => {
  const x = await start(t, {
    metering: true,
    starter: true,
    share: true,
    unpaidServers: 1,
    ...options,
  });
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
  /** A website request: sealed session cookie and the site's Origin, no bearer token. */
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
  /** A new organization with its free start (one starter server), owned by `user`. */
  const newcomer = async (user) => {
    const account = await x.call(user, "POST", "/v1/accounts", {
      name: "Team",
      requestKey: randomUUID(),
    });
    const claimed = await site(user, "POST", `/v1/accounts/${account.id}/starter`, {
      name: "Starter",
      requestKey: randomUUID(),
    });
    assert.equal(claimed.state.status, "active");
    return { account, server: claimed.server };
  };
  const state = (user, accountId) => site(user, "GET", `/v1/accounts/${accountId}/share`);
  const link = (user, accountId, status = 200) =>
    site(user, "POST", `/v1/accounts/${accountId}/share/link`, undefined, status);
  const join = (user, accountId, code) =>
    site(user, "POST", `/v1/accounts/${accountId}/share/join`, { code });
  const allowance = async (user, accountId) =>
    (await site(user, "GET", `/v1/accounts/${accountId}/starter`)).grant.allowance;
  /** Commit `count` metered messages on a server at a chosen time. */
  const spend = async (account, server, count, at) => {
    const configured = await x.raw(`/__control/meter/configure?server=${server.id}`, {
      method: "POST",
      body: JSON.stringify({ at: iso(at) }),
    });
    assert.equal(configured.status, 200);
    for (let index = 0; index < count; index++) {
      const spent = await (
        await x.raw(`/__control/meter/spend?server=${server.id}`, {
          method: "POST",
          body: JSON.stringify({ accountId: account.id, serverId: server.id, units: 1 }),
        })
      ).json();
      assert.equal(spent.ok, true, JSON.stringify(spent));
    }
  };
  /** Make every waiting referral due, then run the minute cron once. */
  const check = async () => {
    await x.db
      .prepare("UPDATE share_referrals SET next_check_at=? WHERE status='waiting'")
      .bind(iso(Date.now() - 1000))
      .run();
    await x.scheduled();
  };
  const referral = (accountId) =>
    x.db.prepare("SELECT * FROM share_referrals WHERE account_id=?").bind(accountId).first();
  const bonuses = (referralId) =>
    x.db
      .prepare("SELECT side,status FROM share_bonuses WHERE referral_id=? ORDER BY side")
      .bind(referralId)
      .all()
      .then((result) => result.results);
  /** The sharer's organization with its free start and its link. */
  const sharer = async (user = "user_sharer") => {
    const owned = await newcomer(user);
    const shared = await link(user, owned.account.id);
    assert.equal(shared.status, "available");
    return { ...owned, code: shared.link.code, url: shared.link.url };
  };
  return {
    x,
    site,
    newcomer,
    state,
    link,
    join,
    allowance,
    spend,
    check,
    referral,
    bonuses,
    sharer,
  };
};

test("off by default: no offer, no link, no join, and the cron reads nothing", async (t) => {
  const { x, newcomer, state, link, join } = await setup(t, { share: false });
  const offers = (await (await x.raw("/v1/offers")).json()).data;
  assert.equal("share" in offers, false, "the offers answer is unchanged while links are off");
  const { account } = await newcomer("user_sharer");
  assert.equal((await state("user_sharer", account.id)).status, "unavailable");
  const refused = await link("user_sharer", account.id, 403);
  assert.equal(refused.error.code, "forbidden");
  const answer = await join("user_sharer", account.id, "A".repeat(22));
  assert.deepEqual(answer, { joined: false, reason: "unavailable" });
  await x.scheduled();
  assert.equal(
    (await x.db.prepare("SELECT COUNT(*) AS n FROM share_links").first()).n,
    0,
    "nothing is written",
  );
});

test("a link is per organization owner, unguessable, and names nobody", async (t) => {
  const { x, newcomer, state, link } = await setup(t);
  const offers = (await (await x.raw("/v1/offers")).json()).data;
  assert.deepEqual(offers.share, {
    messages: 500,
    qualifyingMessages: 50,
    qualifyingDays: 2,
    windowDays: 30,
    sharerLimit: 10,
  });
  const spec = await (await x.raw("/openapi.json")).json();
  assert.ok(spec.paths["/v1/accounts/{accountId}/share"].get);
  assert.ok(spec.paths["/v1/accounts/{accountId}/share/link"].post);
  assert.ok(spec.paths["/v1/accounts/{accountId}/share/join"].post);
  const { account } = await newcomer("user_sharer");
  const before = await state("user_sharer", account.id);
  assert.equal(before.status, "available");
  assert.equal(before.link, null, "reading never creates a link");
  const first = await link("user_sharer", account.id);
  assert.match(first.link.code, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(first.link.url, `https://talkto.test/?ref=${first.link.code}`);
  assert.doesNotMatch(first.link.url, /sam|sharer|example|@/i, "the link reveals no email");
  const again = await link("user_sharer", account.id);
  assert.equal(again.link.code, first.link.code, "creating it again returns the same link");
  // A member who is not the owner has no link.
  const org = (await x.call("user_sharer", "GET", `/v1/accounts/${account.id}`)).organizationId;
  await x.control("member", x.member(org, "user_farmember"));
  await x.scheduled();
  assert.equal((await state("user_farmember", account.id)).status, "owner_only");
  const refused = await link("user_farmember", account.id, 403);
  assert.equal(refused.error.code, "forbidden");
  // Codes are random, not derived: another owner gets a different one.
  const other = await newcomer("user_farother");
  const theirs = await link("user_farother", other.account.id);
  assert.notEqual(theirs.link.code, first.link.code);
});

test("a new organization that joins with a link gets 500 more free messages at once", async (t) => {
  const { x, newcomer, state, join, allowance, sharer, referral, bonuses } = await setup(t);
  const shared = await sharer();
  const { account } = await newcomer("user_farfriend");
  assert.equal(await allowance("user_farfriend", account.id), 500);
  const answer = await join("user_farfriend", account.id, shared.code);
  assert.equal(answer.joined, true, JSON.stringify(answer));
  assert.equal(answer.state.joined.status, "added");
  assert.equal(await allowance("user_farfriend", account.id), 1000, "the free start grew by 500");
  const quota = await (await x.control(`quota?account=${account.id}`)).json();
  assert.deepEqual([quota.kind, quota.allowance, quota.bonus], ["starter", 1000, 500]);
  // The sharer's own allowance waits for qualification.
  assert.equal(await allowance("user_sharer", shared.account.id), 500);
  const row = await referral(account.id);
  assert.equal(row.status, "waiting");
  assert.equal(row.sharer_account_id, shared.account.id);
  assert.deepEqual(await bonuses(row.id), [{ side: "joined", status: "added" }]);
  // The sharer sees one plain line, naming nobody.
  const view = await state("user_sharer", shared.account.id);
  assert.equal(view.referrals.length, 1);
  assert.deepEqual(Object.keys(view.referrals[0]).sort(), [
    "bonus",
    "joinedAt",
    "settledAt",
    "status",
    "windowEndsAt",
  ]);
  assert.equal(view.referrals[0].status, "waiting");
  assert.equal(JSON.stringify(view).includes("farfriend"), false, "no name or email");
  // Joining again with the same code is the same answer and adds nothing.
  const repeated = await join("user_farfriend", account.id, shared.code);
  assert.equal(repeated.joined, true);
  assert.equal(await allowance("user_farfriend", account.id), 1000);
  // A second link is refused: an organization joins once.
  const another = await sharer("user_faranother");
  assert.deepEqual(await join("user_farfriend", account.id, another.code), {
    joined: false,
    reason: "already_joined",
  });
});

test("joins are refused for self-referrals, unknown codes and organizations that are not new", async (t) => {
  const { x, newcomer, join, sharer, allowance } = await setup(t);
  const shared = await sharer();
  // The sharer's own organization, and a second organization of the same person.
  assert.deepEqual(await join("user_sharer", shared.account.id, shared.code), {
    joined: false,
    reason: "own_link",
  });
  const second = await x.call("user_sharer", "POST", "/v1/accounts", {
    name: "Second",
    requestKey: randomUUID(),
  });
  assert.deepEqual(await join("user_sharer", second.id, shared.code), {
    joined: false,
    reason: "own_link",
  });
  // A colleague at the same company domain.
  const colleague = await newcomer("user_colleague");
  assert.deepEqual(await join("user_colleague", colleague.account.id, shared.code), {
    joined: false,
    reason: "own_link",
  });
  assert.equal(await allowance("user_colleague", colleague.account.id), 500);
  // A member of the sharer's organization, at another domain.
  const org = (await x.call("user_sharer", "GET", `/v1/accounts/${shared.account.id}`))
    .organizationId;
  await x.control("member", x.member(org, "user_farmember"));
  await x.scheduled();
  const member = await newcomer("user_farmember");
  assert.deepEqual(await join("user_farmember", member.account.id, shared.code), {
    joined: false,
    reason: "own_link",
  });
  // An unknown code, and a caller who does not own the organization.
  const stranger = await newcomer("user_farstranger");
  assert.deepEqual(await join("user_farstranger", stranger.account.id, "B".repeat(22)), {
    joined: false,
    reason: "unknown_code",
  });
  const strangerOrg = (
    await x.call("user_farstranger", "GET", `/v1/accounts/${stranger.account.id}`)
  ).organizationId;
  await x.control("member", x.member(strangerOrg, "user_farhelper"));
  await x.scheduled();
  assert.deepEqual(await join("user_farhelper", stranger.account.id, shared.code), {
    joined: false,
    reason: "not_owner",
  });
  // No free start, or one claimed more than 7 days ago, is not a new sign-up.
  const late = await x.call("user_farlate", "POST", "/v1/accounts", {
    name: "Late",
    requestKey: randomUUID(),
  });
  assert.deepEqual(await join("user_farlate", late.id, shared.code), {
    joined: false,
    reason: "not_new",
  });
  await x.db
    .prepare("UPDATE starter_grants SET reserved_at=? WHERE account_id=?")
    .bind(iso(Date.now() - 8 * day), stranger.account.id)
    .run();
  assert.deepEqual(await join("user_farstranger", stranger.account.id, shared.code), {
    joined: false,
    reason: "not_new",
  });
  assert.equal(
    (await x.db.prepare("SELECT COUNT(*) AS n FROM share_referrals").first()).n,
    0,
    "no refusal records anything",
  );
});

test("people at a public mail domain may share with each other", async (t) => {
  const { newcomer, join, sharer } = await setup(t);
  const shared = await sharer("user_gmailann");
  const { account } = await newcomer("user_gmailbea");
  const answer = await join("user_gmailbea", account.id, shared.code);
  assert.equal(answer.joined, true, JSON.stringify(answer));
});

test("the sharer's 500 waits for 50 agent messages on 2 different days, then is added once", async (t) => {
  const { x, newcomer, join, sharer, allowance, spend, check, referral, bonuses, state } =
    await setup(t);
  const shared = await sharer();
  const { account, server } = await newcomer("user_farfriend");
  await join("user_farfriend", account.id, shared.code);
  const now = Date.now();
  // Real agent messages over MCP count; a person's messages are never metered.
  const credential = await x.mcpToken(account.organizationId, "user_farfriend");
  const registered = await x.mcp(credential, "register_participant", {
    serverId: server.id,
    name: "builder",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  for (let index = 0; index < 10; index++)
    await x.mcp(credential, "send_message", {
      serverId: server.id,
      participantId: registered.data.item.id,
      target: { kind: "conversation", conversationId: registered.data.generalConversationId },
      body: `Progress ${index}`,
      requestKey: randomUUID(),
    });
  // 60 messages on one day: enough messages, one day.
  await spend(account, server, 50, now + 60_000);
  await check();
  assert.equal((await referral(account.id)).status, "waiting");
  assert.equal(await allowance("user_sharer", shared.account.id), 500);
  // A second day qualifies it.
  await spend(account, server, 1, now + day);
  await check();
  const row = await referral(account.id);
  assert.equal(row.status, "qualified");
  assert.deepEqual(await bonuses(row.id), [
    { side: "joined", status: "added" },
    { side: "sharer", status: "added" },
  ]);
  assert.equal(await allowance("user_sharer", shared.account.id), 1000);
  const view = await state("user_sharer", shared.account.id);
  assert.equal(view.referrals[0].status, "qualified");
  assert.equal(view.referrals[0].bonus.status, "added");
  // Retries never add twice: more cron runs, and a bonus whose answer was lost.
  await check();
  await x.scheduled();
  await x.db
    .prepare("UPDATE share_bonuses SET status='pending',applied_at=NULL WHERE referral_id=?")
    .bind(row.id)
    .run();
  await x.scheduled();
  assert.deepEqual(await bonuses(row.id), [
    { side: "joined", status: "added" },
    { side: "sharer", status: "added" },
  ]);
  assert.equal(await allowance("user_sharer", shared.account.id), 1000);
  assert.equal(await allowance("user_farfriend", account.id), 1000);
});

test("49 messages on two days do not qualify; the 50th does", async (t) => {
  const { newcomer, join, sharer, spend, check, referral, allowance } = await setup(t);
  const shared = await sharer();
  const { account, server } = await newcomer("user_farfriend");
  await join("user_farfriend", account.id, shared.code);
  const now = Date.now();
  await spend(account, server, 25, now + 60_000);
  await spend(account, server, 24, now + day);
  await check();
  assert.equal((await referral(account.id)).status, "waiting");
  await spend(account, server, 1, now + 2 * day);
  await check();
  assert.equal((await referral(account.id)).status, "qualified");
  assert.equal(await allowance("user_sharer", shared.account.id), 1000);
});

test("only messages within 30 days of sign-up count, and the referral ends after the window", async (t) => {
  const { x, newcomer, join, sharer, spend, check, referral, allowance, state } = await setup(t);
  const shared = await sharer();
  const { account, server } = await newcomer("user_farfriend");
  await join("user_farfriend", account.id, shared.code);
  const now = Date.now();
  await spend(account, server, 30, now + 60_000);
  // These would qualify it, but they come 31 days after sign-up.
  await spend(account, server, 30, now + 31 * day);
  await check();
  const waiting = await referral(account.id);
  assert.equal(waiting.status, "waiting");
  assert.ok(waiting.next_check_at <= waiting.window_end, "the last check is at the window's end");
  // The window closes: one last check ends it.
  await x.db
    .prepare("UPDATE share_referrals SET window_end=? WHERE id=?")
    .bind(iso(Date.now() + 1000), waiting.id)
    .run();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await check();
  assert.equal((await referral(account.id)).status, "expired");
  assert.equal(await allowance("user_sharer", shared.account.id), 500);
  assert.equal((await state("user_sharer", shared.account.id)).referrals[0].status, "expired");
});

test("a person receives the sharer's messages at most 10 times, and a full link stops joining", async (t) => {
  const { x, newcomer, join, sharer, spend, check, referral, allowance, state } = await setup(t);
  const shared = await sharer();
  // Eight earlier bonuses on record for this person (their referrals need not be real).
  for (let index = 0; index < 8; index++) {
    const id = randomUUID();
    await x.db
      .prepare(
        `INSERT INTO share_referrals(id,code,sharer_account_id,sharer_owner_id,account_id,owner_id,joined_at,window_start,window_end,status,next_check_at)
         VALUES(?,?,?,?,?,?,?,?,?,'qualified',?)`,
      )
      .bind(
        id,
        shared.code,
        shared.account.id,
        "user_sharer",
        randomUUID(),
        `user_past${index}`,
        iso(Date.now() - day),
        iso(Date.now() - day),
        iso(Date.now() + 29 * day),
        iso(Date.now()),
      )
      .run();
    await x.db
      .prepare(
        "INSERT INTO share_bonuses(referral_id,side,account_id,owner_id,messages,status,created_at) VALUES(?,'sharer',?,'user_sharer',500,'added',?)",
      )
      .bind(id, shared.account.id, iso(Date.now()))
      .run();
  }
  // Three new organizations join while the person has eight; all three qualify.
  const joined = [];
  for (const user of ["user_farone", "user_fartwo", "user_farthree"]) {
    const value = await newcomer(user);
    assert.equal((await join(user, value.account.id, shared.code)).joined, true);
    joined.push(value);
  }
  const now = Date.now();
  for (const { account, server } of joined) {
    await spend(account, server, 25, now + 60_000);
    await spend(account, server, 25, now + day);
  }
  await check();
  const statuses = await Promise.all(joined.map(({ account }) => referral(account.id)));
  assert.deepEqual(statuses.map((row) => row.status).sort(), ["capped", "qualified", "qualified"]);
  assert.equal(
    (
      await x.db
        .prepare("SELECT COUNT(*) AS n FROM share_bonuses WHERE side='sharer' AND owner_id=?")
        .bind("user_sharer")
        .first()
    ).n,
    10,
  );
  // Two of the three were added to this organization's own free start; none beyond that.
  assert.equal(await allowance("user_sharer", shared.account.id), 1500);
  const view = await state("user_sharer", shared.account.id);
  assert.equal(view.exhausted, true);
  // A full link stops attaching new sign-ups; the new person gets nothing from it.
  const late = await newcomer("user_farlate");
  assert.deepEqual(await join("user_farlate", late.account.id, shared.code), {
    joined: false,
    reason: "link_full",
  });
  assert.equal(await allowance("user_farlate", late.account.id), 500);
});

test("a recorded dispute on either organization excludes the referral", async (t) => {
  const { x, newcomer, join, sharer, spend, check, referral, allowance } = await setup(t);
  const shared = await sharer();
  const { account, server } = await newcomer("user_farfriend");
  await join("user_farfriend", account.id, shared.code);
  await x.db
    .prepare(
      "INSERT INTO workspace_billing(account_id,provider_scope,customer_id) VALUES(?,'acct_talkto:test:test','cus_friend')",
    )
    .bind(account.id)
    .run();
  await x.db
    .prepare(
      "INSERT INTO billing_revocations(charge_id,account_id,invoice_id,reason,status,revoked_at,updated_at) VALUES('ch_disputed',?,'in_1','dispute','active',?,?)",
    )
    .bind(account.id, iso(Date.now()), iso(Date.now()))
    .run();
  const now = Date.now();
  await spend(account, server, 25, now + 60_000);
  await spend(account, server, 25, now + day);
  await check();
  const row = await referral(account.id);
  assert.deepEqual([row.status, row.reason], ["excluded", "flagged"]);
  assert.equal(await allowance("user_sharer", shared.account.id), 500);
});

test("on a paid plan the sharer's messages are recorded, not added; free messages still carry over", async (t) => {
  const { x, newcomer, join, sharer, spend, check, referral, bonuses, state } = await setup(t);
  const shared = await sharer();
  const { account, server } = await newcomer("user_farfriend");
  await join("user_farfriend", account.id, shared.code);
  // The joined organization pays: its 500 + 500 free messages carry into the first paid period.
  const start = new Date(Date.now() + 1000).toISOString();
  const published = await (
    await x.raw(`/__control/quota/publish?account=${account.id}`, {
      method: "POST",
      body: JSON.stringify({
        accountId: account.id,
        start,
        end: new Date(Date.now() + 30 * day).toISOString(),
        allowance: 40000,
        overdraft: 500,
      }),
    })
  ).json();
  assert.equal(published.ok, true);
  // The sharer pays too, before the referral qualifies.
  const sharerPaid = await (
    await x.raw(`/__control/quota/publish?account=${shared.account.id}`, {
      method: "POST",
      body: JSON.stringify({
        accountId: shared.account.id,
        start,
        end: new Date(Date.now() + 30 * day).toISOString(),
        allowance: 40000,
        overdraft: 500,
      }),
    })
  ).json();
  assert.equal(sharerPaid.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const paid = await (await x.control(`quota?account=${account.id}`)).json();
  assert.equal(paid.kind, "paid");
  assert.equal(paid.carriedOver, 1000, "the share messages carry over with the free trial's");
  const now = Date.now();
  await spend(account, server, 25, now + 60_000);
  await spend(account, server, 25, now + day);
  await check();
  const row = await referral(account.id);
  assert.equal(row.status, "qualified");
  assert.deepEqual(await bonuses(row.id), [
    { side: "joined", status: "added" },
    { side: "sharer", status: "not_added" },
  ]);
  const sharerQuota = await (await x.control(`quota?account=${shared.account.id}`)).json();
  // The plan plus the sharer's own unused free trial, carried over; nothing from the share.
  assert.deepEqual(
    [sharerQuota.allowance, sharerQuota.carriedOver, sharerQuota.bonus],
    [40500, 500, undefined],
    "a paid plan gets no extra messages",
  );
  const view = await state("user_sharer", shared.account.id);
  assert.equal(view.free, false);
  assert.equal(view.referrals[0].bonus.status, "not_added");
});

test("the quota authority adds a bonus ID once and only to a free allowance", async (t) => {
  const { x, newcomer } = await setup(t);
  const { account } = await newcomer("user_farsolo");
  const bonus = (id) =>
    x
      .raw(`/__control/quota/bonus?account=${account.id}`, {
        method: "POST",
        body: JSON.stringify({ accountId: account.id, id, messages: 500 }),
      })
      .then((response) => response.json());
  assert.deepEqual(await bonus("share:test:joined"), { outcome: "added" });
  assert.deepEqual(await bonus("share:test:joined"), { outcome: "added" }, "a replay");
  let quota = await (await x.control(`quota?account=${account.id}`)).json();
  assert.equal(quota.allowance, 1000, "added once");
  assert.deepEqual(await bonus("share:other:joined"), { outcome: "added" });
  quota = await (await x.control(`quota?account=${account.id}`)).json();
  assert.equal(quota.allowance, 1500);
  // An organization that never opened an allowance records nothing, so it can be asked again.
  const empty = await x.call("user_farempty", "POST", "/v1/accounts", {
    name: "Empty",
    requestKey: randomUUID(),
  });
  const none = await (
    await x.raw(`/__control/quota/bonus?account=${empty.id}`, {
      method: "POST",
      body: JSON.stringify({ accountId: empty.id, id: "share:empty:joined", messages: 500 }),
    })
  ).json();
  assert.deepEqual(none, { outcome: "no_period" });
});
