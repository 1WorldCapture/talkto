import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";
import { provider, event } from "./billing-provider.mjs";

const setup = async (t, { trials = false, telemetry = false, intercept } = {}) => {
  const stripe = provider();
  const events = [];
  const bodies = [];
  const listeners = new Set();
  const options = {
    trials,
    metering: true,
    stripeHandler: intercept ? (request) => intercept(request, stripe) : stripe.handler,
  };
  if (telemetry)
    options.telemetry = async (request) => {
      const body = await request.text();
      bodies.push(body);
      const lines = body.trim().split("\n");
      for (let i = 1; i + 1 < lines.length; i += 2)
        if (["event", "transaction"].includes(JSON.parse(lines[i]).type))
          events.push(JSON.parse(lines[i + 1]));
      for (const listener of listeners) listener();
      return Response.json({});
    };
  const x = await start(t, options);
  const account = await x.account();
  const path = `/v1/accounts/${account.id}/billing`;
  const input = { plan: "shop", requestKey: randomUUID() };
  if (trials) input.offer = "trial";
  const checkout = (status = 200, payload = input) =>
    x.call("user_alice", "POST", `${path}/checkout`, payload, status);
  const state = () => x.call("user_alice", "GET", path);
  const activate = async () => {
    await checkout();
    const payment = stripe.complete([...stripe.sessions.keys()][0]);
    await checkout();
    return payment;
  };
  const captured = (predicate) => {
    const find = () => events.find(predicate);
    if (find()) return Promise.resolve(find());
    return new Promise((resolve) => {
      const listener = () => {
        const value = find();
        if (value) {
          listeners.delete(listener);
          resolve(value);
        }
      };
      listeners.add(listener);
    });
  };
  const diagnostic = (requestId) =>
    captured((value) => value.exception && value.tags?.["talkto.request_id"] === requestId);
  return {
    x,
    stripe,
    account,
    path,
    input,
    checkout,
    state,
    activate,
    diagnostic,
    captured,
    bodies,
  };
};

for (const recoveryDown of [false, true])
  test(`denied subscription write preserves safe provider diagnostics; refetch down=${recoveryDown}`, async (t) => {
    const { x, stripe, path, activate, state, diagnostic, bodies } = await setup(t, {
      telemetry: true,
    });
    const { subscription } = await activate();
    const original = (await state()).paidPeriod;
    stripe.control.subscriptionDenied = true;
    stripe.control.subscriptionRefetchDown = recoveryDown;
    const intent = { cancel: true, requestKey: "cancel-denied" };
    const failed = await x.call("user_alice", "POST", `${path}/renewal`, intent, 503);
    const error = await diagnostic(failed.meta.requestId);
    assert.equal(error.tags["talkto.operation"], "stripe.subscription.renewal");
    assert.equal(error.tags["talkto.provider_type"], "StripePermissionError");
    assert.equal(error.tags["talkto.provider_status"], "403");
    assert.equal(error.tags["talkto.provider_code"], "permission_denied");
    assert.equal(error.tags["talkto.provider_request_id"], "req_deniedTest123");
    if (recoveryDown) {
      assert.equal(error.tags["talkto.recovery_operation"], "stripe.subscription.retrieve");
      assert.equal(error.tags["talkto.recovery_status"], "503");
      assert.equal(error.tags["talkto.recovery_request_id"], "req_recoveryTest456");
    }
    assert.equal(subscription.cancel_at_period_end, false);
    assert.equal(failed.error.code, "billing_unavailable");
    assert.match(failed.error.message, /configuration repair/);
    assert.doesNotMatch(failed.error.message, /Retry with the same request key/);
    assert.doesNotMatch(JSON.stringify(failed), /StripePermissionError|req_deniedTest123|PRIVATE_/);
    stripe.control.subscriptionDenied = false;
    stripe.control.subscriptionRefetchDown = false;
    stripe.control.lose = `/v1/subscriptions/${subscription.id}`;
    assert.equal((await x.call("user_alice", "POST", `${path}/renewal`, intent)).confirmed, true);
    assert.equal((await x.call("user_alice", "POST", `${path}/renewal`, intent)).confirmed, true);
    assert.equal((await state()).subscription.cancelAtPeriodEnd, true);
    assert.deepEqual((await state()).paidPeriod, original);
    const writes = stripe.requests.filter(
      (value) => value.method === "POST" && value.path === `/v1/subscriptions/${subscription.id}`,
    );
    assert.equal(writes.length, 2);
    assert.equal(new Set(writes.map((value) => value.key)).size, 1);
    assert.doesNotMatch(
      bodies.join("\n"),
      /PRIVATE_PROVIDER_DIAGNOSTIC|PRIVATE_RECOVERY_DIAGNOSTIC|rk_test_|whsec_|Bearer /,
    );
  });

