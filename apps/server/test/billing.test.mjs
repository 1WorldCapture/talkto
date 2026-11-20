import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { concurrently, start } from "./platform-harness.mjs";
import { provider, event } from "./billing-provider.mjs";
import { planVersion, plans, storageGigabytes } from "@talkto/api/pricing";

const setup = async (t, options = {}) => {
  const stripe = provider();
  const x = await start(t, { stripeHandler: stripe.handler, ...options });
  const account = await x.account();
  const path = `/v1/accounts/${account.id}/billing`;
  const checkout = (input, status = 200) =>
    x.call("user_alice", "POST", `${path}/checkout`, input, status);
  const state = () => x.call("user_alice", "GET", path);
  const sync = async () => {
    const response = await x.control("sync");
    assert.equal(response.status, 200, await response.text());
  };
  return { x, stripe, account, path, checkout, state, sync };
};

test("billing is opt-in and publishes fixed-price contracts without changing messaging", async (t) => {
  const x = await start(t);
  const account = await x.account();
  await x.call("user_alice", "GET", `/v1/accounts/${account.id}/billing`, undefined, 503);
  assert.equal((await x.server(account.id)).status, "ready");
  const api = await (await x.raw("/openapi.json")).json();
  assert.ok(api.paths["/v1/accounts/{accountId}/billing/checkout"]);
  assert.ok(api.paths["/v1/accounts/{accountId}/billing/checkout/cancel"]);
});

test("only the active workspace owner can purchase; browser billing retains Origin protection", async (t) => {
  const { x, stripe, account, path, state } = await setup(t);
  const initial = await state();
  assert.deepEqual(
    initial.plans.map((plan) => [plan.key, plan.monthlyCents, plan.messages, plan.peopleLimit]),
    [
      ["shop", 1200, 40000, 4],
      ["studio", 6000, 250000, null],
      ["factory", 15000, 750000, null],
    ],
  );
  assert.equal(initial.paidPeriod, null);
  await x.call("user_bob", "GET", path, undefined, 404);
  await x.control("member", x.member(account.organizationId));
  const member = await x.call("user_bob", "GET", path);
  assert.equal(member.permissions.manageBilling, false);
  await x.call("user_bob", "POST", `${path}/checkout`, { plan: "shop", requestKey: "bob" }, 403);
  await x.call(
    "user_bob",
    "POST",
    `${path}/checkout/cancel`,
    { plan: "shop", requestKey: "bob" },
    403,
  );
  const flow = await x.browserLogin();
  const cookie = (await flow.callback()).headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
  const payload = JSON.stringify({ plan: "shop", requestKey: "browser" });
  for (const origin of [undefined, "https://other.test"]) {
    const headers = { cookie, "content-type": "application/json" };
    if (origin) headers.origin = origin;
    assert.equal(
      (await x.raw(`${path}/checkout`, { method: "POST", body: payload, headers })).status,
      403,
    );
    assert.equal(
      (await x.raw(`${path}/checkout/cancel`, { method: "POST", body: payload, headers })).status,
      403,
    );
  }
  assert.equal(stripe.customers.size, 0);
  await x.call("user_alice", "POST", `${path}/checkout`, { plan: "packs", requestKey: "bad" }, 400);
});

test("canceling checkout expires only its exact intent, survives a lost response and cannot reopen", async (t) => {
  const { x, stripe, path, checkout, state, sync } = await setup(t);
  const input = { plan: "shop", requestKey: "cancel-current" };
  await checkout(input);
  const session = [...stripe.sessions.values()][0];
  const cancel = (payload, status = 200) =>
    x.call("user_alice", "POST", `${path}/checkout/cancel`, payload, status);
  await cancel({ ...input, requestKey: "wrong-intent" }, 409);
  await cancel({ ...input, plan: "studio" }, 409);
  assert.equal(session.status, "open");
  stripe.control.lose = `/v1/checkout/sessions/${session.id}/expire`;
  assert.equal((await cancel(input)).status, "expired");
  assert.equal(session.status, "expired");
  assert.equal((await state()).checkout, null);
  assert.equal((await state()).subscription, null);
  assert.equal((await state()).paidPeriod, null);
  const next = { plan: "studio", requestKey: "after-cancel" };
  assert.equal((await checkout(next)).status, "open");
  assert.equal(
    (await cancel(input)).status,
    "expired",
    "A stale cancel cannot cancel a new checkout",
  );
  assert.equal(
    (await checkout(input)).status,
    "expired",
    "A delayed create cannot resurrect an old intent",
  );
  await sync();
  assert.deepEqual((await state()).checkout, next);
  assert.equal([...stripe.sessions.values()].filter((s) => s.status === "open").length, 1);
  assert.equal(stripe.requests.filter((r) => r.path.endsWith("/expire")).length, 1);
});

test("checkout cancellation keeps uncertainty pending, recovers unbound creation and never cancels a completed subscription", async (t) => {
  const { x, stripe, path, checkout, state } = await setup(t);
  const input = { plan: "shop", requestKey: "cancel-lost-creation" };
  stripe.control.recoveryDown = true;
  stripe.control.lose = "/v1/checkout/sessions";
  await checkout(input, 503);
  assert.equal(stripe.sessions.size, 1);
  stripe.control.recoveryDown = false;
  const cancel = (status = 200) =>
    x.call("user_alice", "POST", `${path}/checkout/cancel`, input, status);
  stripe.control.expireDown = true;
  await cancel(503);
  assert.deepEqual((await state()).checkout, input);
  assert.equal([...stripe.sessions.values()][0].status, "open");
  stripe.control.expireDown = false;
  stripe.control.completeOnExpire = true;
  assert.equal((await cancel()).status, "complete");
  const paid = await state();
  assert.equal(paid.checkout, null);
  assert.equal(paid.subscription.status, "active");
  assert.equal(paid.paidPeriod.allowance, plans.shop.messages);
  assert.equal((await cancel()).status, "complete");
  assert.equal(stripe.sessions.size, 1);
  assert.equal(
    stripe.requests.some((r) => r.method === "DELETE" || /subscriptions\/.*cancel/.test(r.path)),
    false,
  );
});

