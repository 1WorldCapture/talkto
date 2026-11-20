import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { concurrently, start } from "./platform-harness.mjs";
import { provider, event } from "./billing-provider.mjs";
import { plans } from "@talkto/api/pricing";

const setup = async (t, options = {}) => {
  const stripe = provider();
  const x = await start(t, {
    stripeHandler: stripe.handler,
    metering: true,
    trials: true,
    ...options,
  });
  const account = await x.account();
  const path = `/v1/accounts/${account.id}/billing`;
  const input = { plan: "shop", requestKey: "start-trial", offer: "trial" };
  const checkout = (payload = input, status = 200) =>
    x.call("user_alice", "POST", `${path}/checkout`, payload, status);
  const state = () => x.call("user_alice", "GET", path);
  const activate = async () => {
    await checkout();
    const result = stripe.complete([...stripe.sessions.keys()][0]);
    await checkout();
    return result;
  };
  return { stripe, x, account, path, input, checkout, state, activate };
};

test("trial is explicit, card-backed, capped, separate from paid invoices and retry safe", async (t) => {
  const { stripe, x, account, input, checkout, state, activate } = await setup(t);
  assert.equal((await state()).usage.allowance, 0);
  assert.equal((await state()).trialAvailable, true);
  await activate();
  const initial = await state();
  assert.equal(initial.trial.status, "active");
  assert.equal(initial.paidPeriod, null);
  assert.equal(initial.usage.allowance, 500);
  assert.equal(initial.usage.overdraft, 0);
  assert.equal(initial.trialAvailable, false);
  assert.equal(Date.parse(initial.trial.end) - Date.parse(initial.trial.start), 7 * 86400000);
  const request = stripe.requests.find(
    (r) => r.path === "/v1/checkout/sessions" && r.method === "POST",
  );
  assert.equal(request.input.get("payment_method_collection"), "always");
  assert.equal(request.input.get("payment_method_configuration"), "pmc_trial");
  assert.equal(request.input.get("subscription_data[trial_period_days]"), "7");
  assert.match(request.input.get("custom_text[submit][message]"), /500 messages, then \$12\/month/);
  await checkout();
  assert.equal(stripe.sessions.size, 1);
  await checkout({ ...input, requestKey: "another-trial" }, 409);
  await checkout({ plan: "shop", requestKey: "paid-during-trial" }, 409);
  assert.equal((await state()).usage.allowance, 500);
  const server = await x.server(account.id);
  await x.call(
    "user_alice",
    "POST",
    `/v1/accounts/${account.id}/servers`,
    { name: "Too many", requestKey: randomUUID() },
    403,
  );
  assert.equal(server.status, "ready");
  const other = await x.account();
  await x.call(
    "user_alice",
    "POST",
    `/v1/accounts/${other.id}/billing/checkout`,
    { ...input, requestKey: "new-org" },
    409,
  );
  await x.call(
    "user_alice",
    "POST",
    `/v1/accounts/${other.id}/servers`,
    { name: "Farm", requestKey: randomUUID() },
    403,
  );
  assert.equal((await state()).trial.status, "active");
});

test("repeat payment cards get no allowance and their provider trial is canceled", async (t) => {
  const { stripe, x, activate } = await setup(t);
  await activate();
  const other = await x.call("user_bob", "POST", "/v1/accounts", {
    name: "Other",
    requestKey: randomUUID(),
  });
  const path = `/v1/accounts/${other.id}/billing`;
  const input = { plan: "shop", requestKey: "repeat-card", offer: "trial" };
  await x.call("user_bob", "POST", `${path}/checkout`, input);
  const second = stripe.complete([...stripe.sessions.keys()].at(-1));
  stripe.control.lose = `/v1/subscriptions/${second.subscription.id}`;
  await x.call("user_bob", "POST", `${path}/checkout`, input);
  assert.equal(second.subscription.status, "canceled");
  const rejected = await x.call("user_bob", "GET", path);
  assert.equal(rejected.trial.status, "rejected");
  assert.equal(rejected.usage.allowance, 0);
  assert.equal(rejected.paidPeriod, null);
  const rows = await x.db.prepare("SELECT email_key,card_key FROM billing_trials").all();
  for (const row of rows.results) {
    assert.match(row.email_key, /^[a-f0-9]{64}$/);
    if (row.card_key) assert.match(row.card_key, /^[a-f0-9]{64}$/);
  }
});