test("subscription mutation verifies merchant identity before writing", async (t) => {
  const { x, stripe, path, activate } = await setup(t);
  const { subscription } = await activate();
  stripe.control.accountId = "acct_unrelated";
  await x.call(
    "user_alice",
    "POST",
    `${path}/renewal`,
    { cancel: true, requestKey: "wrong-merchant" },
    503,
  );
  assert.equal(subscription.cancel_at_period_end, false);
  assert.equal(
    stripe.requests.filter(
      (value) => value.path === `/v1/subscriptions/${subscription.id}` && value.method !== "GET",
    ).length,
    0,
  );
});

test("denied trial rejection preserves provider failure and scheduled retry cancels without capacity", async (t) => {
  const { x, stripe, checkout, state, diagnostic } = await setup(t, {
    trials: true,
    telemetry: true,
  });
  await checkout();
  const { subscription } = stripe.complete([...stripe.sessions.keys()][0]);
  stripe.paymentMethods.get(subscription.default_payment_method).card.funding = "prepaid";
  stripe.control.subscriptionDenied = true;
  const failed = await checkout(503);
  const error = await diagnostic(failed.meta.requestId);
  assert.equal(error.tags["talkto.operation"], "stripe.trial.reject");
  assert.equal(error.tags["talkto.provider_status"], "403");
  assert.equal((await state()).trial.status, "rejected");
  assert.equal((await state()).usage.allowance, 0);
  assert.equal(subscription.status, "trialing");
  stripe.control.subscriptionDenied = false;
  await event(x, subscription.customer);
  assert.equal((await x.control("sync")).status, 200);
  assert.equal(subscription.status, "canceled");
  assert.equal((await state()).paidPeriod, null);
  assert.equal((await state()).usage.allowance, 0);
});

test("trial operation and claim binding roll back together on an actual D1 write failure", async (t) => {
  const { x, stripe, account, checkout, state } = await setup(t, { trials: true });
  await x.db
    .prepare(
      "CREATE TRIGGER fail_trial_binding BEFORE UPDATE OF operation_id ON billing_trials BEGIN SELECT RAISE(FAIL,'injected binding failure'); END",
    )
    .run();
  await checkout(503);
  assert.equal((await x.db.prepare("SELECT COUNT(*) AS n FROM billing_operations").first()).n, 0);
  const claim = await x.db
    .prepare("SELECT * FROM billing_trials WHERE account_id=?")
    .bind(account.id)
    .first();
  assert.equal(claim.status, "pending");
  assert.equal(claim.operation_id, null);
  assert.equal(stripe.customers.size, 0);
  assert.equal(stripe.sessions.size, 0);
  await x.db.prepare("DROP TRIGGER fail_trial_binding").run();
  await checkout();
  stripe.complete([...stripe.sessions.keys()][0]);
  await checkout();
  assert.equal((await state()).trial.status, "active");
  assert.equal((await state()).usage.allowance, 500);
  assert.equal((await x.db.prepare("SELECT COUNT(*) AS n FROM billing_trials").first()).n, 1);
  assert.equal((await x.db.prepare("SELECT COUNT(*) AS n FROM billing_operations").first()).n, 1);
  assert.equal(
    (await x.db.prepare("SELECT claimed_at FROM billing_trials").first()).claimed_at,
    claim.claimed_at,
  );
  assert.equal(stripe.sessions.size, 1);
});

for (const recovery of ["interactive", "scheduled", "completed-webhook"])
  test(`legacy trial null binding repairs through ${recovery}`, async (t) => {
    const { x, stripe, account, checkout, input, state } = await setup(t, { trials: true });
    await checkout();
    const operation = await x.db.prepare("SELECT * FROM billing_operations").first();
    const claim = await x.db.prepare("SELECT * FROM billing_trials").first();
    const { subscription } = stripe.complete([...stripe.sessions.keys()][0]);
    await x.db
      .prepare("UPDATE billing_trials SET operation_id=NULL WHERE account_id=?")
      .bind(account.id)
      .run();
    if (recovery === "interactive") await checkout();
    else {
      if (recovery === "completed-webhook") {
        await x.db
          .prepare("UPDATE billing_operations SET status='complete' WHERE id=?")
          .bind(operation.id)
          .run();
        await event(x, subscription.customer);
      }
      assert.equal((await x.control("sync")).status, 200);
    }
    const repaired = await x.db.prepare("SELECT * FROM billing_trials").first();
    assert.equal(repaired.operation_id, operation.id);
    assert.equal(repaired.claimed_at, claim.claimed_at);
    assert.equal(repaired.status, "active");
    assert.equal(subscription.status, "trialing");
    assert.equal((await state()).usage.allowance, 500);
    await checkout(409, { ...input, requestKey: "new-claim" });
    assert.equal((await x.db.prepare("SELECT COUNT(*) AS n FROM billing_trials").first()).n, 1);
    assert.equal(stripe.subscriptions.size, 1);
    assert.equal((await state()).paidPeriod, null);
  });

