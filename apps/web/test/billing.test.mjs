import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createServer as createVite } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { start } from "../../server/test/platform-harness.mjs";
import { provider, event } from "../../server/test/billing-provider.mjs";
import { plans } from "@talkto/api/pricing";

test("a paid subscription after a rejected trial keeps cancellation and resume controls", async (t) => {
  const stripe = provider();
  const app = await start(t, { stripeHandler: stripe.handler, metering: true, trials: true });
  const account = await app.account();
  const path = `/v1/accounts/${account.id}/billing`;
  const call = (method, suffix = "", payload) =>
    app.call("user_alice", method, path + suffix, payload);
  const trial = { plan: "shop", offer: "trial", requestKey: "rejected-trial" };
  await call("POST", "/checkout", trial);
  stripe.control.funding = "prepaid";
  const rejected = stripe.complete([...stripe.sessions.keys()][0]);
  await call("POST", "/checkout", trial);
  assert.equal(rejected.subscription.status, "canceled");
  assert.equal((await call("GET")).trial.status, "rejected");
  assert.equal((await call("GET")).usage.allowance, 0);
  const paid = { plan: "shop", requestKey: "paid-after-rejection" };
  await call("POST", "/checkout", paid);
  stripe.complete([...stripe.sessions.keys()].at(-1));
  await call("POST", "/checkout", paid);

  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { BillingPage } = await vite.ssrLoadModule("/src/billing.tsx");
  const { createServices, Services, Human } = await vite.ssrLoadModule("/src/session.tsx");
  const services = createServices("https://talkto.test");
  t.after(() => services.queries.clear());
  const user = (await app.call("user_alice", "GET", "/v1/me")).user;
  const root = createRootRoute({
    component: () => createElement(BillingPage, { accountId: account.id }),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const render = (state) => {
    services.queries.setQueryData(["human", user.id, account.id, "billing"], { data: state });
    return renderToStaticMarkup(
      createElement(
        Services.Provider,
        { value: services },
        createElement(
          QueryClientProvider,
          { client: services.queries },
          createElement(Human.Provider, { value: user }, createElement(RouterProvider, { router })),
        ),
      ),
    );
  };
  const active = await call("GET");
  assert.equal(active.trial.status, "rejected", "keep the anti-abuse claim");
  assert.equal(active.subscription.status, "active");
  assert.equal(active.usage.allowance, plans.shop.messages);
  assert.match(render(active), />Cancel renewal<\/button>/);
  assert.doesNotMatch(
    render({ ...active, permissions: { ...active.permissions, manageBilling: false } }),
    />Cancel renewal<\/button>/,
  );
  assert.doesNotMatch(
    render({ ...active, subscription: { ...active.subscription, status: "trialing" } }),
    />Cancel trial renewal<\/button>/,
  );
  await call("POST", "/renewal", { cancel: true, requestKey: "cancel-paid-after-rejection" });
  const canceled = await call("GET");
  assert.equal(canceled.subscription.cancelAtPeriodEnd, true);
  assert.match(render(canceled), />Resume renewal<\/button>/);
  await call("POST", "/renewal", { cancel: false, requestKey: "resume-paid-after-rejection" });
  const resumed = await call("GET");
  assert.equal(resumed.subscription.cancelAtPeriodEnd, false);
  assert.deepEqual(resumed.paidPeriod, active.paidPeriod);
  assert.match(render(resumed), />Cancel renewal<\/button>/);
});

test("Billing shows each plan's listed allowance, and the Plan panel the month billing recorded", async (t) => {
  const stripe = provider();
  const app = await start(t, { stripeHandler: stripe.handler, metering: true });
  const account = await app.account();
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { BillingPage } = await vite.ssrLoadModule("/src/billing.tsx");
  const { createServices, Services, Human } = await vite.ssrLoadModule("/src/session.tsx");
  const services = createServices("https://talkto.test");
  t.after(() => services.queries.clear());
  const user = (await app.call("user_alice", "GET", "/v1/me")).user;
  const root = createRootRoute({
    component: () => createElement(BillingPage, { accountId: account.id }),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const text = (state) => {
    services.queries.setQueryData(["human", user.id, account.id, "billing"], { data: state });
    return renderToStaticMarkup(
      createElement(
        Services.Provider,
        { value: services },
        createElement(
          QueryClientProvider,
          { client: services.queries },
          createElement(Human.Provider, { value: user }, createElement(RouterProvider, { router })),
        ),
      ),
    )
      .replaceAll("<!-- -->", "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
  };
  const unpaid = await app.call("user_alice", "GET", `/v1/accounts/${account.id}/billing`);
  const on = (asOf) => ({ ...unpaid, usage: { ...unpaid.usage, asOf } });
  // Plan cards: each plan's listed numbers, whatever the date (owner decision, November 16, 2026).
  for (const asOf of ["2026-11-16T12:00:00.000Z", "2027-03-31T20:00:00.000Z"]) {
    const cards = text(on(asOf));
    for (const line of [
      "40,000 messages / month",
      "25 GB storage",
      "250,000 messages / month",
      "100 GB storage",
      "750,000 messages / month",
      "500 GB storage",
    ])
      assert.ok(cards.includes(line), `${asOf}: ${line}`);
    assert.doesNotMatch(cards, /beta|bonus/i, `${asOf}: nothing on top of the plans`);
  }
  // The Plan panel shows the messages billing recorded for the month.
  const subscribed = (start, end, allowance, asOf) => ({
    ...on(asOf),
    subscription: { plan: "shop", status: "active", cancelAtPeriodEnd: false, payment: "paid" },
    paidPeriod: { plan: "shop", planVersion: "2026-11-11", start, end, allowance },
  });
  // A month recorded with more messages before the change keeps them; storage is the plan's pool.
  const recordedMonth = text(
    subscribed(
      "2026-11-10T20:00:00.000Z",
      "2026-12-10T20:00:00.000Z",
      60000,
      "2026-11-16T12:00:00.000Z",
    ),
  );
  assert.ok(recordedMonth.includes("$12 / month · 60,000 messages · 25 GB storage"));
  assert.doesNotMatch(recordedMonth, /beta|bonus/i);
  const baseMonth = text(
    subscribed(
      "2027-04-30T20:00:00.000Z",
      "2027-05-30T20:00:00.000Z",
      40000,
      "2027-05-05T00:00:00.000Z",
    ),
  );
  assert.ok(baseMonth.includes("$12 / month · 40,000 messages · 25 GB storage"));
  assert.doesNotMatch(baseMonth, /beta|bonus/i);
});

test("billing browser client recovers committed checkout and cancellation, paid usage and permissions", async (t) => {
  const stripe = provider();
  const app = await start(t, { stripeHandler: stripe.handler, metering: true });
  const account = await app.account();
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { createApi, request, ApiError } = await vite.ssrLoadModule("/src/api.ts");
  const recovery = await vite.ssrLoadModule("/src/billing-recovery.ts");
  const saved = new Map();
  const storage = () => ({
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: (key) => saved.delete(key),
  });
  const mutations = [];
  let drop = true;
  let user = "user_alice";
  const http = createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    if (req.method === "POST" && body.length)
      mutations.push({ path: req.url, input: JSON.parse(Buffer.concat(body).toString()) });
    const response = await app.raw(req.url, {
      method: req.method,
      headers: {
        authorization: `Bearer ${await app.token(user)}`,
        "content-type": "application/json",
      },
      body: body.length ? Buffer.concat(body) : undefined,
    });
    if (drop && req.method === "POST") {
      drop = false;
      await response.arrayBuffer();
      res.destroy();
      return;
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    http.closeAllConnections();
    http.close();
  });
  const api = createApi(`http://127.0.0.1:${http.address().port}`).billing;
  const params = { accountId: account.id };
  const initial = (await request(api.state({ params }))).data;
  assert.equal(initial.usage.status, "payment_required");
  assert.equal(initial.permissions.manageBilling, true);
  let payload = { plan: "shop", requestKey: "billing-browser-lost-response" };
  await assert.rejects(
    request(api.checkout({ params, payload })),
    (e) => e instanceof ApiError && e.code === "connection_unavailable",
  );
  const pending = (await request(api.state({ params }))).data;
  assert.deepEqual(pending.checkout, payload);
  const open = (await request(api.checkout({ params, payload: pending.checkout }))).data;
  assert.equal(open.status, "open");
  assert.equal(stripe.sessions.size, 1);
  const created = stripe.requests.find(
    (r) => r.path === "/v1/checkout/sessions" && r.method === "POST",
  );
  assert.equal(
    new URL(created.input.get("success_url")).pathname,
    `/app/accounts/${account.id}/billing`,
  );
  drop = true;
  await assert.rejects(
    request(api.cancelCheckout({ params, payload })),
    (e) => e instanceof ApiError && e.code === "connection_unavailable",
  );
  assert.equal((await request(api.state({ params }))).data.checkout, null);
  assert.equal((await request(api.cancelCheckout({ params, payload }))).data.status, "expired");
  assert.equal((await request(api.checkout({ params, payload }))).data.status, "expired");
  payload = { ...payload, requestKey: "billing-browser-after-cancel" };
  assert.equal((await request(api.checkout({ params, payload }))).data.status, "open");
  stripe.complete([...stripe.sessions.keys()].at(-1));
  // The return page confirms with Stripe directly; no webhook or cron has run.
  const paid = (await request(api.confirmCheckout({ params }), undefined, "billing")).data;
  assert.equal(paid.checkout, null);
  assert.equal((await request(api.checkout({ params, payload }))).data.status, "complete");
  assert.equal(paid.subscription.payment, "paid");
  assert.equal(paid.usage.allowance, plans.shop.messages);
  assert.equal(paid.usage.overdraft, 500);
  assert.equal(paid.usage.status, "ready");
  let recoveryStore = recovery.storage(user, account.id, storage);
  const cancelRenewal = {
    kind: "renewal",
    input: { cancel: true, requestKey: "browser-renewal-lost-reply" },
  };
  assert.deepEqual(recoveryStore.write(cancelRenewal).success, cancelRenewal);
  drop = true;
  await assert.rejects(
    request(api.renewal({ params, payload: cancelRenewal.input })),
    (e) => e instanceof ApiError && e.code === "connection_unavailable",
  );
  assert.equal((await request(api.state({ params }))).data.subscription.cancelAtPeriodEnd, true);
  recoveryStore = recovery.storage(user, account.id, storage);
  const resumed = recoveryStore.read().success;
  assert.deepEqual(resumed, cancelRenewal, "reload retains cancellation instead of toggling it");
  assert.equal(recovery.storage("user_bob", account.id, storage).read().success, null);
  assert.equal(recovery.storage(user, "another-organization", storage).read().success, null);
  const confirmed = (await request(api.renewal({ params, payload: resumed.input }))).data;
  assert.equal(confirmed.confirmed, true);
  assert.deepEqual(
    mutations.filter((entry) => entry.path.endsWith("/renewal")).map((entry) => entry.input),
    [cancelRenewal.input, cancelRenewal.input],
  );
  assert.equal(recoveryStore.write(null).success, null);
  assert.equal(recovery.storage(user, account.id, storage).read().success, null);
  const resumeRenewal = {
    kind: "renewal",
    input: { cancel: false, requestKey: "browser-new-resume-intent" },
  };
  assert.deepEqual(recoveryStore.write(resumeRenewal).success, resumeRenewal);
  assert.equal(
    (await request(api.renewal({ params, payload: resumeRenewal.input }))).data.confirmed,
    true,
  );
  assert.equal((await request(api.state({ params }))).data.subscription.cancelAtPeriodEnd, false);
  recoveryStore.write(null);
  assert.equal(stripe.subscriptions.size, 1);
  assert.equal(stripe.invoices.size, 1, "cancel/resume does not create another paid invoice");
  assert.ok((await request(api.portal({ params }))).data.url.startsWith("https://"));
  const portal = stripe.requests.find((r) => r.path === "/v1/billing_portal/sessions");
  assert.equal(
    new URL(portal.input.get("return_url")).pathname,
    `/app/accounts/${account.id}/billing`,
  );
  await app.control("member", app.member(account.organizationId));
  user = "user_bob";
  assert.equal((await request(api.state({ params }))).data.permissions.manageBilling, false);
  await assert.rejects(
    request(api.portal({ params })),
    (e) => e instanceof ApiError && e.code === "forbidden",
  );
  await assert.rejects(
    request(api.cancelCheckout({ params, payload })),
    (e) => e instanceof ApiError && e.code === "forbidden",
  );
});

test("billing recovery rejects corrupted or blocked browser storage and retains conversion intent", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const recovery = await vite.ssrLoadModule("/src/billing-recovery.ts");
  const saved = new Map();
  const browser = () => ({
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: (key) => saved.delete(key),
  });
  const store = recovery.storage("user_alice", "trial-account", browser);
  const conversion = { kind: "startPaid", requestKey: "deliberate-paid-conversion" };
  assert.deepEqual(store.write(conversion).success, conversion);
  assert.deepEqual(
    recovery.storage("user_alice", "trial-account", browser).read().success,
    conversion,
  );
  assert.equal(saved.size, 1, "reading recovery never starts or replaces an action");
  const key = [...saved.keys()][0];
  for (const value of [
    "not json",
    JSON.stringify({ ...conversion, requestKey: null }),
    JSON.stringify({ kind: "renewal", input: { requestKey: "missing-direction" } }),
  ]) {
    saved.set(key, value);
    assert.equal(store.read().failure._tag, "BillingRecoveryUnavailable");
  }
  const blocked = recovery.storage("user_alice", "trial-account", () => {
    throw new Error("Storage disabled");
  });
  assert.equal(blocked.read().failure._tag, "BillingRecoveryUnavailable");
  assert.equal(blocked.write(conversion).failure._tag, "BillingRecoveryUnavailable");
  assert.equal(blocked.write(null).failure._tag, "BillingRecoveryUnavailable");
});

test("billing display follows confirmed periods and provider lifecycle without inventing a free allowance", async (t) => {
  const stripe = provider();
  const app = await start(t, { stripeHandler: stripe.handler, metering: true });
  const account = await app.account();
  const path = `/v1/accounts/${account.id}/billing`;
  const state = () => app.call("user_alice", "GET", path);
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { currentPaidPeriod, canStartSubscription, subscriptionSummary } =
    await vite.ssrLoadModule("/src/billing-state.ts");

  const initial = await state();
  assert.equal(subscriptionSummary(initial).label, "No subscription");
  assert.equal(canStartSubscription(initial), true);
  assert.equal(currentPaidPeriod(initial), null);
  assert.equal(initial.usage.status, "payment_required");

  const input = { plan: "shop", requestKey: "billing-lifecycle" };
  await app.call("user_alice", "POST", `${path}/checkout`, input);
  const pending = await state();
  assert.match(subscriptionSummary(pending).detail, /no subscription is confirmed/);
  assert.equal(currentPaidPeriod(pending), null);
  const paid = stripe.complete([...stripe.sessions.keys()][0]);
  await app.call("user_alice", "POST", `${path}/checkout`, input);
  const active = await state();
  assert.equal(subscriptionSummary(active).label, "Active");
  assert.deepEqual(currentPaidPeriod(active), active.paidPeriod);
  assert.equal(canStartSubscription(active), false);
  const at = (asOf) => ({ ...active, usage: { ...active.usage, asOf } });
  assert.equal(
    currentPaidPeriod(at(new Date(Date.parse(active.paidPeriod.start) - 1).toISOString())),
    null,
  );
  assert.deepEqual(currentPaidPeriod(at(active.paidPeriod.start)), active.paidPeriod);
  assert.equal(
    currentPaidPeriod(at(active.paidPeriod.end)),
    null,
    "a retained historical invoice must not imply current payment",
  );
  assert.equal(subscriptionSummary(at(active.paidPeriod.end)).label, "Awaiting paid period");

  const observe = async () => {
    assert.equal(
      (await event(app, paid.session.customer, { type: "customer.subscription.updated" })).status,
      200,
    );
    const synced = await app.control("sync");
    assert.equal(synced.status, 200, await synced.text());
    return state();
  };
  for (const [status, label, canSubscribe] of [
    ["past_due", "Payment past due", false],
    ["unpaid", "Unpaid", false],
    ["paused", "Paused", false],
    ["trialing", "Trial reported by Stripe", false],
    ["incomplete", "Payment incomplete", false],
    ["incomplete_expired", "Expired", false],
    ["canceled", "Canceled", false],
  ]) {
    paid.subscription.status = status;
    const result = await observe();
    assert.equal(subscriptionSummary(result).label, label);
    assert.equal(canStartSubscription(result), canSubscribe);
    assert.equal(
      result.usage.allowance,
      plans.shop.messages,
      "provider lifecycle changes do not mint another allowance",
    );
  }
  paid.subscription.status = "active";
  paid.subscription.cancel_at_period_end = true;
  assert.equal(subscriptionSummary(await observe()).label, "Renewal canceled");
  paid.invoice.status = "open";
  const overdue = await observe();
  assert.equal(
    subscriptionSummary(overdue).label,
    "Payment needs attention",
    "canceled renewal must not hide payment trouble",
  );
  assert.equal(
    overdue.usage.status,
    "ready",
    "an unpaid invoice does not erase an already paid period",
  );

  const unmeteredApp = await start(t, { stripeHandler: provider().handler });
  const unmeteredAccount = await unmeteredApp.account();
  const unmetered = await unmeteredApp.call(
    "user_alice",
    "GET",
    `/v1/accounts/${unmeteredAccount.id}/billing`,
  );
  assert.equal(unmetered.usage.status, "unmetered");
  assert.equal(subscriptionSummary(unmetered).label, "No subscription");
  assert.equal(currentPaidPeriod(unmetered), null);
  assert.equal(unmetered.usage.allowance, 0, "unmetered rollout is not a free-plan quota");
});

test("Billing offers plan changes and explains an upgrade and a scheduled downgrade", async (t) => {
  const stripe = provider();
  const app = await start(t, { stripeHandler: stripe.handler, metering: true });
  const account = await app.account();
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { BillingPage } = await vite.ssrLoadModule("/src/billing.tsx");
  const { createServices, Services, Human } = await vite.ssrLoadModule("/src/session.tsx");
  const services = createServices("https://talkto.test");
  t.after(() => services.queries.clear());
  const user = (await app.call("user_alice", "GET", "/v1/me")).user;
  const root = createRootRoute({
    component: () => createElement(BillingPage, { accountId: account.id }),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const text = (state) => {
    services.queries.setQueryData(["human", user.id, account.id, "billing"], { data: state });
    return renderToStaticMarkup(
      createElement(
        Services.Provider,
        { value: services },
        createElement(
          QueryClientProvider,
          { client: services.queries },
          createElement(Human.Provider, { value: user }, createElement(RouterProvider, { router })),
        ),
      ),
    )
      .replaceAll("<!-- -->", "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
  };
  const unpaid = await app.call("user_alice", "GET", `/v1/accounts/${account.id}/billing`);
  const end = "2027-05-31T00:00:00.000Z";
  const shop = {
    ...unpaid,
    usage: { ...unpaid.usage, asOf: "2027-05-11T00:00:00.000Z" },
    subscription: { plan: "shop", status: "active", cancelAtPeriodEnd: false, payment: "paid" },
    paidPeriod: {
      plan: "shop",
      planVersion: "2026-11-11",
      start: "2027-05-01T00:00:00.000Z",
      end,
      allowance: 40000,
    },
  };
  const offered = text(shop);
  assert.match(offered, /Change plan A bigger plan starts now/);
  assert.match(offered, /A smaller plan starts at your next renewal/);
  // TalkTo changes the plan itself; the Stripe portal is for payment details only.
  assert.match(offered, /Move to Studio Move to Factory/);
  assert.doesNotMatch(offered, /Move to Shop/);
  const { PlanChangeTerms } = await vite.ssrLoadModule("/src/billing.tsx");
  const terms = (from, to) =>
    renderToStaticMarkup(createElement(PlanChangeTerms, { from, to, renewsAt: end }))
      .replaceAll("<!-- -->", "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
  assert.match(
    terms("shop", "studio"),
    /charged now for the difference between \$12 and \$60 for the rest of this billing month\. Studio’s limits start when the payment goes through.* If the payment fails, nothing changes\./,
  );
  assert.match(
    terms("studio", "shop"),
    /Studio stays until your renewal on .*\. Then Shop starts at \$12 \/ month, with up to 4 people and .* storage\. If the organization has more than 4 people then, counting pending invitations, the move is canceled and Studio continues\. No file is removed.*This month is not refunded\./,
  );
  assert.doesNotMatch(
    text({ ...shop, permissions: { manageBilling: false } }),
    /Change plan/,
    "only the owner changes plan",
  );
  assert.match(
    text({ ...shop, subscription: { ...shop.subscription, cancelAtPeriodEnd: true } }),
    /Resume renewal to change plan/,
  );
  // Ten days in, Shop moved to Studio: two thirds of the extra 210,000 messages.
  const upgraded = text({
    ...shop,
    subscription: { ...shop.subscription, plan: "studio" },
    paidPeriod: {
      ...shop.paidPeriod,
      plan: "studio",
      allowance: 180000,
      upgrade: { from: "shop", at: "2027-05-11T00:00:00.000Z" },
    },
  });
  assert.match(upgraded, /\$60 \/ month · 180,000 messages/);
  assert.match(upgraded, /Upgraded from Shop on .* This billing month includes 180,000 messages/);
  assert.doesNotMatch(upgraded, /beta|bonus/i);
  // Studio with a move to Shop at the renewal: the limits, and the way to keep Studio.
  const downgrade = text({
    ...shop,
    subscription: {
      plan: "studio",
      status: "active",
      cancelAtPeriodEnd: false,
      payment: "paid",
      change: { plan: "shop", at: end },
    },
    paidPeriod: { ...shop.paidPeriod, plan: "studio", allowance: 250000 },
  });
  assert.match(downgrade, /Moves to Shop on .*, at \$12 \/ month/);
  assert.match(
    downgrade,
    /Shop includes up to 4 people and 25 GB storage\. If the organization has more than 4 people then, counting pending invitations, the move is canceled and Studio continues\. Remove people to 4 or fewer before then to switch to Shop\./,
  );
  assert.match(downgrade, /Canceling renewal also cancels this move/);
  assert.match(downgrade, /Shop starts at your next renewal\. Keep Studio to cancel that change\./);
  assert.match(downgrade, /Keep Studio/);
  assert.doesNotMatch(downgrade, /Move to Factory/);
  // A refunded or disputed payment: the month ended early and sends are paused.
  const reversed = (reason) =>
    text({
      ...shop,
      usage: {
        ...shop.usage,
        status: "payment_required",
        periodStart: shop.paidPeriod.start,
        periodEnd: "2027-05-10T00:00:00.000Z",
      },
      revocation: { reason, at: "2027-05-10T00:00:00.000Z" },
    });
  assert.match(
    reversed("refund"),
    /payment was refunded, so the paid plan ended on .*\. New sends are paused; history remains readable\. Sending resumes with the next paid renewal\./,
  );
  assert.match(
    reversed("dispute"),
    /payment is disputed, so the paid plan is paused from .*Sending resumes if the dispute is decided in your favor/,
  );
  assert.match(reversed("refund"), /until its payment was reversed/);
  assert.doesNotMatch(text(shop), /refunded|disputed/);
  // A move to Shop kept off at the renewal because of the people limit.
  const kept = text({
    ...shop,
    subscription: { ...shop.subscription, plan: "studio" },
    paidPeriod: { ...shop.paidPeriod, plan: "studio", allowance: 250000 },
    downgradeKept: { plan: "shop", kept: "studio", at: end, people: 6 },
  });
  assert.match(
    kept,
    /The move to Shop at the renewal on .* was canceled: the organization had 6 people, counting pending invitations, and Shop includes up to 4\. Studio continues\. Remove people to 4 or fewer to switch to Shop\./,
  );
  assert.doesNotMatch(text(shop), /was canceled/);
});
