import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";
import { provider, event } from "./billing-provider.mjs";
import { plans, storageGigabytes } from "@talkto/api/pricing";

const day = 86400;

/** A subscription on `plan`, waiting for its first payment. */
const setup = async (t, plan, people = [], options = {}) => {
  const stripe = provider();
  const x = await start(t, { stripeHandler: stripe.handler, metering: true, ...options });
  const account = await x.account();
  for (const user of people) await x.control("member", x.member(account.organizationId, user));
  const path = `/v1/accounts/${account.id}/billing`;
  const state = () => x.call("user_alice", "GET", path);
  const sync = async () => {
    const response = await x.control("sync");
    assert.equal(response.status, 200, await response.text());
  };
  const storage = async () => (await x.control(`storage?account=${account.id}`)).json();
  const invite = (email, status = 200) =>
    x.call("user_alice", "POST", `/v1/accounts/${account.id}/invitations`, { email }, status);
  const move = (plan, requestKey, status = 200, user = "user_alice") =>
    x.call(user, "POST", `${path}/plan`, { plan, requestKey }, status);
  const input = { plan, requestKey: `buy-${plan}` };
  await x.call("user_alice", "POST", `${path}/checkout`, input);
  return { x, stripe, account, path, state, sync, storage, invite, move, input };
};
const paid = async (context, shift = 0) => {
  const { x, stripe, path, input } = context;
  const payment = stripe.complete([...stripe.sessions.keys()][0]);
  // Move the first month back in time, so an upgrade now falls inside it.
  if (shift !== 0) {
    payment.invoice.lines.data[0].period.start -= shift;
    payment.invoice.lines.data[0].period.end -= shift;
    payment.subscription.items.data[0].current_period_start -= shift;
    payment.subscription.items.data[0].current_period_end -= shift;
  }
  await x.call("user_alice", "POST", `${path}/checkout`, input);
  return payment;
};
const posts = (stripe, pattern) =>
  stripe.requests.filter((value) => value.method === "POST" && pattern.test(value.path));
/** The prorated share of the bigger plan's messages, from the paid upgrade invoice Stripe made. */
const share = (stripe, subscription, from, to, period) => {
  const charge = stripe.invoices.get(subscription.latest_invoice).lines.data[1];
  const start = Date.parse(period.start);
  const end = Date.parse(period.end);
  assert.equal(charge.period.end * 1000, end);
  const difference = plans[to].messages - plans[from].messages;
  return Math.ceil((difference * (end - charge.period.start * 1000)) / (end - start));
};

