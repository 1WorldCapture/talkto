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
const plan = { messages: 2000, servers: 1, historyDays: 30 };
/** A starter state while the Free plan applies: no free-trial offer, the Free plan named. */
const onFree = (status, extra = {}) => ({
  offer: null,
  free: plan,
  status,
  grant: null,
  asOf,
  ...extra,
});
const month = (used) => ({
  serverId,
  activatedAt: "2026-11-10T09:00:00.000Z",
  allowance: 2000,
  used,
  remaining: 2000 - used,
  renewsAt: "2026-12-01T00:00:00.000Z",
});

async function setup(t) {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const starter = await vite.ssrLoadModule("/src/starter.tsx");
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
  return { starter, render };
}

test("with the Free plan on, the first-server offer and its denials speak of the Free plan", async (t) => {
  const { starter, render } = await setup(t);
  const offerFor = (value) => render(() => createElement(starter.StarterOffer, { state: value }));
  const eligible = words(await offerFor(onFree("eligible")));
  assert.match(eligible, /Free plan: 2,000 messages a month\. No credit card\./);
  assert.match(eligible, /start again each month/);
  assert.match(eligible, /Message history is kept for 30 days\./);
  assert.doesNotMatch(eligible, /trial|carry over|No time limit/);
  assert.match(words(await offerFor(onFree("verify_email"))), /to start the Free plan/);
  assert.match(words(await offerFor(onFree("sign_in_required"))), /to start the Free plan/);
  assert.match(words(await offerFor(onFree("used"))), /The Free plan is once per person\./);
  assert.match(
    words(await offerFor(onFree("paused"))),
    /The Free plan is temporarily unavailable\./,
  );
  assert.equal(await offerFor(onFree("unavailable")), "");
});

test("the Free plan panel counts this month, says when it starts again, and offers a plan at the cap", async (t) => {
  const { starter, render } = await setup(t);
  const panel = (value) =>
    render(() =>
      createElement(starter.StarterPanel, { state: value, manage: true, plans: "#plans" }),
    );
  const active = await panel(onFree("active", { grant: month(120) }));
  assert.match(active, /<h2>Free plan<\/h2>/);
  assert.match(active, /aria-label="Free plan messages used"/);
  assert.match(words(active), /1,880 of 2,000 left/);
  assert.match(words(active), /Starts again on December 1\./);
  assert.match(words(active), /History is kept for 30 days\./);
  assert.doesNotMatch(words(active), /trial|No time limit|carry over/);
  const exhausted = await panel(onFree("exhausted", { grant: month(2000) }));
  assert.match(
    words(exhausted),
    /You’ve used this month’s 2,000 Free plan messages\. Sending resumes next month, or choose a plan to keep sending now\./,
  );
  assert.match(words(exhausted), /Starts again on December 1\. History stays readable\./);
  assert.match(exhausted, /<a class="btn" href="#plans">Choose a plan<\/a>/);
  assert.equal(await panel(onFree("converted", { grant: month(10) })), "");
});