test("canceling a provider trial cannot open an overlapping checkout while its capacity remains", async (t) => {
  const { stripe, x, activate, checkout, state } = await setup(t);
  const { subscription } = await activate();
  subscription.status = "canceled";
  await event(x, subscription.customer);
  assert.equal((await x.control("sync")).status, 200);
  assert.equal((await state()).subscription.status, "canceled");
  await checkout({ plan: "shop", requestKey: "overlapping-paid" }, 409);
  assert.equal(stripe.sessions.size, 1);
  assert.equal((await state()).usage.allowance, 500);
  assert.equal((await state()).issue, null);
});

test("trial launch, verified email and daily admission gates fail before creating checkout", async (t) => {
  const disabled = await setup(t, { trials: false });
  assert.equal((await disabled.state()).trialAvailable, false);
  await disabled.checkout(undefined, 409);
  assert.equal(disabled.stripe.sessions.size, 0);
  const unmetered = await setup(t, { metering: false });
  await unmetered.checkout(undefined, 409);
  const { stripe, x, checkout } = await setup(t, { trialDailyLimit: 1 });
  await checkout();
  const other = await x.call("user_bob", "POST", "/v1/accounts", {
    name: "Budget",
    requestKey: randomUUID(),
  });
  await x.call(
    "user_bob",
    "POST",
    `/v1/accounts/${other.id}/billing/checkout`,
    { plan: "shop", requestKey: randomUUID(), offer: "trial" },
    409,
  );
  const unverified = await x.call("user_unverified", "POST", "/v1/accounts", {
    name: "Unverified",
    requestKey: randomUUID(),
  });
  await x.call(
    "user_unverified",
    "POST",
    `/v1/accounts/${unverified.id}/billing/checkout`,
    { plan: "shop", requestKey: randomUUID(), offer: "trial" },
    409,
  );
  assert.equal(stripe.sessions.size, 1);
});

test("renewal cancellation is owner-only, recovers a lost reply and retains trial capacity", async (t) => {
  const { stripe, x, account, path, state, activate } = await setup(t);
  const { subscription } = await activate();
  await x.control("member", x.member(account.organizationId));
  await x.call("user_bob", "POST", `${path}/renewal`, { cancel: true, requestKey: "no" }, 403);
  await x.call("user_alice", "POST", `${path}/trial/convert`, { requestKey: "too-early" }, 409);
  stripe.control.lose = `/v1/subscriptions/${subscription.id}`;
  const input = { cancel: true, requestKey: "stop-renewing" };
  await x.call("user_alice", "POST", `${path}/renewal`, input);
  await x.call("user_alice", "POST", `${path}/renewal`, input);
  assert.equal((await state()).subscription.cancelAtPeriodEnd, true);
  assert.equal((await state()).usage.allowance, 500);
  await x.call("user_alice", "POST", `${path}/renewal`, { cancel: false, requestKey: "resume" });
  assert.equal((await state()).subscription.cancelAtPeriodEnd, false);
});