test("an upgrade is charged now, starts the new plan's limits, and adds its prorated messages once", async (t) => {
  const context = await setup(t, "shop", ["user_bob", "user_carol", "user_dave"]);
  const { x, stripe, account, state, sync, storage, invite, move } = context;
  // The month started 10 days ago.
  const { subscription } = await paid(context, 10 * day);
  await sync();
  const before = await state();
  assert.equal(before.paidPeriod.plan, "shop");
  // Shop holds 4 people; the owner cannot invite a fifth.
  assert.equal((await invite("erin@example.com", 409)).error.code, "people_limit_reached");

  assert.deepEqual(await move("studio", "to-studio"), { confirmed: true });
  const [update] = posts(stripe, /^\/v1\/subscriptions\//);
  assert.equal(update.input.get("items[0][price]"), "price_studio");
  assert.equal(update.input.get("items[0][id]"), "si_test");
  assert.equal(update.input.get("proration_behavior"), "always_invoice");
  assert.equal(update.input.get("payment_behavior"), "error_if_incomplete");
  assert.match(update.key, /^talkto:acct_talkto:test:test:plan-upgrade-studio:.+:to-studio$/);

  // The paid proration invoice was read in the same request: Studio applies now.
  const start = before.paidPeriod.start;
  const extra = share(stripe, subscription, "shop", "studio", before.paidPeriod);
  const upgraded = await state();
  assert.equal(upgraded.subscription.plan, "studio");
  assert.equal(upgraded.subscription.change, undefined);
  assert.equal(upgraded.paidPeriod.plan, "studio");
  assert.equal(upgraded.paidPeriod.start, start);
  assert.equal(upgraded.paidPeriod.end, before.paidPeriod.end);
  assert.equal(upgraded.paidPeriod.allowance, plans.shop.messages + extra);
  assert.equal(upgraded.paidPeriod.upgrade.from, "shop");
  // About two thirds of Studio's extra messages are left for the 20 days.
  assert.ok(Math.abs(extra / (plans.studio.messages - plans.shop.messages) - 2 / 3) < 0.01);
  // The quota authority raised the same period: counters kept, no new period.
  assert.equal(upgraded.usage.periodStart, start);
  assert.equal(upgraded.usage.allowance, upgraded.paidPeriod.allowance);
  assert.equal(upgraded.issue, null);
  const pooled = await storage();
  assert.equal(pooled.plan, "studio");
  assert.equal(pooled.limitBytes, storageGigabytes.studio * 1_000_000_000);
  // Studio has unlimited people.
  await invite("erin@example.com");

  // A retried request, a webhook and a repair change nothing and charge nothing more.
  const invoices = stripe.invoices.size;
  assert.deepEqual(await move("studio", "to-studio"), { confirmed: true });
  await event(x, subscription.customer);
  await sync();
  assert.equal(stripe.invoices.size, invoices);
  assert.deepEqual((await state()).paidPeriod, upgraded.paidPeriod);
  const count = (table) =>
    x.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id=?`).bind(account.id).first();
  assert.equal((await count("billing_plan_changes")).n, 1);
  assert.equal((await count("billing_periods")).n, 1);

  // A second upgrade, to Factory, adds its own share on top.
  await move("factory", "to-factory");
  const factory = await state();
  const more = share(stripe, subscription, "studio", "factory", before.paidPeriod);
  assert.equal(factory.paidPeriod.plan, "factory");
  assert.equal(factory.paidPeriod.allowance, plans.shop.messages + extra + more);
  assert.equal(factory.paidPeriod.upgrade.from, "shop");
  assert.equal(factory.usage.allowance, factory.paidPeriod.allowance);
});

test("a declined upgrade payment changes nothing", async (t) => {
  const context = await setup(t, "shop");
  const { x, stripe, state, sync, move } = context;
  const { subscription } = await paid(context, day);
  await sync();
  const before = await state();
  stripe.control.declineUpgrade = true;
  const refused = await move("studio", "declined", 409);
  assert.equal(refused.error.code, "billing_conflict");
  assert.match(refused.error.message, /did not go through, so the plan did not change/);
  assert.doesNotMatch(JSON.stringify(refused), /PRIVATE_DECLINE_DIAGNOSTIC/);
  const after = await state();
  assert.equal(after.subscription.plan, "shop");
  assert.deepEqual(after.paidPeriod, before.paidPeriod);
  assert.equal(after.usage.allowance, before.usage.allowance);
  // A new card and a new confirmation work.
  stripe.control.declineUpgrade = false;
  await move("studio", "after-new-card");
  assert.equal((await state()).paidPeriod.plan, "studio");

  // An upgrade invoice that is still open grants nothing until Stripe confirms payment.
  const invoice = stripe.upgrade(subscription.id, "factory", Math.floor(Date.now() / 1000), "open");
  await event(x, subscription.customer);
  await sync();
  assert.equal((await state()).paidPeriod.plan, "studio");
  invoice.status = "paid";
  await event(x, subscription.customer);
  await sync();
  assert.equal((await state()).paidPeriod.plan, "factory");
});

test("a downgrade is scheduled for the period end, and can be kept off, replaced, or dropped by canceling renewal", async (t) => {
  const context = await setup(t, "factory");
  const { x, stripe, path, state, sync, move } = context;
  const { subscription } = await paid(context);
  await sync();
  const item = subscription.items.data[0];
  const at = new Date(item.current_period_end * 1000).toISOString();

  assert.deepEqual(await move("shop", "to-shop"), { confirmed: true });
  const [create] = posts(stripe, /^\/v1\/subscription_schedules$/);
  assert.equal(create.input.get("from_subscription"), subscription.id);
  assert.match(create.key, /:plan-schedule-shop:.+:to-shop$/);
  const [update] = posts(stripe, /^\/v1\/subscription_schedules\/[^/]+$/);
  assert.equal(update.input.get("phases[0][items][0][price]"), "price_factory");
  assert.equal(update.input.get("phases[1][items][0][price]"), "price_shop");
  assert.equal(update.input.get("metadata[app]"), "talkto");
  assert.match(update.key, /:plan-downgrade-shop:.+:to-shop$/);
  const schedule = stripe.schedules.get(subscription.schedule);
  assert.equal(schedule.end_behavior, "release");
  const scheduled = await state();
  assert.deepEqual(scheduled.subscription.change, { plan: "shop", at });
  // Nothing changes, and nothing is charged or refunded, before the period ends.
  assert.equal(scheduled.subscription.plan, "factory");
  assert.equal(scheduled.paidPeriod.plan, "factory");
  assert.equal(posts(stripe, /^\/v1\/subscriptions\//).length, 0);
  // A retry is the same schedule.
  await move("shop", "to-shop");
  assert.equal(stripe.schedules.size, 1);
  // Another smaller plan replaces the scheduled one.
  await move("studio", "to-studio");
  assert.equal(stripe.schedules.size, 1);
  assert.deepEqual((await state()).subscription.change, { plan: "studio", at });

  // Keep Factory: the schedule is released and the change disappears.
  await x.call("user_alice", "POST", `${path}/plan/keep`, { requestKey: "keep-factory" });
  assert.equal(schedule.status, "released");
  assert.equal((await state()).subscription.change, undefined);

  // Choosing the current plan also drops a scheduled move.
  await move("shop", "again");
  await move("factory", "stay");
  assert.equal((await state()).subscription.change, undefined);

  // Canceling renewal releases a scheduled change first; Stripe refuses it otherwise.
  await move("shop", "once-more");
  await x.call("user_alice", "POST", `${path}/renewal`, { cancel: true, requestKey: "stop" });
  const canceled = await state();
  assert.equal(canceled.subscription.cancelAtPeriodEnd, true);
  assert.equal(canceled.subscription.change, undefined);
  assert.match((await move("shop", "while-canceled", 409)).error.message, /Resume renewal/);
  await sync();
  assert.equal((await state()).subscription.change, undefined);
});

test("an upgrade replaces a scheduled downgrade", async (t) => {
  const context = await setup(t, "studio");
  const { stripe, state, sync, move } = context;
  const { subscription } = await paid(context, day);
  await sync();
  await move("shop", "to-shop");
  const schedule = stripe.schedules.get(subscription.schedule);
  await move("factory", "to-factory");
  assert.equal(schedule.status, "released");
  const upgraded = await state();
  assert.equal(upgraded.subscription.plan, "factory");
  assert.equal(upgraded.subscription.change, undefined);
  assert.equal(upgraded.paidPeriod.plan, "factory");
});

test("a move to Shop is canceled when more than 4 people are in the organization shortly before the renewal", async (t) => {
  const context = await setup(t, "studio", ["user_bob", "user_carol"], { email: "fake" });
  const { x, stripe, account, state, sync, move } = context;
  // The Studio month ends in 30 minutes.
  const { subscription } = await paid(context, 30 * day - 1800);
  await sync();
  await move("shop", "to-shop");
  const schedule = stripe.schedules.get(subscription.schedule);
  const { at } = (await state()).subscription.change;
  // Three people fit Shop: the move stays.
  await sync();
  assert.equal(schedule.status, "active");
  assert.equal((await state()).subscription.change.plan, "shop");
  // Two more join on Studio after the move was scheduled.
  for (const user of ["user_dave", "user_erin"])
    await x.control("member", x.member(account.organizationId, user));
  await sync();
  assert.equal(schedule.status, "released");
  const [release] = posts(stripe, /^\/v1\/subscription_schedules\/[^/]+\/release$/);
  assert.match(release.key, new RegExp(`:people-shop-${Date.parse(at)}$`));
  const kept = await state();
  assert.equal(kept.subscription.plan, "studio");
  assert.equal(kept.subscription.change, undefined);
  assert.deepEqual(kept.downgradeKept, { plan: "shop", kept: "studio", at, people: 5 });
  // The owner is told once, however often the cron runs.
  await sync();
  await sync();
  const holds = await x.db
    .prepare("SELECT plan,kept,people FROM billing_plan_holds WHERE account_id=?")
    .bind(account.id)
    .all();
  assert.deepEqual(holds.results, [{ plan: "shop", kept: "studio", people: 5 }]);
  const emails = (await (await x.control("email-sent")).json()).flatMap((b) => b.messages);
  const notices = emails.filter((message) => /stays on Studio/.test(message.subject));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].to, "user_alice@example.com");
  assert.match(notices[0].text, /it has 5 people, counting pending invitations/);
  assert.match(notices[0].text, new RegExp(`/app/accounts/${account.id}/billing`));
  // Choosing Shop again is refused with the way out.
  const refused = await move("shop", "again", 409);
  assert.equal(refused.error.code, "people_limit_reached");
  assert.match(
    refused.error.message,
    /Remove people or cancel invitations to 4 or fewer to switch to Shop/,
  );
});

test("after a downgrade to Shop, people above its limit stay but no one new can be invited", async (t) => {
  const context = await setup(t, "studio", ["user_bob", "user_carol"]);
  const { x, stripe, account, state, sync, storage, invite, move } = context;
  // The Studio month ended a minute ago; Stripe has not renewed it yet.
  const { subscription } = await paid(context, 30 * day + 60);
  await sync();
  await move("shop", "to-shop");
  // People joined after the move was scheduled and after the last check before the renewal
  // (the month already ended), so Shop starts anyway: the fallback below applies.
  for (const user of ["user_dave", "user_erin", "user_frank"])
    await x.control("member", x.member(account.organizationId, user));
  // Stripe starts the next phase at the renewal and the Shop invoice is paid.
  const renewal = stripe.renew(subscription.id);
  await event(x, subscription.customer);
  await sync();
  const shop = await state();
  const start = new Date(renewal.lines.data[0].period.start * 1000).toISOString();
  assert.equal(shop.subscription.plan, "shop");
  assert.equal(shop.subscription.change, undefined);
  assert.equal(shop.paidPeriod.plan, "shop");
  assert.equal(shop.paidPeriod.start, start);
  assert.equal(shop.paidPeriod.allowance, plans.shop.messages);
  assert.equal(shop.paidPeriod.upgrade, undefined);
  assert.equal(shop.usage.allowance, plans.shop.messages);
  assert.equal((await storage()).plan, "shop");
  // Six people stay; a seventh is refused with the way out.
  const refused = await invite("grace@example.com", 409);
  assert.equal(refused.error.code, "people_limit_reached");
  assert.match(refused.error.message, /Studio/);
  const members = await x.call("user_alice", "GET", `/v1/accounts/${account.id}/members`);
  assert.equal(members.items.filter((member) => member.status === "active").length, 6);
});

test("plan changes need the owner, an active paid subscription, people within the new plan, and a portal without switching", async (t) => {
  const context = await setup(t, "studio", ["user_bob", "user_carol", "user_dave", "user_erin"]);
  const { x, stripe, path, state, sync, move } = context;
  // Before the first payment there is nothing to change.
  await move("factory", "early", 409);
  await paid(context);
  await sync();
  // Five people do not fit Shop; nothing is scheduled.
  assert.equal((await move("shop", "too-many", 409)).error.code, "people_limit_reached");
  assert.equal(stripe.schedules.size, 0);
  // The current plan with nothing scheduled is a no-op.
  assert.deepEqual(await move("studio", "same"), { confirmed: true });
  assert.equal(posts(stripe, /^\/v1\/subscription/).length, 0);
  // Only the owner changes plan.
  await move("factory", "bob", 403, "user_bob");
  await x.call("user_bob", "POST", `${path}/plan/keep`, { requestKey: "bob" }, 403);
  // Unknown plans and extra fields are refused.
  await x.call("user_alice", "POST", `${path}/plan`, { plan: "enterprise", requestKey: "x" }, 400);
  await x.call(
    "user_alice",
    "POST",
    `${path}/plan`,
    { plan: "factory", requestKey: "x", price: "price_other" },
    400,
  );
  assert.equal((await state()).subscription.plan, "studio");
  // The portal is for payment details only: a portal that switches plans is refused.
  await x.call("user_alice", "POST", `${path}/portal`);
  stripe.control.portalUpdates = true;
  assert.equal(
    (await x.call("user_alice", "POST", `${path}/portal`, undefined, 503)).error.code,
    "billing_unavailable",
  );
});