test("legacy trial binding cannot be rebound from another operation", async (t) => {
  const { x, stripe, account, checkout, state } = await setup(t, { trials: true });
  await checkout();
  await x.db
    .prepare("UPDATE billing_trials SET operation_id='another-operation' WHERE account_id=?")
    .bind(account.id)
    .run();
  const before = stripe.requests.length;
  await checkout(503);
  assert.equal(
    stripe.requests.length,
    before,
    "Conflicting binding stops before any provider recovery",
  );
  assert.equal((await state()).usage.allowance, 0);
  assert.equal(
    (await x.db.prepare("SELECT operation_id FROM billing_trials").first()).operation_id,
    "another-operation",
  );
});

test("actual scheduled handler converges external renewal change without a webhook and preserves paid time", async (t) => {
  const { x, stripe, account, activate, state } = await setup(t);
  const { subscription } = await activate();
  const original = (await state()).paidPeriod;
  subscription.cancel_at_period_end = true;
  await x.db
    .prepare(
      "UPDATE workspace_billing SET checked_at='2020-01-01T00:00:00.000Z',attempted_at=1 WHERE account_id=?",
    )
    .bind(account.id)
    .run();
  assert.equal((await x.db.prepare("SELECT COUNT(*) AS n FROM stripe_events").first()).n, 0);
  assert.equal((await x.control("sync")).status, 200);
  assert.equal((await state()).subscription.cancelAtPeriodEnd, true);
  assert.deepEqual((await state()).paidPeriod, original);
  const observed = await x.db
    .prepare("SELECT attempted_at,checked_at,lease FROM workspace_billing WHERE account_id=?")
    .bind(account.id)
    .first();
  assert.ok(observed.attempted_at > 1);
  assert.ok(observed.checked_at > "2020-01-01T00:00:00.000Z");
  assert.equal(observed.lease, null);
  assert.equal(stripe.invoices.size, 1);
});

const due = (x, account) =>
  x.db
    .prepare(
      "UPDATE workspace_billing SET checked_at='2020-01-01T00:00:00.000Z',attempted_at=1 WHERE account_id=?",
    )
    .bind(account.id)
    .run();
const billingRow = (x, account) =>
  x.db
    .prepare(
      "SELECT subscription_id,subscription_json,checked_at,lease FROM workspace_billing WHERE account_id=?",
    )
    .bind(account.id)
    .first();

test("scheduled repair converges when test-mode retention deleted an ended subscription", async (t) => {
  const { x, stripe, account, activate, state } = await setup(t);
  const { subscription, invoice } = await activate();
  const original = (await state()).paidPeriod;
  subscription.status = "canceled";
  await due(x, account);
  assert.equal((await x.control("sync")).status, 200);
  assert.equal(JSON.parse((await billingRow(x, account)).subscription_json).status, "canceled");
  // Stripe deletes the subscription and its invoices 30 days after it ends.
  stripe.subscriptions.delete(subscription.id);
  stripe.invoices.delete(invoice.id);
  await due(x, account);
  assert.equal((await x.control("sync")).status, 200);
  const row = await billingRow(x, account);
  assert.equal(row.subscription_id, null);
  assert.equal(row.subscription_json, null);
  assert.ok(row.checked_at > "2020-01-01T00:00:00.000Z");
  assert.equal(row.lease, null);
  assert.deepEqual((await state()).paidPeriod, original, "Recorded paid time is kept");
});

test("an ended subscription on an earlier Price is recorded; a current one still fails closed", async (t) => {
  const { x, stripe, account, activate, state } = await setup(t);
  const { subscription } = await activate();
  const original = (await state()).paidPeriod;
  const earlier = {
    ...stripe.prices.price_shop,
    id: "price_shopEarlier",
    active: false,
    unit_amount: 2000,
    metadata: { ...stripe.prices.price_shop.metadata, plan_version: "2026-09-09" },
  };
  subscription.items.data[0].price = earlier;
  await due(x, account);
  assert.equal((await x.control("sync")).status, 500, "An active earlier Price needs migration");
  assert.equal((await billingRow(x, account)).checked_at, "2020-01-01T00:00:00.000Z");
  subscription.status = "canceled";
  assert.equal((await x.control("sync")).status, 200);
  assert.equal((await state()).subscription.status, "canceled");
  assert.deepEqual((await state()).paidPeriod, original);
  subscription.items.data[0].price = {
    ...earlier,
    metadata: { ...earlier.metadata, environment: "staging" },
  };
  await due(x, account);
  assert.equal((await x.control("sync")).status, 500, "Another environment's Price is refused");
});