test("canceling before creation records a terminal key and concurrent cancellation stays fenced", async (t) => {
  const { x, stripe, path, checkout, state } = await setup(t);
  const input = { plan: "shop", requestKey: "cancel-before-create" };
  const cancel = (status = 200) =>
    x.call("user_alice", "POST", `${path}/checkout/cancel`, input, status);
  const hold = { started: Promise.withResolvers(), release: Promise.withResolvers() };
  stripe.control.expireHold = hold;
  const first = cancel();
  await hold.started.promise;
  try {
    await cancel(409);
    await checkout(input, 409);
    assert.deepEqual((await state()).checkout, input);
  } finally {
    hold.release.resolve();
  }
  assert.equal((await first).status, "expired");
  assert.equal((await checkout(input)).status, "expired");
  assert.equal((await state()).checkout, null);
  assert.equal(stripe.sessions.size, 1);
  assert.equal(stripe.subscriptions.size, 0);
});

test("lost Customer and Checkout responses recover once under stable request keys", async (t) => {
  const { stripe, checkout, state } = await setup(t);
  const input = { plan: "shop", requestKey: "lost" };
  stripe.control.recoveryDown = true;
  stripe.control.lose = "/v1/customers";
  await checkout(input, 503);
  stripe.control.lose = "/v1/checkout/sessions";
  await checkout(input, 503);
  assert.deepEqual(
    (await state()).checkout,
    input,
    "A new browser session can recover the original request key",
  );
  stripe.control.recoveryDown = false;
  const result = await checkout(input);
  assert.equal(result.status, "open");
  assert.deepEqual(await checkout(input), result);
  assert.equal(stripe.customers.size, 1);
  assert.equal(stripe.sessions.size, 1);
  assert.equal((await state()).paidPeriod, null);
  await checkout({ ...input, plan: "studio" }, 409);
  await checkout({ ...input, requestKey: "another" }, 409);
});

test("concurrent requests and expired lease holders cannot duplicate a checkout or overwrite its binding", async (t) => {
  const { x, stripe, account, checkout } = await setup(t);
  const hold = { started: Promise.withResolvers(), release: Promise.withResolvers() };
  stripe.control.hold = hold;
  const first = checkout({ plan: "shop", requestKey: "first" }, 409);
  await hold.started.promise;
  try {
    await checkout({ plan: "shop", requestKey: "second" }, 409);
    await x.db
      .prepare("UPDATE workspace_billing SET lease='successor' WHERE account_id=?")
      .bind(account.id)
      .run();
  } finally {
    hold.release.resolve();
  }
  await first;
  assert.equal(
    (
      await x.db
        .prepare("SELECT customer_id FROM workspace_billing WHERE account_id=?")
        .bind(account.id)
        .first()
    ).customer_id,
    null,
  );
  await x.db
    .prepare("UPDATE workspace_billing SET lease=NULL,lease_until=0 WHERE account_id=?")
    .bind(account.id)
    .run();
  assert.equal((await checkout({ plan: "shop", requestKey: "first" })).status, "open");
  assert.equal(stripe.customers.size, 1);
  assert.equal(stripe.sessions.size, 1);
});

test("signed events reconcile payment, not redirect or arrival order; duplicate paid invoices grant once", async (t) => {
  const { x, stripe, account, checkout, state, sync } = await setup(t);
  const storage = async () => (await x.control(`storage?account=${account.id}`)).json();
  assert.equal((await storage()).plan, null);
  const input = { plan: "studio", requestKey: "purchase" };
  await checkout(input);
  const payment = stripe.complete([...stripe.sessions.keys()][0], "open");
  assert.equal((await checkout(input)).status, "complete");
  assert.equal((await state()).paidPeriod, null);
  assert.equal((await state()).subscription.payment, "unpaid");
  payment.invoice.status = "paid";
  payment.subscription.status = "active";
  const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
  assert.equal((await event(x, payment.session.customer, { id: eventId })).status, 200);
  assert.equal((await event(x, payment.session.customer, { id: eventId })).status, 200);
  await sync();
  const paid = await state();
  assert.equal(paid.subscription.status, "active");
  assert.equal(paid.paidPeriod.allowance, plans.studio.messages);
  assert.equal(paid.checkout, null);
  // The confirmed plan sizes the organization's stored-file pool, metered or not.
  const pooled = await storage();
  assert.equal(pooled.plan, "studio");
  assert.equal(pooled.limitBytes, storageGigabytes.studio * 1_000_000_000);
  assert.equal(pooled.planEnd, paid.paidPeriod.end);
  await event(x, payment.session.customer, { type: "invoice.payment_failed" });
  await sync();
  assert.equal((await state()).subscription.payment, "paid");
  assert.equal((await x.db.prepare("SELECT COUNT(*) AS n FROM billing_periods").first()).n, 1);
  await checkout({ plan: "factory", requestKey: "duplicate-subscription" }, 409);
  assert.equal(stripe.sessions.size, 1);
});