// 500 real metered sends, each a full CPU-bound round trip: over 60 s on a boat machine losing 40% of
// its CPU to steal while the server and web suites ran together.
const fiveHundredSends = { timeout: 180_000 };
test(
  "500 real messages exhaust a trial; explicit paid conversion alone unlocks paid capacity",
  fiveHundredSends,
  async (t) => {
    const { stripe, x, account, path, state, activate } = await setup(t);
    const { subscription } = await activate();
    const server = await x.server(account.id);
    const credential = await x.mcpToken(account.organizationId);
    const registered = await x.mcp(credential, "register_participant", {
      serverId: server.id,
      name: "trial-agent",
      agentType: "codex",
      requestKey: randomUUID(),
    });
    const args = {
      serverId: server.id,
      participantId: registered.data.item.id,
      target: { kind: "conversation", conversationId: registered.data.generalConversationId },
      body: "Trial message",
    };
    const firstKey = randomUUID();
    // 500 real sends, eight in flight: each is still committed and metered by the server object.
    await concurrently(500, 8, (i) =>
      x.mcp(credential, "send_message", {
        ...args,
        requestKey: i === 0 ? firstKey : randomUUID(),
      }),
    );
    assert.equal((await x.control(`meter/report?server=${server.id}`)).status, 200);
    const exhausted = await state();
    assert.equal(exhausted.usage.used, 500);
    assert.equal(exhausted.usage.outstanding, 0);
    assert.equal(exhausted.usage.status, "exhausted");
    assert.equal(
      (await x.mcp(credential, "send_message", { ...args, requestKey: randomUUID() }, true)).error
        .code,
      "message_allowance_exhausted",
    );
    assert.equal(
      (await x.mcp(credential, "send_message", { ...args, requestKey: firstKey })).data.created,
      false,
    );
    assert.equal(subscription.status, "trialing", "Exhaustion cannot charge the card");
    const input = { requestKey: "explicit-paid-start" };
    stripe.control.subscriptionDenied = true;
    await x.call("user_alice", "POST", `${path}/trial/convert`, input, 503);
    assert.equal(subscription.status, "trialing", "A denied conversion cannot end the trial");
    assert.equal((await state()).paidPeriod, null);
    assert.equal((await state()).usage.status, "exhausted");
    stripe.control.subscriptionDenied = false;
    stripe.control.conversionPaid = false;
    stripe.control.lose = `/v1/subscriptions/${subscription.id}`;
    await x.call("user_alice", "POST", `${path}/trial/convert`, input);
    assert.equal(
      stripe.invoices.get(subscription.latest_invoice).attempted,
      true,
      "Explicit conversion must attempt payment, not wait for an unimplemented confirmation step",
    );
    assert.equal(
      stripe.invoices.get(subscription.latest_invoice).billing_reason,
      "subscription_update",
    );
    assert.equal((await state()).paidPeriod, null, "An attempted charge is not paid capacity");
    assert.equal((await state()).usage.status, "exhausted");
    stripe.invoices.get(subscription.latest_invoice).status = "paid";
    subscription.status = "active";
    await event(x, subscription.customer);
    assert.equal((await x.control("sync")).status, 200);
    await x.call("user_alice", "POST", `${path}/trial/convert`, input);
    const paid = await state();
    assert.equal(paid.paidPeriod.allowance, plans.shop.messages);
    assert.equal(paid.usage.allowance, plans.shop.messages);
    assert.equal(paid.usage.overdraft, 500);
    assert.equal(paid.usage.used, 0);
    assert.equal(paid.issue, null);
    assert.equal(stripe.invoices.size, 2, "Retry must not charge another month");
    await x.mcp(credential, "send_message", { ...args, requestKey: randomUUID() });
  },
);