test("scheduled billing completes despite unavailable human authentication and exports bounded progress", async (t) => {
  const { x, account, activate, state, captured } = await setup(t, { telemetry: true });
  const { subscription } = await activate();
  const original = (await state()).paidPeriod;
  subscription.cancel_at_period_end = true;
  await x.db
    .prepare(
      "UPDATE workspace_billing SET checked_at='2020-01-01T00:00:00.000Z',attempted_at=1 WHERE account_id=?",
    )
    .bind(account.id)
    .run();
  await x.control("authentication-down?value=true");
  assert.equal(
    (await x.control("sync")).status,
    500,
    "The unrelated authentication failure remains visible",
  );
  const row = await x.db
    .prepare("SELECT subscription_json,checked_at,lease FROM workspace_billing WHERE account_id=?")
    .bind(account.id)
    .first();
  assert.equal(JSON.parse(row.subscription_json).cancelAtPeriodEnd, true);
  assert.ok(row.checked_at > "2020-01-01T00:00:00.000Z");
  assert.equal(row.lease, null);
  await x.control("authentication-down?value=false");
  assert.deepEqual((await state()).paidPeriod, original);
  const transaction = await captured((value) =>
    value.spans?.some((span) => span.description === "Billing.synchronize"),
  );
  const sweep = transaction.spans.find((span) => span.description === "Billing.synchronize");
  assert.equal(sweep.data["talkto.selected"], 1);
  assert.equal(sweep.data["talkto.succeeded"], 1);
  assert.equal(sweep.data["talkto.failed"], 0);
  assert.equal(sweep.data["talkto.busy"], 0);
  assert.ok(sweep.data["talkto.selected_oldest_check_age_ms"] > 300000);
  assert.ok(
    transaction.spans.some(
      (span) =>
        span.data?.["talkto.stage"] === "billing" && span.data["talkto.outcome"] === "Success",
    ),
  );
});

test("webhook receipt survives failure and a later event during observation remains due", async (t) => {
  let gate;
  const { x, account, activate, state } = await setup(t, {
    intercept: async (request, stripe) => {
      const response = await stripe.handler(request);
      if (gate && new URL(request.url).pathname === "/v1/subscriptions") {
        const current = gate;
        gate = undefined;
        current.enter();
        await current.wait;
      }
      return response;
    },
  });
  const { subscription } = await activate();
  const original = (await state()).paidPeriod;
  await x.db
    .prepare(
      "CREATE TRIGGER fail_event_receipt BEFORE INSERT ON stripe_events BEGIN SELECT RAISE(FAIL,'injected receipt failure'); END",
    )
    .run();
  assert.equal((await event(x, subscription.customer, { id: "evt_retried" })).status, 503);
  assert.equal((await x.db.prepare("SELECT COUNT(*) AS n FROM stripe_events").first()).n, 0);
  await x.db.prepare("DROP TRIGGER fail_event_receipt").run();
  subscription.cancel_at_period_end = true;
  assert.equal((await event(x, subscription.customer, { id: "evt_retried" })).status, 200);
  assert.equal((await event(x, subscription.customer, { id: "evt_retried" })).status, 200);
  assert.equal((await x.db.prepare("SELECT COUNT(*) AS n FROM stripe_events").first()).n, 1);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  gate = { enter: entered.resolve, wait: release.promise };
  // The webhook's own application observes Stripe; hold it there.
  const pass = event(x, subscription.customer, { id: "evt_observed" });
  try {
    await entered.promise;
    subscription.cancel_at_period_end = false;
    assert.equal(
      (
        await event(x, subscription.customer, {
          id: "evt_during_observation",
          type: "customer.subscription.updated",
        })
      ).status,
      200,
    );
  } finally {
    release.resolve();
  }
  assert.equal((await pass).status, 200);
  const pending = await x.db
    .prepare(
      "SELECT synced_event,(SELECT MAX(sequence) FROM stripe_events) AS head FROM workspace_billing WHERE account_id=?",
    )
    .bind(account.id)
    .first();
  assert.ok(pending.synced_event < pending.head);
  assert.equal((await state()).subscription.cancelAtPeriodEnd, true);
  assert.equal((await x.control("sync")).status, 200);
  assert.equal((await state()).subscription.cancelAtPeriodEnd, false);
  assert.deepEqual((await state()).paidPeriod, original);
  const settled = await x.db
    .prepare(
      "SELECT synced_event,(SELECT MAX(sequence) FROM stripe_events) AS head,lease FROM workspace_billing WHERE account_id=?",
    )
    .bind(account.id)
    .first();
  assert.equal(settled.synced_event, settled.head);
  assert.equal(settled.lease, null);
});
