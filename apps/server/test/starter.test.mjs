import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { concurrently, start } from "./platform-harness.mjs";
import { event, provider } from "./billing-provider.mjs";
import { plans } from "@talkto/api/pricing";

/** The free start's real Worker/D1/DO path, claimed through the website session. */
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
  /** A website request: sealed session cookie and the site's Origin, no bearer token. */
  const site = async (user, method, path, value, status = 200, headers = {}) => {
    const response = await x.raw(path, {
      method,
      headers: {
        cookie: await cookie(user),
        origin: "https://talkto.test",
        "content-type": "application/json",
        ...headers,
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result.data ?? result;
  };
  const organization = (user = "user_alice") =>
    x.call(user, "POST", "/v1/accounts", { name: "Team", requestKey: randomUUID() });
  const claim = (user, accountId, input = {}, status = 200, headers = {}) =>
    site(
      user,
      "POST",
      `/v1/accounts/${accountId}/starter`,
      { name: "Starter", requestKey: randomUUID(), ...input },
      status,
      headers,
    );
  const state = (user, accountId) => site(user, "GET", `/v1/accounts/${accountId}/starter`);
  const count = async (table) =>
    (await x.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
  /** One claim's HTTP status, without asserting which racer wins. */
  const attempt = async (user, accountId) =>
    (
      await x.raw(`/v1/accounts/${accountId}/starter`, {
        method: "POST",
        headers: {
          cookie: await cookie(user),
          origin: "https://talkto.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Starter", requestKey: randomUUID() }),
      })
    ).status;
  return { x, site, organization, claim, state, count, attempt };
};

/** Register one agent and return a sender that commits real messages over MCP. */
const agent = async (x, account, server, name = "starter-agent") => {
  const credential = await x.mcpToken(account.organizationId);
  const registered = await x.mcp(credential, "register_participant", {
    serverId: server.id,
    name,
    agentType: "codex",
    requestKey: randomUUID(),
  });
  const base = {
    serverId: server.id,
    participantId: registered.data.item.id,
    target: { kind: "conversation", conversationId: registered.data.generalConversationId },
    body: "Free start message",
  };
  return {
    credential,
    conversationId: registered.data.generalConversationId,
    send: (requestKey = randomUUID(), error = false) =>
      x.mcp(credential, "send_message", { ...base, requestKey }, error),
  };
};

test("with the switch off nothing is offered and first servers are created as before", async (t) => {
  const { x, site, organization, claim, state, count } = await setup(t, { starter: false });
  assert.deepEqual((await (await x.raw("/v1/offers")).json()).data, {
    starter: null,
  });
  const eligibility = await site("user_alice", "GET", "/v1/starter");
  assert.equal(eligibility.offer, null);
  assert.equal(eligibility.status, "unavailable");
  const account = await organization();
  assert.equal((await state("user_alice", account.id)).status, "unavailable");
  const denied = await claim("user_alice", account.id, {}, 409);
  assert.equal(denied.error.code, "starter_unavailable");
  const server = await x.server(account.id);
  assert.equal(server.status, "ready");
  assert.equal(await count("starter_grants"), 0);
  const usage = await (await x.control(`quota?account=${account.id}`)).json();
  assert.equal(usage.status, "payment_required", "an ordinary unpaid server opens no messages");
});

test("the website claim opens 500 nonexpiring messages on one starter server and retries resume it", async (t) => {
  const { x, site, organization, claim, state, count } = await setup(t);
  assert.deepEqual((await (await x.raw("/v1/offers")).json()).data, {
    starter: { messages: 500, servers: 1 },
  });
  // API tokens never claim; the website session does.
  assert.equal((await x.call("user_alice", "GET", "/v1/starter")).status, "sign_in_required");
  const before = await site("user_alice", "GET", "/v1/starter");
  assert.deepEqual([before.status, before.offer], ["eligible", { messages: 500, servers: 1 }]);
  const account = await organization();
  const bearer = await x.call(
    "user_alice",
    "POST",
    `/v1/accounts/${account.id}/starter`,
    { name: "Starter", requestKey: randomUUID() },
    409,
  );
  assert.equal(bearer.error.code, "starter_unavailable");
  const input = { name: "Product studio", requestKey: "first-server" };
  const first = await claim("user_alice", account.id, input);
  assert.equal(first.server.status, "ready");
  assert.equal(first.server.name, "Product studio");
  assert.equal(first.state.status, "active");
  assert.deepEqual(
    [first.state.grant.allowance, first.state.grant.used, first.state.grant.remaining],
    [500, 0, 500],
  );
  assert.equal(first.state.grant.serverId, first.server.id);
  const usage = await (await x.control(`quota?account=${account.id}`)).json();
  assert.deepEqual(
    [usage.kind, usage.allowance, usage.overdraft, usage.periodEnd],
    ["starter", 500, 0, null],
  );
  // Same key, another key, another tab: one grant, one server.
  assert.equal((await claim("user_alice", account.id, input)).server.id, first.server.id);
  assert.equal((await claim("user_alice", account.id)).server.id, first.server.id);
  assert.equal(await count("starter_grants"), 1);
  assert.equal(await count("servers"), 1);
  await x.call(
    "user_alice",
    "POST",
    `/v1/accounts/${account.id}/servers`,
    { name: "Second", requestKey: randomUUID() },
    403,
  );
  // Days, months and years pass: the allowance neither expires nor refills.
  const sender = await agent(x, account, first.server);
  await sender.send();
  for (const at of ["2027-01-01T00:00:00.000Z", "2031-06-30T12:00:00.000Z"]) {
    await x.control(`quota/configure?account=${account.id}`, { at });
    await x.control(`meter/configure?server=${first.server.id}`, { at });
    await sender.send();
  }
  const later = await state("user_alice", account.id);
  assert.equal(later.status, "active");
  assert.deepEqual([later.grant.used, later.grant.remaining], [3, 497]);
});

// 500 real metered sends, each a full CPU-bound round trip: 46 s on a boat machine losing 40% of its
// CPU to steal while the server and web suites ran together, and over 60 s before they were sent
// eight at a time.
const fiveHundredSends = { timeout: 180_000 };
test(
  "message 501 is refused across agents, retries count once and history stays readable",
  fiveHundredSends,
  async (t) => {
    const { x, organization, claim, state } = await setup(t);
    const account = await organization();
    const { server } = await claim("user_alice", account.id);
    const builder = await agent(x, account, server, "builder");
    const reviewer = await agent(x, account, server, "reviewer");
    const firstKey = randomUUID();
    // 500 real sends from two agents, eight in flight.
    await concurrently(500, 8, (i) =>
      (i % 2 === 0 ? builder : reviewer).send(i === 0 ? firstKey : randomUUID()),
    );
    // Exact before the server reports: unreported block usage is counted too.
    const spent = await state("user_alice", account.id);
    assert.equal(spent.status, "exhausted");
    assert.deepEqual([spent.grant.used, spent.grant.remaining], [500, 0]);
    assert.equal(
      (await reviewer.send(randomUUID(), true)).error.code,
      "message_allowance_exhausted",
    );
    assert.equal((await builder.send(firstKey)).data.created, false, "a retry counts once");
    assert.equal((await x.control(`meter/report?server=${server.id}`)).status, 200);
    const usage = await (await x.control(`quota?account=${account.id}`)).json();
    assert.deepEqual([usage.used, usage.status], [500, "exhausted"]);
    const history = await x.call(
      "user_alice",
      "GET",
      `/v1/servers/${server.id}/conversations/${builder.conversationId}/messages`,
    );
    assert.ok(history.items.length > 0, "authorized reads continue after the cap");
  },
);

test("a +tag never makes another inbox, and claims keyed by earlier rules still count", async (t) => {
  const { x, site, organization, claim } = await setup(t, { unpaidServers: 10 });
  const tagged = await organization("user_tagone");
  await claim("user_tagone", tagged.id);
  // Any domain: case and the +tag are ignored for eligibility only.
  assert.equal((await site("user_tagbare", "GET", "/v1/starter")).status, "used");
  assert.equal((await site("user_tagtwo", "GET", "/v1/starter")).status, "used");
  const other = await organization("user_tagtwo");
  assert.equal((await claim("user_tagtwo", other.id, {}, 409)).error.code, "starter_unavailable");
  const hmac = (secret, value) => createHmac("sha256", secret).update(value).digest("hex");
  // A free-start claim recorded before November 16 kept the tag in its inbox key.
  await x.db
    .prepare("INSERT INTO starter_claims(namespace,kind,key,grant_id,created_at) VALUES(?,?,?,?,?)")
    .bind(
      "workos:client_test",
      "inbox",
      hmac(
        "test-only-starter-claim-secret-at-least-32-chars",
        "starter-inbox:v1:workos:client_test:lee+old@example.com",
      ),
      randomUUID(),
      new Date().toISOString(),
    )
    .run();
  assert.equal((await site("user_legacytag", "GET", "/v1/starter")).status, "used");
  // Card trials: the earlier lowercased-address key and the new inbox key both count.
  const trialSecret = "test-only-stable-claim-secret-at-least-32-characters";
  for (const [owner, address] of [
    ["user_oldtrial", "kim+trial@example.com"],
    ["user_newtrial", "pat@example.com"],
  ])
    await x.db
      .prepare(
        "INSERT INTO billing_trials(account_id,provider_scope,owner_id,email_key,claimed_at) VALUES(?,?,?,?,?)",
      )
      .bind(
        randomUUID(),
        "acct_talkto:test:test",
        owner,
        hmac(trialSecret, `acct_talkto:test:test:email:${address}`),
        Date.now(),
      )
      .run();
  assert.equal((await site("user_trialtag", "GET", "/v1/starter")).status, "used");
  assert.equal((await site("user_trialcanonical", "GET", "/v1/starter")).status, "used");
});

test("eligibility survives new organizations, deletion, recreated identities, inbox aliases and invitations", async (t) => {
  const { x, site, organization, claim, state, count } = await setup(t, { unpaidServers: 10 });
  const account = await organization();
  const { server } = await claim("user_alice", account.id);
  // A second organization for the same owner gets no second allowance.
  const other = await organization();
  assert.equal((await state("user_alice", other.id)).status, "used");
  assert.equal((await claim("user_alice", other.id, {}, 409)).error.code, "starter_unavailable");
  assert.equal((await site("user_alice", "GET", "/v1/starter")).status, "used");
  // Deleting the starter server keeps the grant; a replacement spends the same credit.
  await x.call("user_alice", "POST", `/v1/accounts/${account.id}/servers/${server.id}/delete`, {
    confirmation: "Starter",
  });
  const replacement = await claim("user_alice", account.id);
  assert.notEqual(replacement.server.id, server.id);
  assert.equal(replacement.state.status, "active");
  assert.equal(await count("starter_grants"), 1);
  // A new identity with the same verified inbox, and Gmail spellings of one inbox.
  assert.equal((await site("user_recreated", "GET", "/v1/starter")).status, "used");
  const jane = await organization("user_gmaildots");
  await claim("user_gmaildots", jane.id);
  assert.equal((await site("user_gmailplus", "GET", "/v1/starter")).status, "used");
  // Dots fold only for Gmail: jane.doe@example.com is another inbox.
  assert.equal((await site("user_companyplus", "GET", "/v1/starter")).status, "eligible");
  // A card-trial owner already had their free allowance.
  await x.db
    .prepare(
      "INSERT INTO billing_trials(account_id,provider_scope,owner_id,email_key,claimed_at) VALUES(?,?,?,?,?)",
    )
    .bind(randomUUID(), "acct_talkto:test:test", "user_carol", "f".repeat(64), Date.now())
    .run();
  assert.equal((await site("user_carol", "GET", "/v1/starter")).status, "used");
  // An invited member uses the organization's allowance and cannot claim another for it.
  await x.control("member", x.member(account.organizationId, "user_bob"));
  const shared = await state("user_bob", account.id);
  assert.deepEqual([shared.status, shared.grant.allowance], ["active", 500]);
  assert.equal((await claim("user_bob", account.id, {}, 403)).error.code, "forbidden");
  await x.call(
    "user_bob",
    "POST",
    `/v1/accounts/${account.id}/servers`,
    { name: "Member server", requestKey: randomUUID() },
    403,
  );
  // That member is still a different person with an allowance of their own.
  const own = await organization("user_bob");
  assert.equal((await claim("user_bob", own.id)).state.status, "active");
  const unverified = await organization("user_unverified");
  assert.equal((await state("user_unverified", unverified.id)).status, "verify_email");
  const rows = await x.db.prepare("SELECT kind,key FROM starter_claims WHERE kind='inbox'").all();
  for (const row of rows.results) assert.match(row.key, /^[a-f0-9]{64}$/);
});

test("concurrent claims create one grant and one server; admission caps hold under races", async (t) => {
  const { x, organization, claim, state, count, attempt } = await setup(t, {
    unpaidServers: 10,
    starterDailyLimit: 2,
    starterCohortLimit: 3,
  });
  const account = await organization();
  const outcomes = await Promise.all(
    Array.from({ length: 4 }, () => claim("user_alice", account.id)),
  );
  assert.equal(new Set(outcomes.map((o) => o.server.id)).size, 1);
  assert.equal(await count("starter_grants"), 1);
  const servers = await x.db
    .prepare("SELECT COUNT(*) AS n FROM servers WHERE account_id=?")
    .bind(account.id)
    .first();
  assert.equal(servers.n, 1);
  // One more admission fits today; three people race for it and exactly one wins.
  const people = ["user_dave", "user_erin", "user_frank"];
  const accounts = await Promise.all(people.map((user) => organization(user)));
  const raced = await Promise.all(people.map((user, i) => attempt(user, accounts[i].id)));
  assert.deepEqual([...raced].sort(), [200, 409, 409]);
  assert.equal(await count("starter_grants"), 2);
  const loser = raced.indexOf(409);
  assert.equal((await state(people[loser], accounts[loser].id)).status, "paused");
  // Pausing new admissions never stops an existing grant from resuming.
  assert.equal((await claim("user_alice", account.id)).state.status, "active");
});

test("one person racing claims in two organizations receives one allowance", async (t) => {
  const { organization, attempt, count } = await setup(t, { unpaidServers: 10 });
  const first = await organization("user_gina");
  const second = await organization("user_gina");
  const raced = await Promise.all([
    attempt("user_gina", first.id),
    attempt("user_gina", second.id),
  ]);
  assert.deepEqual([...raced].sort(), [200, 409]);
  assert.equal(await count("starter_grants"), 1);
  assert.equal(await count("starter_claims WHERE kind='owner'"), 1);
});

/** Buy Shop through the fake Stripe. `open` leaves the first invoice unpaid, as a declined card does. */
const buy = async (x, stripe, account, status = "paid") => {
  const billing = `/v1/accounts/${account.id}/billing`;
  // Stripe periods start on whole seconds; buy after the starter's activation second.
  await sleep(1100);
  const input = { plan: "shop", requestKey: "upgrade" };
  await x.call("user_alice", "POST", `${billing}/checkout`, input);
  const payment = stripe.complete([...stripe.sessions.keys()][0], status);
  await x.call("user_alice", "POST", `${billing}/checkout`, input);
  return payment;
};
const billingState = (x, account) =>
  x.call("user_alice", "GET", `/v1/accounts/${account.id}/billing`);
/** Close the server's held block so the quota authority settles it. */
const report = async (x, server) =>
  assert.equal((await x.control(`meter/report?server=${server.id}`)).status, 200);

test("a declined payment adds nothing; the first paid period carries the unused free messages once", async (t) => {
  const stripe = provider();
  const { x, organization, claim, state } = await setup(t, { stripeHandler: stripe.handler });
  const account = await organization();
  const { server } = await claim("user_alice", account.id);
  const sender = await agent(x, account, server);
  for (let i = 0; i < 40; i++) await sender.send();
  assert.equal((await billingState(x, account)).trialAvailable, false);
  const left = (await state("user_alice", account.id)).grant.remaining;
  assert.equal(left, 460);

  // A declined first invoice: no paid period, no carried messages, the free start unchanged.
  const payment = await buy(x, stripe, account, "open");
  await event(x, payment.session.customer, { type: "invoice.payment_failed" });
  assert.equal((await x.control("sync")).status, 200);
  const declined = await billingState(x, account);
  assert.equal(declined.paidPeriod, null);
  assert.equal(declined.usage.kind, "starter");
  assert.equal(declined.usage.allowance, 500);
  assert.equal(declined.usage.carriedOver, 0, "a failed payment carries nothing");
  const unchanged = await state("user_alice", account.id);
  assert.deepEqual([unchanged.status, unchanged.grant.remaining], ["active", left]);

  // Payment succeeds. The same event delivered twice and a later one settle one period.
  payment.invoice.status = "paid";
  payment.subscription.status = "active";
  const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
  assert.equal((await event(x, payment.session.customer, { id: eventId })).status, 200);
  assert.equal((await event(x, payment.session.customer, { id: eventId })).status, 200);
  assert.equal((await x.control("sync")).status, 200);
  // The block the server held when it converted hands its unused part over once it closes.
  await report(x, server);
  const paid = await billingState(x, account);
  assert.equal(paid.paidPeriod.allowance, plans.shop.messages);
  assert.equal(paid.issue, null);
  assert.equal(paid.usage.kind, "paid");
  assert.equal(paid.usage.carriedOver, left, "every unused free message carries over");
  assert.equal(paid.usage.allowance, paid.paidPeriod.allowance + left);
  const converted = await state("user_alice", account.id);
  assert.equal(converted.status, "converted");
  assert.equal(converted.grant.serverId, server.id);

  // Delayed and duplicate deliveries, and a replay of the same period, never add it again.
  await event(x, payment.session.customer);
  await event(x, payment.session.customer, { id: eventId });
  assert.equal((await x.control("sync")).status, 200);
  const replay = await x.control(`quota/publish?account=${account.id}`, {
    accountId: account.id,
    start: paid.usage.periodStart,
    end: paid.usage.periodEnd,
    allowance: paid.usage.allowance - left,
    overdraft: paid.usage.overdraft,
    kind: "paid",
  });
  assert.equal((await replay.json()).ok, true, "an identical replay is idempotent");
  const starterReplay = await x.control(`quota/publish?account=${account.id}`, {
    accountId: account.id,
    start: converted.grant.activatedAt,
    end: null,
    allowance: 500,
    overdraft: 0,
    kind: "starter",
  });
  assert.equal(
    (await starterReplay.json()).ok,
    true,
    "an identical starter replay changes nothing",
  );
  await report(x, server);
  const again = await billingState(x, account);
  assert.equal(again.usage.carriedOver, left);
  assert.equal(again.usage.allowance, paid.usage.allowance);
  assert.equal(
    (await x.db.prepare("SELECT COUNT(*) AS n FROM billing_periods").first()).n,
    1,
    "one paid period",
  );

  // The same server and agent keep sending on the paid allowance.
  for (let i = 0; i < 40; i++) await sender.send();
  await report(x, server);
  const after = await billingState(x, account);
  assert.equal(after.usage.kind, "paid");
  assert.equal(after.usage.used, 40);
  assert.equal(after.usage.carriedOver, left);
  assert.equal((await state("user_alice", account.id)).status, "converted");
  assert.equal((await x.call("user_alice", "GET", `/v1/accounts/${account.id}`)).id, account.id);
  assert.equal(
    (await x.call("user_alice", "GET", `/v1/accounts/${account.id}/servers/${server.id}`)).id,
    server.id,
  );
});

test("an exhausted free start carries over nothing", async (t) => {
  const stripe = provider();
  const { x, organization, claim, state } = await setup(t, { stripeHandler: stripe.handler });
  const account = await organization();
  const { server } = await claim("user_alice", account.id);
  const spent = await x.control(`quota/history?account=${account.id}`, {
    serverId: server.id,
    count: 500,
  });
  assert.equal((await spent.json()).status, "exhausted");
  assert.equal((await state("user_alice", account.id)).status, "exhausted");
  await buy(x, stripe, account);
  const paid = await billingState(x, account);
  assert.equal(paid.usage.kind, "paid");
  assert.equal(paid.usage.carriedOver, 0);
  assert.equal(paid.usage.allowance, paid.paidPeriod.allowance);
  assert.equal((await state("user_alice", account.id)).status, "converted");
});

test("cancellation never restores the free start or carries its messages again", async (t) => {
  const stripe = provider();
  const { x, site, organization, claim, state } = await setup(t, {
    stripeHandler: stripe.handler,
  });
  const account = await organization();
  const { server } = await claim("user_alice", account.id);
  const sender = await agent(x, account, server);
  for (let i = 0; i < 10; i++) await sender.send();
  const payment = await buy(x, stripe, account);
  await report(x, server);
  const paid = await billingState(x, account);
  assert.equal(paid.usage.carriedOver, 490);
  // Stripe ends the subscription; the period it paid for runs to its end.
  payment.subscription.status = "canceled";
  await event(x, payment.session.customer, { type: "customer.subscription.deleted" });
  assert.equal((await x.control("sync")).status, 200);
  const canceled = await billingState(x, account);
  assert.equal(canceled.usage.carriedOver, 490);
  assert.equal(canceled.usage.allowance, paid.usage.allowance);
  assert.equal((await state("user_alice", account.id)).status, "converted");
  // After the paid period ends nothing is left: the free start does not reopen.
  const quota = (path, value) => x.control(`quota/${path}?account=${account.id}`, value);
  const later = new Date(Date.parse(paid.usage.periodEnd) + 1000).toISOString();
  await quota("configure", { at: later });
  const ended = await (await quota("")).json();
  assert.deepEqual([ended.status, ended.available, ended.kind], ["payment_required", 0, "paid"]);
  const reopen = await quota("publish", {
    accountId: account.id,
    start: later,
    end: null,
    allowance: 500,
    overdraft: 0,
    kind: "starter",
  });
  assert.equal((await reopen.json()).ok, false, "a new free start is refused");
  assert.equal((await state("user_alice", account.id)).status, "converted");
  // The grant cannot be claimed again, here or in another organization.
  assert.equal((await site("user_alice", "GET", "/v1/starter")).status, "used");
  const other = await organization();
  assert.equal((await claim("user_alice", other.id, {}, 409)).error.code, "starter_unavailable");
});

test("onboarding claims the free start from the website and keeps the form for fixable denials", async (t) => {
  const { x, site, count } = await setup(t);
  const run = async (user, viaSite) => {
    const call = (method, value, status = 200) =>
      viaSite
        ? site(user, method, "/v1/onboarding", value, status)
        : x.call(user, method, "/v1/onboarding", value, status);
    let current = await call("GET");
    current = await call("POST", {
      command: {
        kind: "configure",
        accountId: null,
        organizationName: "My organization",
        serverName: "Product studio",
        revision: current.revision,
      },
    });
    return { current, call };
  };
  const alice = await run("user_alice", true);
  const ready = await alice.call("POST", {
    command: { kind: "provision", revision: alice.current.revision },
  });
  assert.equal(ready.run.step, "agents");
  const grant = await site(
    "user_alice",
    "GET",
    `/v1/accounts/${ready.run.setup.accountId}/starter`,
  );
  assert.equal(grant.status, "active");
  assert.equal(grant.grant.serverId, ready.run.setup.serverId);
  // Unverified email: refused before anything is created, and the form is kept.
  const pending = await run("user_unverified", true);
  const refused = await pending.call(
    "POST",
    { command: { kind: "provision", revision: pending.current.revision } },
    409,
  );
  assert.equal(refused.error.code, "starter_unavailable");
  const kept = await pending.call("GET");
  assert.equal(kept.run.setup.kind, "draft");
  assert.equal(kept.run.setup.serverName, "Product studio");
  // API tokens create ordinary servers and never claim.
  const api = await run("user_bob", false);
  const ordinary = await api.call("POST", {
    command: { kind: "provision", revision: api.current.revision },
  });
  assert.equal(ordinary.run.step, "agents");
  assert.equal(await count("starter_grants"), 1);
});

test("onboarding's first organization and free-start server stay within their storage round trips", async (t) => {
  // Each D1 query reaches the primary database, about 120 ms from the Worker in production, so
  // this one setup step must not slowly gather queries again (it once made 49 and timed out).
  const transactions = [];
  const { site } = await setup(t, {
    free: true,
    traceRate: 1,
    telemetry: async (request) => {
      const lines = (await request.text()).trim().split("\n");
      for (let i = 1; i + 1 < lines.length; i += 2)
        if (JSON.parse(lines[i]).type === "transaction")
          transactions.push(JSON.parse(lines[i + 1]));
      return Response.json({});
    },
  });
  let run = await site("user_alice", "GET", "/v1/onboarding");
  run = await site("user_alice", "POST", "/v1/onboarding", {
    command: {
      kind: "configure",
      accountId: null,
      organizationName: "My organization",
      serverName: "Product studio",
      revision: run.revision,
    },
  });
  run = await site("user_alice", "POST", "/v1/onboarding", {
    command: { kind: "provision", revision: run.revision },
  });
  assert.equal(run.run.step, "agents");
  const provision = () =>
    transactions.find((event) =>
      event.spans?.some((span) => span.description === "Platform.createAccount"),
    );
  for (let i = 0; i < 100 && provision() === undefined; i++) await sleep(50);
  const spans = provision().spans;
  const named = (description) => spans.filter((span) => span.description === description).length;
  assert.ok(spans.filter((span) => span.op === "db.query").length <= 28);
  assert.equal(named("Metering.read"), 1, "the organization is evaluated once for the claim");
  assert.equal(named("Starter.grantState"), 0, "onboarding does not read the free start's state");
});

test("an interrupted publication is finished by scheduled repair; observations keep no raw address", async (t) => {
  const { x, organization, claim, state } = await setup(t);
  const account = await organization();
  await x.control(`quota/configure?account=${account.id}`, { losePublish: true });
  const failed = await claim("user_alice", account.id, { requestKey: "interrupted" }, 503, {
    "cf-connecting-ip": "203.0.113.7",
  });
  assert.equal(failed.error.code, "storage_unavailable");
  assert.equal((await state("user_alice", account.id)).status, "provisioning");
  assert.equal((await x.control("sync")).status, 200);
  const repaired = await state("user_alice", account.id);
  assert.deepEqual([repaired.status, repaired.grant.remaining], ["active", 500]);
  const observation = await x.db.prepare("SELECT network_key FROM starter_observations").first();
  assert.match(observation.network_key, /^[a-f0-9]{64}$/);
  const raw = await x.db.prepare("SELECT * FROM starter_grants").first();
  assert.ok(!JSON.stringify(raw).includes("203.0.113.7"));
  assert.ok(!JSON.stringify(raw).includes("@"));
});

test("quota authorities created before the free start keep their periods through the rebuild", async (t) => {
  const { x, organization } = await setup(t);
  const account = await organization();
  const quota = (path, value) => x.control(`quota/${path}?account=${account.id}`, value);
  await (await quota("")).json();
  const start = new Date(Date.now() - 86400000).toISOString();
  const end = new Date(Date.now() + 29 * 86400000).toISOString();
  assert.equal((await quota("legacy", { accountId: account.id, start, end })).status, 200);
  assert.deepEqual(await (await quota("schema")).json(), {
    periods: true,
    allocations: true,
    rows: 1,
  });
  await quota("restart").catch(() => undefined);
  const usage = await (await quota("")).json();
  assert.deepEqual(
    [usage.kind, usage.allowance, usage.used, usage.periodStart, usage.periodEnd],
    ["paid", 40000, 7, start, end],
  );
  assert.deepEqual(await (await quota("schema")).json(), {
    periods: false,
    allocations: false,
    rows: 1,
  });
  const starter = await quota("publish", {
    accountId: account.id,
    start: new Date().toISOString(),
    end: null,
    allowance: 500,
    overdraft: 0,
    kind: "starter",
  });
  assert.equal((await starter.json()).ok, false, "a paid history never gains a free start");
});

/** An ordinary server made with an API token: it counts against the unpaid server limit. */
const ordinary = (x, user, accountId, requestKey = randomUUID()) =>
  x.call(user, "POST", `/v1/accounts/${accountId}/servers`, { name: "Existing", requestKey });
/** A reservation as the earlier claim code left it: claims written, no server bound. */
const strand = async (x, account, owner, { requestKey = randomUUID(), age = 2 * 3600000 } = {}) => {
  const id = randomUUID();
  const at = new Date(Date.now() - age).toISOString();
  await x.db.batch([
    x.db
      .prepare(
        `INSERT INTO starter_grants(id,namespace,cohort,offer_version,account_id,organization_id,owner_id,request_key,server_name,allowance,reserved_at,reserved_day)
         VALUES(?,'workos:client_test','pilot-2026-11','2026-11-12',?,?,?,?,'Starter',500,?,?)`,
      )
      .bind(id, account.id, account.organizationId, owner, requestKey, at, at.slice(0, 10)),
    ...["owner", "account"].map((kind) =>
      x.db
        .prepare(
          "INSERT INTO starter_claims(namespace,kind,key,grant_id,created_at) VALUES('workos:client_test',?,?,?,?)",
        )
        .bind(kind, kind === "owner" ? owner : account.id, id, at),
    ),
  ]);
  return id;
};

test("an owner already at the unpaid server limit is not offered the free start and keeps it", async (t) => {
  const { x, site, organization, claim, state, count } = await setup(t);
  const first = await organization();
  const existing = await ordinary(x, "user_alice", first.id);
  // The offer is not shown, before or after a new organization exists.
  assert.equal((await site("user_alice", "GET", "/v1/starter")).status, "server_limit");
  const second = await organization();
  assert.equal((await state("user_alice", second.id)).status, "server_limit");
  const refused = await claim("user_alice", second.id, {}, 409);
  assert.equal(refused.error.code, "starter_unavailable");
  assert.match(refused.error.message, /server without a plan/);
  // Onboarding refuses before creating anything and keeps the form.
  let run = await site("user_alice", "GET", "/v1/onboarding");
  run = await site("user_alice", "POST", "/v1/onboarding", {
    command: {
      kind: "configure",
      accountId: second.id,
      organizationName: "Team",
      serverName: "Starter",
      revision: run.revision,
    },
  });
  const provision = { command: { kind: "provision", revision: run.revision } };
  assert.equal(
    (await site("user_alice", "POST", "/v1/onboarding", provision, 409)).error.code,
    "starter_unavailable",
  );
  assert.equal((await site("user_alice", "GET", "/v1/onboarding")).run.setup.kind, "draft");
  // Nothing was spent: once the existing server is gone, the same person claims normally.
  assert.deepEqual([await count("starter_grants"), await count("starter_claims")], [0, 0]);
  await x.call("user_alice", "POST", `/v1/accounts/${first.id}/servers/${existing.id}/delete`, {
    confirmation: "Existing",
  });
  assert.equal((await site("user_alice", "GET", "/v1/starter")).status, "eligible");
  assert.equal((await claim("user_alice", second.id)).state.status, "active");
});

test("a server refused after the reservation releases it, so the person can claim again", async (t) => {
  const { x, site, organization, claim, state, count } = await setup(t);
  const first = await organization();
  const existing = await ordinary(x, "user_alice", first.id);
  await x.call("user_alice", "POST", `/v1/accounts/${first.id}/servers/${existing.id}/delete`, {
    confirmation: "Existing",
  });
  const second = await organization();
  assert.equal((await state("user_alice", second.id)).status, "eligible");
  // Between eligibility and creation the owner's other server counts again (a racing creation).
  await x.db
    .prepare(
      `CREATE TRIGGER race AFTER INSERT ON starter_grants BEGIN
       UPDATE servers SET deletion_requested_at=NULL WHERE id='${existing.id}'; END`,
    )
    .run();
  const refused = await claim("user_alice", second.id, { requestKey: "refused" }, 409, {
    "cf-connecting-ip": "203.0.113.9",
  });
  assert.equal(refused.error.code, "starter_unavailable");
  assert.match(refused.error.message, /server without a plan/);
  await x.db.prepare("DROP TRIGGER race").run();
  // Released whole: no grant, claim or observation, and no server was created for it.
  assert.deepEqual(
    [
      await count("starter_grants"),
      await count("starter_claims"),
      await count("starter_observations"),
    ],
    [0, 0, 0],
  );
  assert.equal(await count(`servers WHERE account_id='${second.id}'`), 0);
  assert.equal((await state("user_alice", second.id)).status, "server_limit");
  assert.equal((await site("user_alice", "GET", "/v1/starter")).status, "server_limit");
  // With room again, the same request claims once.
  await x.db
    .prepare("UPDATE servers SET deletion_requested_at=? WHERE id=?")
    .bind(new Date().toISOString(), existing.id)
    .run();
  const claimed = await claim("user_alice", second.id, { requestKey: "refused" });
  assert.equal(claimed.state.status, "active");
  assert.equal(await count("starter_grants"), 1);
});

test("scheduled repair releases a stranded reservation and binds one whose server exists", async (t) => {
  const { x, site, organization, claim, state, count } = await setup(t);
  // Alice's staging case: servers without a plan elsewhere and a reservation with no server.
  const elsewhere = await organization();
  await ordinary(x, "user_alice", elsewhere.id);
  const stuck = await organization();
  await strand(x, stuck, "user_alice");
  assert.equal((await state("user_alice", stuck.id)).status, "provisioning");
  assert.equal((await site("user_alice", "GET", "/v1/starter")).status, "used");
  // A retry is refused by the server limit and releases the reservation instead of keeping it.
  const retried = await claim("user_alice", stuck.id, {}, 409);
  assert.match(retried.error.message, /server without a plan/);
  assert.equal((await state("user_alice", stuck.id)).status, "server_limit");
  assert.equal(await count("starter_grants"), 0);
  // Left alone, the scheduled repair releases it.
  const dave = await organization("user_dave");
  await strand(x, dave, "user_dave");
  // A reservation whose server was created is bound and opened, not released.
  const erin = await organization("user_erin");
  const made = await ordinary(x, "user_erin", erin.id, "made-before-bind");
  await strand(x, erin, "user_erin", { requestKey: "made-before-bind" });
  // A claim still in progress is left alone.
  const frank = await organization("user_frank");
  await strand(x, frank, "user_frank", { age: 0 });
  assert.equal((await x.control("sync")).status, 200);
  assert.equal((await state("user_dave", dave.id)).status, "eligible");
  assert.equal((await site("user_dave", "GET", "/v1/starter")).status, "eligible");
  assert.equal(await count("starter_claims WHERE key='user_dave'"), 0);
  const bound = await state("user_erin", erin.id);
  assert.deepEqual(
    [bound.status, bound.grant.serverId, bound.grant.remaining],
    ["active", made.id, 500],
  );
  assert.equal((await state("user_frank", frank.id)).status, "provisioning");
  assert.equal(await count("starter_grants"), 2);
  // Dave claims once, normally.
  assert.equal((await claim("user_dave", dave.id)).state.status, "active");
});