test("the exact trial deadline stops local capacity and keeps history readable", async (t) => {
  const { x, account, activate, state } = await setup(t);
  await activate();
  const trial = (await state()).trial;
  const server = await x.server(account.id);
  const credential = await x.mcpToken(account.organizationId);
  const registered = await x.mcp(credential, "register_participant", {
    serverId: server.id,
    name: "expiry",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  const args = {
    serverId: server.id,
    participantId: registered.data.item.id,
    target: { kind: "conversation", conversationId: registered.data.generalConversationId },
    body: "Retained",
  };
  await x.mcp(credential, "send_message", { ...args, requestKey: randomUUID() });
  assert.equal(
    (await x.control(`quota/configure?account=${account.id}`, { at: trial.end })).status,
    200,
  );
  assert.equal(
    (await x.control(`meter/configure?server=${server.id}`, { at: trial.end })).status,
    200,
  );
  const stopped = await x.mcp(
    credential,
    "send_message",
    { ...args, requestKey: randomUUID() },
    true,
  );
  assert.equal(stopped.error.code, "message_payment_required");
  assert.equal((await state()).usage.status, "payment_required");
  const history = await x.call(
    "user_alice",
    "GET",
    `/v1/servers/${server.id}/conversations/${registered.data.generalConversationId}/messages`,
  );
  assert.equal(history.items.length, 1);
});

test("day-seven payment failure cannot reuse trial capacity; later payment enables a fresh paid period", async (t) => {
  const { stripe, x, account, activate, state } = await setup(t);
  const { subscription, invoice } = await activate();
  const trial = (await state()).trial;
  assert.equal(
    (await x.control(`quota/configure?account=${account.id}`, { at: trial.end })).status,
    200,
  );
  const renewal = structuredClone(invoice);
  renewal.id = "in_trial_renewal";
  renewal.status = "open";
  renewal.billing_reason = "subscription_cycle";
  renewal.lines.data[0].id = "il_trial_renewal";
  renewal.lines.data[0].period = {
    start: subscription.trial_end,
    end: subscription.trial_end + 30 * 86400,
  };
  stripe.invoices.set(renewal.id, renewal);
  subscription.latest_invoice = renewal.id;
  subscription.status = "past_due";
  await event(x, subscription.customer);
  assert.equal((await x.control("sync")).status, 200);
  assert.equal((await state()).paidPeriod, null);
  assert.equal((await state()).usage.status, "payment_required");
  renewal.status = "paid";
  subscription.status = "active";
  await event(x, subscription.customer);
  assert.equal((await x.control("sync")).status, 200);
  const paid = await state();
  assert.equal(paid.usage.periodStart, trial.end);
  assert.equal(paid.usage.allowance, plans.shop.messages);
  assert.equal(paid.usage.overdraft, 500);
  assert.equal(paid.usage.used, 0);
  assert.equal(paid.issue, null);
});

test("a recreated identity with the same verified email cannot reclaim a trial", async (t) => {
  const { stripe, x, activate } = await setup(t);
  await activate();
  const recreated = await x.call("user_recreated", "POST", "/v1/accounts", {
    name: "Recreated",
    requestKey: randomUUID(),
  });
  await x.call(
    "user_recreated",
    "POST",
    `/v1/accounts/${recreated.id}/billing/checkout`,
    { plan: "shop", requestKey: randomUUID(), offer: "trial" },
    409,
  );
  assert.equal(stripe.sessions.size, 1);
});

test("a +tag spelling of a claimed inbox, or an inbox claimed under the earlier key, gets no trial", async (t) => {
  const { stripe, x } = await setup(t);
  const trial = async (user, status) => {
    const account = await x.call(user, "POST", "/v1/accounts", {
      name: "Tagged",
      requestKey: randomUUID(),
    });
    await x.call(
      user,
      "POST",
      `/v1/accounts/${account.id}/billing/checkout`,
      { plan: "shop", requestKey: randomUUID(), offer: "trial" },
      status,
    );
  };
  await trial("user_tagone", 200);
  await trial("user_tagtwo", 409);
  // A claim recorded before November 16 was keyed by the lowercased address, tag kept.
  await x.db
    .prepare(
      "INSERT INTO billing_trials(account_id,provider_scope,owner_id,email_key,claimed_at) VALUES(?,?,?,?,?)",
    )
    .bind(
      randomUUID(),
      "acct_talkto:test:test",
      "user_earlier",
      createHmac("sha256", "test-only-stable-claim-secret-at-least-32-characters")
        .update("acct_talkto:test:test:email:lee+old@example.com")
        .digest("hex"),
      Date.now(),
    )
    .run();
  await trial("user_legacytag", 409);
  assert.equal(stripe.sessions.size, 1);
});

test("concurrent owners cannot exceed the daily trial admission budget", async (t) => {
  const { stripe, x, account } = await setup(t, { trialDailyLimit: 1 });
  const bob = await x.call("user_bob", "POST", "/v1/accounts", {
    name: "Bob",
    requestKey: randomUUID(),
  });
  const responses = await Promise.all(
    [
      ["user_alice", account],
      ["user_bob", bob],
    ].map(async ([user, organization]) =>
      x.raw(`/v1/accounts/${organization.id}/billing/checkout`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await x.token(user)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ plan: "shop", requestKey: randomUUID(), offer: "trial" }),
      }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.equal(stripe.sessions.size, 1);
  assert.equal((await x.db.prepare("SELECT COUNT(*) AS n FROM billing_trials").first()).n, 1);
});

test("prepaid cards receive no free capacity; a non-card checkout configuration fails closed", async (t) => {
  const { stripe, activate, state, checkout } = await setup(t);
  stripe.control.cardAvailable = false;
  await checkout(undefined, 503);
  assert.equal(stripe.sessions.size, 0);
  stripe.control.cardAvailable = true;
  stripe.control.funding = "prepaid";
  const result = await activate();
  assert.equal(result.subscription.status, "canceled");
  assert.equal((await state()).trial.status, "rejected");
  assert.equal((await state()).usage.allowance, 0);
});
