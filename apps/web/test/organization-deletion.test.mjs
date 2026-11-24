import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

/* The organization Settings danger zone and its typed-name dialog (docs/dashboard-api.md). */

const user = {
  id: "user_alice",
  email: "alice@example.com",
  emailVerified: true,
  firstName: "Alice",
  lastName: null,
};
const accountId = "6f0c3e1b-9a52-4c1e-8f0d-2b6c7a1e4d90";
const plan = (extra = {}) => ({
  accountId,
  name: "alice@example.com",
  status: "ready",
  servers: [
    { id: "srv_0000000000000000000000000001", name: "Development", agents: 3 },
    { id: "srv_0000000000000000000000000002", name: "Launch room", agents: null },
  ],
  otherMembers: 2,
  guests: 1,
  pendingInvitations: 1,
  plan: "shop",
  paidThrough: "2026-12-20T00:00:00.000Z",
  freeStart: false,
  lastOrganization: false,
  website: true,
  ...extra,
});

async function setup(t) {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const settings = await vite.ssrLoadModule("/src/organization-settings.tsx");
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
  return { settings, services, render };
}

test("the danger zone lists the servers, people and plan that go, and what stays", async (t) => {
  const { settings, services, render } = await setup(t);
  services.queries.setQueryData(["human", user.id, accountId, "organization-deletion"], {
    data: plan(),
    meta: { requestId: randomUUID(), serverTime: new Date().toISOString() },
  });
  const account = {
    id: accountId,
    organizationId: "org_01",
    name: "alice@example.com",
    permissions: { rename: true },
  };
  const html = await render(() => createElement(settings.OrganizationSettings, { account }));
  const text = words(html);
  assert.ok(html.indexOf("Rename organization…") < html.indexOf("Delete organization…"));
  assert.match(text, /Permanently delete alice@example\.com and everything in it\./);
  assert.match(
    text,
    /All 2 servers, with their messages, channels, direct chats, files and agents\./,
  );
  assert.match(text, /Development 3 agents/);
  assert.match(text, /Launch room agents unknown/);
  assert.match(
    text,
    /Access for 2 other members and 1 guest\. They keep their TalkTo accounts, and each member gets an email that you deleted it\./,
  );
  assert.match(text, /1 pending invitation, canceled\./);
  assert.match(
    text,
    /The Shop plan ends now, with no refund for the time paid through December 20, 2026\./,
  );
  assert.match(text, /Your TalkTo account and your other organizations\./);
  assert.match(text, /Messages already counted stay counted\./);
  assert.doesNotMatch(text, /last organization/);
  assert.match(html, /<button class="ops-danger">Delete organization…<\/button>/);
});

test("the last organization says the account stays and the free start does not return", async (t) => {
  const { settings, render } = await setup(t);
  const last = plan({
    servers: [],
    otherMembers: 0,
    guests: 0,
    pendingInvitations: 0,
    plan: null,
    paidThrough: null,
    freeStart: true,
    lastOrganization: true,
  });
  const text = words(
    await render(() => createElement(settings.DeleteOrganizationSection, { plan: last })),
  );
  assert.match(text, /Its servers: it has none\./);
  assert.doesNotMatch(text, /Access for|plan ends now|other organizations/);
  assert.match(text, /Your TalkTo account\./);
  assert.match(text, /the free start this organization used does not return\./);
  assert.match(
    text,
    /This is your last organization\. You can create a new one afterwards, but it won’t start free again\./,
  );
  // Without the website session the action is off, and the page says why.
  const token = await render(() =>
    createElement(settings.DeleteOrganizationSection, { plan: plan({ website: false }) }),
  );
  assert.match(words(token), /only while signed in on the TalkTo website/);
  assert.match(token, /<button class="ops-danger" disabled="">Delete organization…<\/button>/);
});

test("the dialog asks for the exact current name before deleting", async (t) => {
  const { settings, render } = await setup(t);
  const html = await render(() =>
    createElement(settings.DeleteOrganizationDialog, { plan: plan(), close: () => {} }),
  );
  const text = words(html);
  assert.match(text, /Delete this organization\?/);
  assert.match(
    text,
    /This permanently deletes alice@example\.com and 2 servers, and removes 2 other members\. The Shop plan ends now, with no refund\. There is no undo\./,
  );
  assert.match(text, /Type alice@example\.com to confirm/);
  assert.match(
    html,
    /<button type="submit" class="ops-danger" disabled="">Delete organization permanently<\/button>/,
  );
});
