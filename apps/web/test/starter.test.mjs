import assert from "node:assert/strict";
import { test } from "node:test";
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
import { words } from "./copy-rules.mjs";

const accountId = "6f0c3e1b-9a52-4c1e-8f0d-2b6c7a1e4d90";
const serverId = "9a1f7c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b";
const user = {
  id: "user_alice",
  email: "alice@example.com",
  emailVerified: true,
  firstName: "Alice",
  lastName: null,
  profilePictureUrl: null,
};
const asOf = "2026-11-12T12:00:00.000Z";
const offer = { messages: 500, servers: 1 };
const grant = (used) => ({
  serverId,
  activatedAt: "2026-11-10T09:00:00.000Z",
  allowance: 500,
  used,
  remaining: 500 - used,
});
const state = (status, extra = {}) => ({ offer, status, grant: null, asOf, ...extra });

async function setup(t) {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const starter = await vite.ssrLoadModule("/src/starter.tsx");
  const { BillingPage } = await vite.ssrLoadModule("/src/billing.tsx");
  const { ApiError } = await vite.ssrLoadModule("/src/api.ts");
  const { createServices, Services, Human } = await vite.ssrLoadModule("/src/session.tsx");
  const services = createServices("https://talkto.test");
  t.after(() => services.queries.clear());
  const render = async (component) => {
    const router = createRouter({
      routeTree: createRootRoute({ component }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
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
  return { starter, BillingPage, ApiError, services, render };
}

test("the first-server offer and its denials say what happens next", async (t) => {
  const { starter, render } = await setup(t);
  const offerFor = (value) => render(() => createElement(starter.StarterOffer, { state: value }));
  const eligible = words(await offerFor(state("eligible")));
  assert.match(eligible, /Free trial: 500 messages\. No credit card\. No time limit\./);
  assert.match(eligible, /Leftover messages carry over when you choose a plan\./);
  assert.match(eligible, /One starter server\./);
  assert.match(eligible, /Reading and searching don’t use them\./);
  // Switched off: nothing is offered, whatever the person's eligibility.
  assert.equal(await offerFor({ ...state("eligible"), offer: null }), "");
  assert.equal(await offerFor(state("unavailable")), "");
  assert.match(words(await offerFor(state("verify_email"))), /Verify your email/);
  assert.match(
    words(await offerFor(state("paused"))),
    /Free trials are temporarily unavailable\. Try again later or choose a plan\./,
  );
  // Without a plan the owner cannot add another server, so neither denial promises one.
  const used = words(await offerFor(state("used")));
  assert.match(used, /The free trial is once per person\. Choose a plan to keep sending\./);
  assert.doesNotMatch(used, /create a server/);
  assert.match(
    words(await offerFor(state("server_limit"))),
    /You already have a server without a plan, which is the limit\. Use that server, or choose a plan to add another\./,
  );
  assert.match(words(await offerFor(state("sign_in_required"))), /Sign in again/);
  assert.equal(await offerFor(state("active", { grant: grant(10) })), "");
});

test("remaining messages have no countdown, and the cap offers an explicit paid plan", async (t) => {
  const { starter, render } = await setup(t);
  const panel = (value, props = {}) =>
    render(() =>
      createElement(starter.StarterPanel, {
        state: value,
        manage: true,
        plans: "#plans",
        ...props,
      }),
    );
  const active = await panel(state("active", { grant: grant(32) }));
  const activeText = words(active);
  assert.match(activeText, /468 of 500 left/);
  assert.match(activeText, /No time limit\./);
  assert.match(activeText, /Reading and searching don’t use messages\./);
  assert.match(activeText, /Leftover messages carry over when you choose a plan\./);
  assert.match(active, /role="meter"[^>]*aria-valuenow="32"/);
  assert.match(active, /<a class="btn secondary" href="#plans">Choose a plan<\/a>/);
  // "Free trial" names the offer; it still never counts down.
  assert.doesNotMatch(activeText, /expire|days? left|ends on|renew/i);

  const exhausted = await panel(state("exhausted", { grant: grant(500) }));
  assert.match(
    words(exhausted),
    /You’ve used your 500 free trial messages\. Choose a plan to keep sending\./,
  );
  assert.match(words(exhausted), /History stays readable\. Nothing is charged automatically\./);
  assert.match(exhausted, /<a class="btn" href="#plans">Choose a plan<\/a>/);
  const member = await panel(state("exhausted", { grant: grant(500) }), { manage: false });
  assert.doesNotMatch(member, /Choose a plan<\/a>/);
  assert.match(words(member), /Ask the organization owner to choose a plan\./);
  assert.match(
    words(await panel(state("exhausted", { grant: grant(500) }), { plans: null })),
    /Paid plans are not available here yet\./,
  );
  assert.match(words(await panel(state("provisioning", { grant: grant(0) }))), /being set up/);
  // A paid plan replaced the allowance: nothing here; billing shows what carried over.
  assert.equal(await panel(state("converted", { grant: grant(120) })), "");
});

test("billing shows the free start in place of usage, and keeps it when paid billing is off", async (t) => {
  const { BillingPage, ApiError, services, render } = await setup(t);
  services.queries.setQueryData(["human", user.id, accountId, "starter"], {
    data: state("active", { grant: grant(41) }),
  });
  const billingKey = ["human", user.id, accountId, "billing"];
  const page = () => render(() => createElement(BillingPage, { accountId }));
  services.queries.setQueryData(billingKey, {
    data: {
      plans: [
        { key: "shop", name: "Shop", monthlyCents: 1200, messages: 40000, peopleLimit: 4 },
        { key: "studio", name: "Studio", monthlyCents: 6000, messages: 250000, peopleLimit: null },
        {
          key: "factory",
          name: "Factory",
          monthlyCents: 15000,
          messages: 750000,
          peopleLimit: null,
        },
      ],
      subscription: null,
      checkout: null,
      paidPeriod: null,
      issue: null,
      trial: null,
      trialAvailable: false,
      usage: {
        status: "ready",
        periodStart: "2026-11-10T09:00:00.000Z",
        periodEnd: null,
        allowance: 500,
        overdraft: 0,
        used: 32,
        outstanding: 32,
        usageUpperBound: 64,
        available: 436,
        asOf,
        lastReportedAt: null,
        kind: "starter",
      },
      checkedAt: null,
      permissions: { manageBilling: true },
    },
  });
  const withBilling = await page();
  assert.match(words(withBilling), /459 of 500 left/);
  assert.match(withBilling, /href="#plans">Choose a plan</);
  assert.match(withBilling, /id="plans"/);
  assert.doesNotMatch(words(withBilling), /Courtesy overdraft|Period ends/);

  services.queries.removeQueries({ queryKey: billingKey });
  // A rendered error stays an error instead of refetching on mount (server rendering never fetches).
  services.queries.setQueryDefaults(billingKey, { retryOnMount: false });
  services.queries
    .getQueryCache()
    .build(services.queries, { queryKey: billingKey })
    .setState({
      status: "error",
      fetchStatus: "idle",
      error: new ApiError("billing_unavailable", "Billing is not enabled in this environment."),
    });
  const withoutBilling = await page();
  assert.match(words(withoutBilling), /459 of 500 left/);
  assert.match(words(withoutBilling), /Paid plans are not available here yet\./);
  assert.doesNotMatch(words(withoutBilling), /Billing is not enabled/);
});

test("after paying, billing says how many free trial messages carried over", async (t) => {
  const { BillingPage, services, render } = await setup(t);
  services.queries.setQueryData(["human", user.id, accountId, "starter"], {
    data: state("converted", { grant: grant(40) }),
  });
  const start = "2026-11-12T09:00:00.000Z";
  const end = "2026-12-12T09:00:00.000Z";
  const paid = (carriedOver) => ({
    data: {
      plans: [{ key: "shop", name: "Shop", monthlyCents: 1200, messages: 40000, peopleLimit: 4 }],
      subscription: { plan: "shop", status: "active", cancelAtPeriodEnd: false, payment: "paid" },
      checkout: null,
      paidPeriod: { plan: "shop", planVersion: "2026-11-11", start, end, allowance: 60000 },
      issue: null,
      trial: null,
      trialAvailable: false,
      usage: {
        status: "ready",
        periodStart: start,
        periodEnd: end,
        allowance: 60000 + carriedOver,
        overdraft: 500,
        used: 10,
        outstanding: 0,
        usageUpperBound: 10,
        available: 60490,
        asOf,
        lastReportedAt: null,
        kind: "paid",
        carriedOver,
      },
      checkedAt: null,
      permissions: { manageBilling: true },
    },
  });
  const billingKey = ["human", user.id, accountId, "billing"];
  services.queries.setQueryData(billingKey, paid(460));
  const carried = words(await render(() => createElement(BillingPage, { accountId })));
  assert.match(carried, /60,460/);
  assert.match(carried, /Includes 460 free trial messages carried over, for this period\./);
  assert.doesNotMatch(carried, /460 of 500 left/, "the free trial panel is gone once paid");
  services.queries.setQueryData(billingKey, paid(0));
  const none = words(await render(() => createElement(BillingPage, { accountId })));
  assert.doesNotMatch(none, /carried over/);
});