test("every paid month records its plan's listed allowance, whatever its date, and keeps it", async (t) => {
  const { x, stripe, account, checkout, sync } = await setup(t);
  // Stripe dates are seconds: a month that starts on March 31, 2027 and the renewal after it.
  const first = Date.parse("2027-03-31T12:00:00.000Z") / 1000;
  const month = 30 * 86400;
  const input = { plan: "studio", requestKey: "listed-allowance" };
  await checkout(input);
  const { invoice } = stripe.complete([...stripe.sessions.keys()][0]);
  invoice.lines.data[0].period = { start: first, end: first + month };
  await checkout(input);
  const renewal = structuredClone(invoice);
  renewal.id = "in_renewal";
  renewal.billing_reason = "subscription_cycle";
  renewal.lines.data[0].id = "il_renewal";
  renewal.lines.data[0].period = { start: first + month, end: first + 2 * month };
  stripe.invoices.set(renewal.id, renewal);
  await event(x, invoice.customer);
  await sync();
  const recorded = async () =>
    (
      await x.db
        .prepare(
          "SELECT plan,plan_version AS planVersion,allowance FROM billing_periods WHERE account_id=? ORDER BY start",
        )
        .bind(account.id)
        .all()
    ).results;
  // Studio: 250,000 for both months, with no bonus on top (owner decision, November 16, 2026).
  assert.deepEqual(await recorded(), [
    { plan: "studio", planVersion, allowance: 250000 },
    { plan: "studio", planVersion, allowance: 250000 },
  ]);
  // A recorded month never changes, even when observed again.
  await event(x, invoice.customer);
  await sync();
  assert.deepEqual(
    (await recorded()).map((row) => row.allowance),
    [250000, 250000],
  );
});

test("unsigned, modified, wrong-environment, and unrelated events cannot alter billing", async (t) => {
  const { x, stripe, checkout } = await setup(t);
  await checkout({ plan: "shop", requestKey: "valid" });
  const customerId = [...stripe.customers.keys()][0];
  assert.equal((await x.raw("/webhooks/stripe", { method: "POST", body: "{}" })).status, 400);
  assert.equal((await event(x, customerId, { live: true })).status, 400);
  assert.equal((await event(x, "cus_other_product")).status, 200);
  assert.equal((await x.db.prepare("SELECT COUNT(*) AS n FROM stripe_events").first()).n, 0);
  assert.equal((await x.raw("/webhooks/stripe")).status, 405);
  const failed = await x.raw("/webhooks/stripe", { method: "POST", body: " ".repeat(131073) });
  assert.equal(failed.status, 413);
});

test("a self-host license bought through a Payment Link never reaches hosted billing", async (t) => {
  const { x, stripe, checkout, state, sync } = await setup(t);
  await checkout({ plan: "shop", requestKey: "hosted" });
  const before = await state();
  const calls = stripe.requests.length;
  // What Stripe sends for a yearly self-host license (sold until November 19, 2026; old ones may
  // still renew or cancel): a customer TalkTo's own Checkout never created, and metadata that
  // names no organization.
  const license = { app: "talkto", kind: "selfhost", license: "team", environment: "test" };
  const customer = "cus_selfhost_buyer";
  const objects = {
    "checkout.session.completed": {
      id: "cs_selfhost",
      object: "checkout.session",
      mode: "subscription",
      customer,
      subscription: "sub_selfhost",
      payment_link: "plink_selfhost",
      metadata: license,
    },
    "customer.subscription.created": {
      id: "sub_selfhost",
      object: "subscription",
      customer,
      status: "active",
      metadata: license,
      items: { data: [{ price: { id: "price_selfhost_team", recurring: { interval: "year" } } }] },
    },
    "invoice.paid": {
      id: "in_selfhost",
      object: "invoice",
      customer,
      subscription: "sub_selfhost",
    },
  };
  for (const [type, object] of Object.entries(objects)) {
    const payload = JSON.stringify({
      id: `evt_${randomUUID().replaceAll("-", "")}`,
      type,
      livemode: false,
      data: { object },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", x.webhookSecret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");
    const response = await x.raw("/webhooks/stripe", {
      method: "POST",
      body: payload,
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
    });
    // Acknowledged, so Stripe stops retrying, and nothing is stored or read.
    assert.equal(response.status, 200, type);
  }
  assert.equal((await x.db.prepare("SELECT COUNT(*) AS n FROM stripe_events").first()).n, 0);
  await sync();
  assert.ok(
    stripe.requests.slice(calls).every((request) => !JSON.stringify(request).includes("selfhost")),
    "reconciliation never asks Stripe about the license",
  );
  const after = await state();
  assert.deepEqual(
    [after.subscription, after.paidPeriod, after.trial],
    [before.subscription, before.paidPeriod, before.trial],
  );
});

test("paid proration or unrelated invoice lines cannot mint another monthly allowance", async (t) => {
  const { x, stripe, checkout, state, sync } = await setup(t);
  await checkout({ plan: "shop", requestKey: "paid" });
  const payment = stripe.complete([...stripe.sessions.keys()][0]);
  payment.invoice.billing_reason = "subscription_update";
  payment.invoice.lines.data[0].parent.subscription_item_details.proration = true;
  await event(x, payment.session.customer);
  await sync();
  assert.equal((await state()).paidPeriod, null);
  payment.invoice.billing_reason = "subscription_cycle";
  payment.invoice.lines.data[0].parent.subscription_item_details.proration = false;
  payment.invoice.lines.data[0].pricing.price_details.price = "price_another_product";
  await event(x, payment.session.customer);
  await sync();
  assert.equal((await state()).paidPeriod, null);
});

test("missing webhooks recover on scheduled reconciliation; provider outages preserve paid state and pending work", async (t) => {
  const { x, stripe, account, checkout, state, sync } = await setup(t);
  await checkout({ plan: "factory", requestKey: "offline" });
  const payment = stripe.complete([...stripe.sessions.keys()][0]);
  await sync();
  const paid = await state();
  assert.equal(paid.paidPeriod.allowance, plans.factory.messages);
  stripe.control.down = true;
  assert.equal((await event(x, payment.session.customer)).status, 200);
  const fail = await x.control("sync");
  assert.equal(fail.status, 500);
  const preserved = await state();
  assert.deepEqual({ ...preserved, usage: { ...preserved.usage, asOf: paid.usage.asOf } }, paid);
  stripe.control.down = false;
  await sync();
  const row = await x.db
    .prepare(
      "SELECT synced_event,(SELECT MAX(sequence) FROM stripe_events) AS head FROM workspace_billing WHERE account_id=?",
    )
    .bind(account.id)
    .first();
  assert.equal(row.synced_event, row.head);
});

test("expired checkouts permit a new intent while old keys remain terminal; old ambiguous attempts never create blind duplicates", async (t) => {
  const { x, stripe, account, checkout } = await setup(t);
  const input = { plan: "shop", requestKey: "expired" };
  await checkout(input);
  [...stripe.sessions.values()][0].status = "expired";
  assert.deepEqual(await checkout(input), { status: "expired" });
  await checkout({ plan: "studio", requestKey: "next" });
  assert.deepEqual(await checkout(input), { status: "expired" });
  assert.equal(stripe.customers.size, 1);
  assert.equal(stripe.sessions.size, 2);
  await x.db
    .prepare(
      "UPDATE billing_operations SET created_at=0,session_id=NULL WHERE account_id=? AND status='pending'",
    )
    .bind(account.id)
    .run();
  const recovered = await checkout({ plan: "studio", requestKey: "next" });
  assert.equal(recovered.status, "open");
  assert.equal(stripe.sessions.size, 2);
});

test("Shop checkout is refused while the organization has more than 4 people", async (t) => {
  const { x, stripe, account, checkout } = await setup(t);
  const root = `/v1/accounts/${account.id}`;
  await x.control("member", x.member(account.organizationId));
  await x.control("member", x.member(account.organizationId, "user_carol"));
  await x.control("member", x.member(account.organizationId, "user_dave"));
  await x.control("member", x.member(account.organizationId, "user_erin"));
  const refused = await checkout({ plan: "shop", requestKey: "shop-five" }, 409);
  assert.equal(refused.error.code, "people_limit_reached");
  assert.match(refused.error.message, /5 people.*Shop includes up to 4.*Studio/);
  assert.equal(stripe.customers.size, 0, "A refused plan creates no provider records");
  await x.call("user_alice", "DELETE", `${root}/members/user_erin`);
  await checkout({ plan: "shop", requestKey: "shop-four" });
});

test("Studio checkout accepts any number of people", async (t) => {
  const { x, account, checkout } = await setup(t);
  for (const user of ["user_bob", "user_carol", "user_dave", "user_erin", "user_frank"])
    await x.control("member", x.member(account.organizationId, user));
  await checkout({ plan: "studio", requestKey: "studio-six" });
});

test("merchant, catalog, and portal configuration are explicit and cannot fall back to another product", async (t) => {
  const { x, stripe, path, checkout } = await setup(t);
  stripe.control.accountId = "acct_other";
  await checkout({ plan: "shop", requestKey: "scope" }, 503);
  assert.equal(stripe.customers.size, 0);
  stripe.control.accountId = "acct_talkto";
  stripe.prices.price_shop.unit_amount = 100;
  await checkout({ plan: "shop", requestKey: "scope" }, 503);
  assert.equal(stripe.sessions.size, 0);
  stripe.prices.price_shop.unit_amount = 1200;
  // A Price from the earlier price list is refused even at the right amount.
  stripe.prices.price_shop.metadata.plan_version = "2026-09-09";
  await checkout({ plan: "shop", requestKey: "scope" }, 503);
  assert.equal(stripe.sessions.size, 0);
  stripe.prices.price_shop.metadata.plan_version = "2026-11-11";
  await checkout({ plan: "shop", requestKey: "scope" });
  assert.match((await x.call("user_alice", "POST", `${path}/portal`)).url, /^https:/);
  stripe.control.portalUpdates = true;
  await x.call("user_alice", "POST", `${path}/portal`, undefined, 503);
});

test("workspaces receive separate Customers and reject bindings from another Stripe environment", async (t) => {
  const { x, stripe, account, checkout, path } = await setup(t);
  const input = { plan: "shop", requestKey: "same-key" };
  await checkout(input);
  const other = await x.account();
  await x.call("user_alice", "POST", `/v1/accounts/${other.id}/billing/checkout`, input);
  assert.equal(stripe.customers.size, 2);
  const first = (
    await x.db
      .prepare("SELECT customer_id FROM workspace_billing WHERE account_id=?")
      .bind(account.id)
      .first()
  ).customer_id;
  const second = (
    await x.db
      .prepare("SELECT customer_id FROM workspace_billing WHERE account_id=?")
      .bind(other.id)
      .first()
  ).customer_id;
  assert.notEqual(first, second);
  await x.db
    .prepare("UPDATE workspace_billing SET provider_scope='another:environment' WHERE account_id=?")
    .bind(account.id)
    .run();
  await x.call("user_alice", "GET", path, undefined, 503);
  await checkout(input, 503);
  assert.equal(stripe.customers.size, 2);
});

test("a signed webhook is not acknowledged when its event cannot be durably stored", async (t) => {
  const { x, stripe, checkout } = await setup(t);
  await checkout({ plan: "shop", requestKey: "event-storage" });
  await x.db.prepare("ALTER TABLE stripe_events RENAME TO unavailable_events").run();
  const response = await event(x, [...stripe.customers.keys()][0]);
  assert.equal(response.status, 503);
});

test("an event received during reconciliation remains pending for a fresh provider read", async (t) => {
  const stripe = provider();
  const hold = { started: Promise.withResolvers(), release: Promise.withResolvers() };
  let holdNext = false;
  const x = await start(t, {
    stripeHandler: async (request) => {
      const response = await stripe.handler(request);
      if (holdNext && new URL(request.url).pathname === "/v1/invoices") {
        holdNext = false;
        hold.started.resolve();
        await hold.release.promise;
      }
      return response;
    },
  });
  const account = await x.account();
  const path = `/v1/accounts/${account.id}/billing`;
  await x.call("user_alice", "POST", `${path}/checkout`, { plan: "shop", requestKey: "race" });
  const payment = stripe.complete([...stripe.sessions.keys()][0]);
  await x.control("sync");
  await event(x, payment.session.customer);
  // The webhook's own application reads Stripe; hold it there.
  holdNext = true;
  const syncing = event(x, payment.session.customer);
  await hold.started.promise;
  try {
    payment.subscription.status = "past_due";
    payment.invoice.status = "open";
    await event(x, payment.session.customer, { type: "invoice.payment_failed" });
  } finally {
    hold.release.resolve();
  }
  assert.equal((await syncing).status, 200);
  const row = await x.db
    .prepare(
      "SELECT synced_event,(SELECT MAX(sequence) FROM stripe_events) AS head FROM workspace_billing WHERE account_id=?",
    )
    .bind(account.id)
    .first();
  assert.ok(row.synced_event < row.head);
  await x.control("sync");
  assert.equal((await x.call("user_alice", "GET", path)).subscription.status, "past_due");
});

test("paid invoice catch-up advances a durable bounded cursor and never reissues earlier periods", async (t) => {
  const { x, stripe, account, checkout, sync } = await setup(t);
  await checkout({ plan: "shop", requestKey: "history" });
  const payment = stripe.complete([...stripe.sessions.keys()][0]);
  const originalStart = payment.invoice.lines.data[0].period.start;
  for (let i = 1; i < 52; i++) {
    const invoice = structuredClone(payment.invoice);
    invoice.id = `in_month${i}`;
    invoice.billing_reason = "subscription_cycle";
    invoice.lines.data[0].period = {
      start: originalStart + i * 30 * 86400,
      end: originalStart + (i + 1) * 30 * 86400,
    };
    stripe.invoices.set(invoice.id, invoice);
    payment.subscription.latest_invoice = invoice.id;
  }
  await sync();
  assert.notEqual(
    (
      await x.db
        .prepare("SELECT invoice_cursor FROM workspace_billing WHERE account_id=?")
        .bind(account.id)
        .first()
    ).invoice_cursor,
    null,
  );
  await sync();
  assert.equal(
    (
      await x.db
        .prepare("SELECT invoice_cursor FROM workspace_billing WHERE account_id=?")
        .bind(account.id)
        .first()
    ).invoice_cursor,
    null,
  );
  assert.equal(
    (
      await x.db
        .prepare("SELECT COUNT(*) AS n,SUM(allowance) AS units FROM billing_periods")
        .first()
    ).n,
    52,
  );
  await event(x, payment.session.customer);
  await sync();
  assert.equal((await x.db.prepare("SELECT COUNT(*) AS n FROM billing_periods").first()).n, 52);
});

test("billing errors and spans retain request correlation and safe operations without credentials or provider payloads", async (t) => {
  const stripe = provider();
  const events = [];
  const bodies = [];
  const listeners = new Set();
  const received = (predicate) => {
    const present = events.find(predicate);
    if (present) return Promise.resolve(present);
    return new Promise((resolve) => {
      const listener = () => {
        const value = events.find(predicate);
        if (value) {
          listeners.delete(listener);
          resolve(value);
        }
      };
      listeners.add(listener);
    });
  };
  const x = await start(t, {
    stripeHandler: stripe.handler,
    telemetry: async (request) => {
      const body = await request.text();
      bodies.push(body);
      const lines = body.trim().split("\n");
      for (let i = 1; i + 1 < lines.length; i += 2) {
        if (["event", "transaction"].includes(JSON.parse(lines[i]).type))
          events.push(JSON.parse(lines[i + 1]));
      }
      for (const listener of listeners) listener();
      return Response.json({});
    },
  });
  const account = await x.account();
  stripe.control.lose = "/v1/customers";
  stripe.control.recoveryDown = true;
  const failed = await x.call(
    "user_alice",
    "POST",
    `/v1/accounts/${account.id}/billing/checkout`,
    { plan: "shop", requestKey: "telemetry" },
    503,
  );
  const error = await received(
    (value) => value.tags?.["talkto.request_id"] === failed.meta.requestId,
  );
  assert.equal(error.tags["talkto.code"], "billing_unavailable");
  assert.equal(error.tags["talkto.operation"], "stripe.customers.recover");
  const transaction = await received((value) =>
    value.spans?.some((span) => span.description === "Billing.checkout"),
  );
  assert.equal(transaction.contexts.trace.trace_id, error.contexts.trace.trace_id);
  assert.equal(
    events.filter(
      (value) => value.exception && value.tags?.["talkto.request_id"] === failed.meta.requestId,
    ).length,
    1,
  );
  assert.doesNotMatch(
    bodies.join("\n"),
    /rk_test_|whsec_|Bearer |Committed response lost|user_alice@example/,
  );
});

test("a completed checkout retains its subscription binding when provider listings lag", async (t) => {
  const { stripe, checkout, state } = await setup(t);
  const input = { plan: "shop", requestKey: "binding" };
  await checkout(input);
  const payment = stripe.complete([...stripe.sessions.keys()][0]);
  const subscriptionId = payment.session.subscription;
  payment.session.subscription = null;
  await checkout(input, 503);
  assert.deepEqual((await state()).checkout, input);
  await checkout({ plan: "shop", requestKey: "another" }, 409);
  payment.session.subscription = subscriptionId;
  stripe.control.hideSubscriptions = true;
  assert.deepEqual(await checkout(input), { status: "complete" });
  const bound = (await state()).paidPeriod;
  assert.equal(bound.allowance, plans.shop.messages);
  await checkout({ plan: "studio", requestKey: "new" }, 409);
  assert.equal(stripe.sessions.size, 1);
});

test("failed billing records cannot starve later workspaces in bounded recovery passes", async (t) => {
  const stripe = provider();
  const x = await start(t, { stripeHandler: stripe.handler });
  for (let i = 0; i < 32; i++) {
    const account = await x.account();
    await x.db
      .prepare(
        "INSERT INTO workspace_billing(account_id,provider_scope,customer_id) VALUES(?,'acct_talkto:test:test',?)",
      )
      .bind(account.id, `cus_missing${i}`)
      .run();
  }
  stripe.control.down = true;
  assert.equal((await x.control("sync")).status, 500);
  assert.equal(
    (await x.db.prepare("SELECT COUNT(*) AS n FROM workspace_billing WHERE attempted_at>0").first())
      .n,
    30,
  );
  assert.equal((await x.control("sync")).status, 500);
  assert.equal(
    (await x.db.prepare("SELECT COUNT(*) AS n FROM workspace_billing WHERE attempted_at>0").first())
      .n,
    32,
  );
});

test("cached Stripe write errors recover committed objects without waiting for key expiry", async (t) => {
  for (const resource of ["/v1/customers", "/v1/checkout/sessions"]) {
    await t.test(resource, async (t) => {
      const { stripe, checkout, state, sync } = await setup(t);
      const input = { plan: "shop", requestKey: "cached-error" };
      stripe.control.cacheError = resource;
      stripe.control.recoveryDown = true;
      await checkout(input, 503);
      assert.deepEqual((await state()).checkout, input);
      stripe.control.recoveryDown = false;
      await sync();
      assert.equal((await checkout(input)).status, "open");
      assert.equal(stripe.customers.size, 1);
      assert.equal(stripe.sessions.size, 1);
      const attempts = stripe.requests.filter(
        (request) => request.path === resource && request.method === "POST",
      );
      assert.ok(attempts.length >= 2, "The same provider key still returns its cached 500");
      assert.equal(new Set(attempts.map((request) => request.key)).size, 1);
    });
  }
});

test("received payments are reconciled ahead of older routine scans", async (t) => {
  const { x, stripe, checkout, state, sync } = await setup(t);
  for (let i = 0; i < 30; i++) {
    const account = await x.account();
    await x.db
      .prepare(
        "INSERT INTO workspace_billing(account_id,provider_scope,customer_id,checked_at,attempted_at) VALUES(?,'acct_talkto:test:test',?,'2020-01-01T00:00:00.000Z',1)",
      )
      .bind(account.id, `cus_idle${i}`)
      .run();
  }
  await checkout({ plan: "shop", requestKey: "paid" });
  const payment = stripe.complete([...stripe.sessions.keys()][0]);
  // Stripe is unreachable while the event arrives, so it waits for the scheduled repair.
  stripe.control.down = true;
  assert.equal((await event(x, payment.session.customer)).status, 200);
  stripe.control.down = false;
  await sync();
  const received = (await state()).paidPeriod;
  assert.equal(received.allowance, plans.shop.messages);
  assert.equal(
    (
      await x.db
        .prepare(
          "SELECT COUNT(*) AS n FROM workspace_billing WHERE checked_at>'2020-01-01T00:00:00.000Z'",
        )
        .first()
    ).n,
    30,
  );
});

test("payment priority preserves capacity for routine catch-up and stays bounded", async (t) => {
  const { x, stripe, sync } = await setup(t);
  // Sixty real workspaces with billing records due for a routine check, eight created at a time.
  await concurrently(60, 8, async (i) => {
    const account = await x.account();
    await x.db
      .prepare(
        "INSERT INTO workspace_billing(account_id,provider_scope,customer_id,checked_at,attempted_at) VALUES(?,'acct_talkto:test:test',?,'2020-01-01T00:00:00.000Z',1)",
      )
      .bind(account.id, `cus_queue${i}`)
      .run();
  });
  // Stripe is unreachable while events arrive for half of them, so each waits for the scheduled
  // repair.
  stripe.control.down = true;
  for (let i = 0; i < 30; i++) assert.equal((await event(x, `cus_queue${i}`)).status, 200);
  stripe.control.down = false;
  const scheduled = stripe.requests.length;
  await sync();
  const counts = await x.db
    .prepare(
      "SELECT COUNT(*) AS total,SUM(synced_event>0) AS payments,SUM(synced_event=0) AS routine FROM workspace_billing WHERE checked_at>'2020-01-01T00:00:00.000Z'",
    )
    .first();
  assert.deepEqual(counts, { total: 30, payments: 24, routine: 6 });
  await sync();
  assert.equal(
    (
      await x.db
        .prepare(
          "SELECT COUNT(*) AS n FROM workspace_billing WHERE checked_at>'2020-01-01T00:00:00.000Z'",
        )
        .first()
    ).n,
    60,
  );
  assert.equal(
    stripe.requests.slice(scheduled).filter((request) => request.path === "/v1/subscriptions")
      .length,
    60,
  );
});

test("provider trials never mint paid capacity, including historical replay after conversion", async (t) => {
  const { x, stripe, checkout, state, sync } = await setup(t, { metering: true });
  const input = { plan: "shop", requestKey: "provider-trial" };
  await checkout(input);
  const { subscription, invoice } = stripe.complete([...stripe.sessions.keys()][0]);
  subscription.status = "trialing";
  subscription.trial_start = invoice.lines.data[0].period.start;
  subscription.trial_end = subscription.trial_start + 7 * 86400;
  invoice.lines.data[0].period.end = subscription.trial_end;
  invoice.amount_paid = 0;
  invoice.lines.data[0].amount = 0;
  await checkout(input);
  assert.equal((await state()).paidPeriod, null);
  assert.equal((await state()).usage.status, "payment_required");
  subscription.status = "active";
  await event(x, invoice.customer);
  await sync();
  assert.equal((await state()).paidPeriod, null, "Historical trial invoice is still excluded");
  subscription.trial_start = null;
  subscription.trial_end = null;
  await event(x, invoice.customer);
  await sync();
  const discounted = (await state()).paidPeriod;
  assert.equal(discounted.allowance, plans.shop.messages, "A discounted paid period is valid");
});

test("canceled paid time blocks new checkout and legacy overlaps leave billing readable", async (t) => {
  const { x, stripe, account, checkout, state, sync } = await setup(t, { metering: true });
  const input = { plan: "shop", requestKey: "paid-through" };
  await checkout(input);
  const { subscription, invoice } = stripe.complete([...stripe.sessions.keys()][0]);
  await checkout(input);
  const paid = (await state()).paidPeriod;
  subscription.status = "canceled";
  await checkout({ plan: "shop", requestKey: "too-soon" }, 409);
  assert.equal(stripe.sessions.size, 1);
  assert.deepEqual((await state()).paidPeriod, paid);
  const overlap = structuredClone(invoice);
  overlap.id = "in_legacy_overlap";
  overlap.lines.data[0].id = "il_legacy_overlap";
  overlap.lines.data[0].period.start += 1;
  overlap.lines.data[0].period.end += 1;
  // Simulate evidence committed by the old implementation after the authority
  // had already accepted the original period.
  await x.db
    .prepare(`INSERT INTO billing_periods
    (account_id,subscription_id,invoice_id,line_id,plan,plan_version,start,end,allowance)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .bind(
      account.id,
      subscription.id,
      overlap.id,
      overlap.lines.data[0].id,
      "shop",
      paid.planVersion,
      new Date(Date.parse(paid.start) + 1).toISOString(),
      new Date(Date.parse(paid.end) + 1).toISOString(),
      40000,
    )
    .run();
  await sync();
  for (let i = 0; i < 2; i++) {
    const current = await state();
    assert.equal(current.issue, "period_conflict");
    assert.deepEqual(current.paidPeriod, paid);
    assert.equal(current.usage.status, "ready");
    assert.equal(current.usage.allowance, paid.allowance);
  }
});

test("returning from Checkout confirms the paid plan with Stripe at once, without webhooks or the cron", async (t) => {
  const { x, stripe, account, path, checkout, state } = await setup(t);
  const confirm = (user = "user_alice", status = 200) =>
    x.call(user, "POST", `${path}/checkout/confirm`, undefined, status);
  const input = { plan: "shop", requestKey: "return" };
  assert.equal((await checkout(input)).status, "open");
  // Back before paying: the checkout stays open and resumable.
  const open = await confirm();
  assert.deepEqual(open.checkout, input);
  assert.equal(open.paidPeriod, null);
  stripe.complete([...stripe.sessions.keys()][0]);
  // Until something reads Stripe, the stored checkout still looks pending.
  assert.deepEqual((await state()).checkout, input);
  const paid = await confirm();
  assert.equal(paid.checkout, null);
  assert.equal(paid.subscription.status, "active");
  assert.equal(paid.subscription.payment, "paid");
  assert.equal(paid.paidPeriod.allowance, plans.shop.messages);
  const stored = await state();
  assert.deepEqual(stored, { ...paid, usage: stored.usage });
  // Repeating it is harmless and grants nothing twice.
  await confirm();
  assert.equal((await x.db.prepare("SELECT COUNT(*) AS n FROM billing_periods").first()).n, 1);
  // Only the owner triggers Stripe reads.
  await x.control("member", x.member(account.organizationId));
  await confirm("user_bob", 403);
});

test("returning while another billing operation holds the workspace answers with the current state", async (t) => {
  const { x, account, path, checkout } = await setup(t);
  await checkout({ plan: "shop", requestKey: "busy" });
  await x.db
    .prepare("UPDATE workspace_billing SET lease='other',lease_until=? WHERE account_id=?")
    .bind(Date.now() + 60000, account.id)
    .run();
  const busy = await x.call("user_alice", "POST", `${path}/checkout/confirm`);
  assert.equal(busy.checkout.requestKey, "busy");
});

test("a payment event is applied when it arrives, not at the next cron", async (t) => {
  const { x, stripe, account, checkout, state } = await setup(t);
  await checkout({ plan: "studio", requestKey: "webhook" });
  const payment = stripe.complete([...stripe.sessions.keys()][0]);
  assert.equal(
    (await event(x, payment.session.customer, { type: "checkout.session.completed" })).status,
    200,
  );
  const paid = await state();
  assert.equal(paid.checkout, null);
  assert.equal(paid.paidPeriod.allowance, plans.studio.messages);
  const row = await x.db
    .prepare(
      "SELECT synced_event,(SELECT MAX(sequence) FROM stripe_events) AS head FROM workspace_billing WHERE account_id=?",
    )
    .bind(account.id)
    .first();
  assert.equal(row.synced_event, row.head);
  // A provider outage while applying still acknowledges the stored event; the cron applies it.
  stripe.control.down = true;
  payment.subscription.cancel_at_period_end = true;
  assert.equal((await event(x, payment.session.customer)).status, 200);
  stripe.control.down = false;
  assert.equal((await state()).subscription.cancelAtPeriodEnd, false);
  const sync = await x.control("sync");
  assert.equal(sync.status, 200);
  assert.equal((await state()).subscription.cancelAtPeriodEnd, true);
});

test("a full refund ends the paid month and pauses sends; a partial refund and duplicates change nothing", async (t) => {
  const { x, stripe, account, checkout, state } = await setup(t, { metering: true });
  await checkout({ plan: "studio", requestKey: "refunded" });
  const payment = stripe.complete([...stripe.sessions.keys()][0]);
  const customer = payment.session.customer;
  await event(x, customer, { type: "checkout.session.completed" });
  const paid = await state();
  assert.equal(paid.usage.status, "ready");
  assert.equal(paid.revocation, undefined);
  // The read and admin budgets follow the paid plan, and a refund ends them with it.
  const budgets = async () =>
    (await (await x.control(`quota/budgets?account=${account.id}`)).json()).usage.terms;
  assert.deepEqual([(await budgets()).plan, (await budgets()).paid], ["studio", true]);
  // A partial refund is a courtesy credit: the plan stays.
  const charge = stripe.refund(payment.invoice.id, 500);
  const refunded = (id) =>
    event(x, customer, { id, type: "charge.refunded", object: { id: charge.id, customer } });
  assert.equal((await refunded(`evt_${randomUUID().replaceAll("-", "")}`)).status, 200);
  assert.equal((await state()).usage.status, "ready");
  assert.equal((await state()).revocation, undefined);
  stripe.refund(payment.invoice.id);
  const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
  assert.equal((await refunded(eventId)).status, 200);
  const ended = await state();
  assert.equal(ended.revocation.reason, "refund");
  assert.equal(ended.usage.status, "payment_required");
  assert.equal(ended.usage.available, 0);
  assert.equal(ended.paidPeriod.start, paid.paidPeriod.start, "the invoice evidence is kept");
  assert.deepEqual([(await budgets()).plan, (await budgets()).paid], ["free", false]);
  const rows = async () =>
    (
      await x.db
        .prepare(
          "SELECT charge_id,invoice_id,reason,status,revoked_at FROM billing_revocations WHERE account_id=?",
        )
        .bind(account.id)
        .all()
    ).results;
  const [row] = await rows();
  assert.deepEqual(
    [row.charge_id, row.invoice_id, row.reason, row.status],
    [charge.id, payment.invoice.id, "refund", "active"],
  );
  // A redelivered event and the cron change nothing, including when the period ended.
  assert.equal((await refunded(eventId)).status, 200);
  assert.equal((await x.control("sync")).status, 200);
  assert.deepEqual(await rows(), [row]);
  assert.equal((await state()).revocation.at, row.revoked_at);
  // Messages over MCP are refused like an unpaid plan.
  const server = await x.server(account.id);
  const credential = await x.mcpToken(account.organizationId);
  const registered = await x.mcp(credential, "register_participant", {
    serverId: server.id,
    name: "refunded-agent",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  const sent = await x.mcp(
    credential,
    "send_message",
    {
      serverId: server.id,
      participantId: registered.data.item.id,
      target: { kind: "conversation", conversationId: registered.data.generalConversationId },
      body: "after the refund",
      requestKey: randomUUID(),
    },
    true,
  );
  assert.match(JSON.stringify(sent), /payment_required/);
});

test("a dispute pauses the paid month, a won dispute restores it, and the reason stays recorded", async (t) => {
  const { x, stripe, account, checkout, state } = await setup(t, { metering: true });
  await checkout({ plan: "factory", requestKey: "disputed" });
  const payment = stripe.complete([...stripe.sessions.keys()][0]);
  const customer = payment.session.customer;
  await event(x, customer, { type: "checkout.session.completed" });
  const paid = await state();
  assert.equal(paid.usage.status, "ready");
  const { charge } = stripe.dispute(payment.invoice.id);
  // A dispute event names its charge, not its customer.
  const disputed = (type) =>
    event(x, null, { type, object: { id: `dp_${charge.id}`, charge: charge.id } });
  assert.equal((await disputed("charge.dispute.created")).status, 200);
  const paused = await state();
  assert.equal(paused.revocation.reason, "dispute");
  assert.equal(paused.usage.status, "payment_required");
  stripe.dispute(payment.invoice.id, "won");
  assert.equal((await disputed("charge.dispute.closed")).status, 200);
  const restored = await state();
  assert.equal(restored.revocation, undefined);
  assert.equal(restored.usage.status, "ready");
  assert.equal(restored.usage.periodEnd, paid.usage.periodEnd);
  const row = await x.db
    .prepare("SELECT reason,status FROM billing_revocations WHERE account_id=?")
    .bind(account.id)
    .first();
  assert.deepEqual([row.reason, row.status], ["dispute", "cleared"]);
  // A lost dispute keeps the month ended.
  stripe.dispute(payment.invoice.id, "lost");
  await disputed("charge.dispute.closed");
  assert.equal((await state()).revocation.reason, "dispute");
  // A charge Stripe no longer knows is skipped without holding up reconciliation.
  assert.equal(
    (await event(x, customer, { type: "charge.refunded", object: { id: "ch_missing", customer } }))
      .status,
    200,
  );
  assert.equal((await state()).revocation.reason, "dispute");
});

test("a refund that cannot be read yet leaves the rest of billing applied and is retried", async (t) => {
  const { x, stripe, account, checkout, state, sync } = await setup(t, { metering: true });
  await checkout({ plan: "studio", requestKey: "denied" });
  const payment = stripe.complete([...stripe.sessions.keys()][0]);
  const customer = payment.session.customer;
  await event(x, customer, { type: "checkout.session.completed" });
  const charge = stripe.refund(payment.invoice.id);
  stripe.control.chargesDenied = true;
  payment.subscription.cancel_at_period_end = true;
  await event(x, customer, { type: "charge.refunded", object: { id: charge.id, customer } });
  const waiting = await state();
  assert.equal(waiting.subscription.cancelAtPeriodEnd, true, "other changes still apply");
  assert.equal(waiting.revocation, undefined);
  const row = await x.db
    .prepare(
      "SELECT synced_event,(SELECT MAX(sequence) FROM stripe_events) AS head FROM workspace_billing WHERE account_id=?",
    )
    .bind(account.id)
    .first();
  assert.ok(row.synced_event < row.head, "the refund event stays pending");
  stripe.control.chargesDenied = false;
  await sync();
  assert.equal((await state()).revocation.reason, "refund");
});
