import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
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

const user = {
  id: "user_alice",
  email: "Alice@Example.com",
  emailVerified: true,
  firstName: "Alice",
  lastName: null,
};
const solo = {
  accountId: "6f0c3e1b-9a52-4c1e-8f0d-2b6c7a1e4d90",
  name: "Side project",
  servers: 2,
  otherMembers: 0,
  plan: "shop",
};
const team = {
  accountId: "9a1f7c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b",
  name: "Product studio",
  servers: 3,
  otherMembers: 2,
  plan: null,
};
const plan = (extra = {}) => ({
  email: user.email,
  status: "ready",
  deleted: [solo],
  blocked: [],
  memberships: 1,
  servers: [],
  website: true,
  ...extra,
});
const meta = () => ({
  requestId: randomUUID(),
  serverTime: new Date().toISOString(),
  instructions: { url: "https://talkto.test/instructions", text: "Instructions" },
});

async function setup(t) {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const account = await vite.ssrLoadModule("/src/account.tsx");
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
  const { createApi } = await vite.ssrLoadModule("/src/api.ts");
  return { account, render, services, createApi };
}

const submit = (html) => html.match(/<button type="submit"[^>]*>[^<]*<\/button>/)[0];

test("the account page says what is deleted and what stays, and opens deletion", async (t) => {
  const { account, render, services } = await setup(t);
  services.queries.setQueryData(["human", user.id, "account-deletion"], {
    data: plan(),
    meta: meta(),
  });
  const html = await render(() => createElement(account.AccountSettings));
  const text = words(html);
  assert.match(text, /Signed in as Alice@Example\.com/);
  assert.match(text, /Deleting your account is permanent\. TalkTo cannot restore it\./);
  assert.match(text, /Your sign-in and profile\./);
  assert.match(text, /Side project 2 servers · Shop plan/);
  assert.match(text, /The paid plan on Side project ends at once and is not renewed\./);
  assert.match(text, /Your membership of 1 organization other people own\./);
  assert.match(text, /Messages you and your agents sent in organizations other people own\./);
  assert.match(text, /yours under a neutral name such as “former-person”\./);
  assert.match(text, /up to 30 days/);
  assert.match(html, /<button class="ops-danger">Delete account…<\/button>/);
});

test("servers the person created in other people's organizations are listed with a link to delete each", async (t) => {
  const { account, render } = await setup(t);
  const created = {
    serverId: "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a",
    name: "Research",
    accountId: team.accountId,
    organization: "Product studio",
  };
  const html = await render(() =>
    createElement(account.DeleteAccountSection, { plan: plan({ servers: [created] }) }),
  );
  const text = words(html);
  assert.match(
    text,
    /Servers you created in other people’s organizations stay with those organizations\. To remove one, delete it first\./,
  );
  assert.match(text, /Research Product studio Delete server/);
  assert.match(
    html,
    new RegExp(
      `href="/app/accounts/${team.accountId}/servers/${created.serverId}\\?tab=settings"[^>]*>Delete server</a>`,
    ),
  );
  const none = words(
    await render(() => createElement(account.DeleteAccountSection, { plan: plan() })),
  );
  assert.doesNotMatch(none, /Servers you created/);
  assert.doesNotMatch(none, /Delete server/);
});

test("an owned organization with other members blocks deletion and says how to unblock it", async (t) => {
  const { account, render } = await setup(t);
  const blocked = plan({ status: "blocked", blocked: [team] });
  const html = await render(() => createElement(account.DeleteAccountSection, { plan: blocked }));
  const text = words(html);
  assert.match(
    text,
    /You own Product studio ?, which has 2 other members\. Ownership can’t be transferred yet: remove the other members on its Members page ?, or delete it from its Settings ?, then come back\./,
  );
  assert.match(html, new RegExp(`href="/app/accounts/${team.accountId}/members"`));
  assert.match(html, new RegExp(`href="/app/accounts/${team.accountId}/settings"`));
  assert.match(html, /<button class="ops-danger" disabled="">Delete account…<\/button>/);
  const token = await render(() =>
    createElement(account.DeleteAccountSection, { plan: plan({ website: false }) }),
  );
  assert.match(words(token), /only while signed in on the TalkTo website/);
  assert.match(token, /<button class="ops-danger" disabled="">Delete account…<\/button>/);
});

test("deletion stays disabled until the account email is typed, then sends it", async (t) => {
  const { account, render, createApi } = await setup(t);
  const form = (confirmation) =>
    render(() =>
      createElement(account.DeleteAccountForm, {
        plan: plan(),
        servers: 2,
        confirmation,
        change: () => {},
        submit: () => {},
        pending: false,
        error: null,
        close: () => {},
      }),
    );
  const empty = await form("");
  assert.match(words(empty), /Type Alice@Example\.com to confirm/);
  assert.match(words(empty), /1 organization and 2 servers/);
  assert.match(submit(empty), /disabled=""/);
  assert.match(submit(await form("alice@example.org")), /disabled=""/);
  const typed = await form("  alice@example.com ");
  assert.doesNotMatch(submit(typed), /disabled/);
  assert.match(submit(typed), />Delete account permanently</);
  assert.equal(account.confirms(user.email, ""), false);
  assert.equal(account.confirms(user.email, "ALICE@EXAMPLE.COM"), true);

  const requests = [];
  const http = createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    requests.push({
      method: req.method,
      path: req.url,
      input: JSON.parse(Buffer.concat(body).toString()),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { status: "finishing" }, meta: meta() }));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    http.closeAllConnections();
    http.close();
  });
  const api = createApi(`http://127.0.0.1:${http.address().port}`);
  const result = await account.deleteAccount(api, "alice@example.com");
  assert.deepEqual(result.data, { status: "finishing" });
  assert.deepEqual(requests, [
    { method: "POST", path: "/v1/me/delete", input: { confirmation: "alice@example.com" } },
  ]);

  const done = words(await render(() => createElement(account.AccountDeletedPanel, result.data)));
  assert.match(done, /Your account is deleted/);
  assert.match(done, /You’re signed out\. The remaining cleanup finishes automatically/);
  const complete = words(
    await render(() => createElement(account.AccountDeletedPanel, { status: "deleted" })),
  );
  assert.match(complete, /Your sign-in, your profile and the organizations listed are gone\./);
});

test("the account page has an Email section with a Product updates switch", async (t) => {
  const { account, render, services, createApi } = await setup(t);
  services.queries.setQueryData(["human", user.id, "account-deletion"], {
    data: plan(),
    meta: meta(),
  });
  services.queries.setQueryData(["human", user.id, "email"], {
    data: { productUpdates: true, accountEmails: "always" },
    meta: meta(),
  });
  const html = await render(() => createElement(account.AccountSettings));
  assert.match(html, /<h2 id="email-title">Email<\/h2>/);
  assert.match(html, /<input type="checkbox" role="switch"[^>]*checked=""/);
  assert.match(words(html), /Product updates New features and releases\./);
  assert.match(words(html), /Account emails always arrive/);
  const off = await render(() =>
    createElement(account.EmailChoices, {
      preferences: { productUpdates: false, accountEmails: "always" },
      saving: true,
      change: () => {},
    }),
  );
  assert.doesNotMatch(off, /checked/);
  assert.match(off, /disabled=""/);

  const requests = [];
  const http = createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    requests.push({ method: req.method, path: req.url, input: Buffer.concat(body).toString() });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ data: { productUpdates: false, accountEmails: "always" }, meta: meta() }),
    );
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    http.closeAllConnections();
    http.close();
  });
  const api = createApi(`http://127.0.0.1:${http.address().port}`);
  const result = await account.updateEmailPreferences(api, false);
  assert.equal(result.data.productUpdates, false);
  assert.deepEqual(requests, [
    { method: "PUT", path: "/v1/me/email", input: '{"productUpdates":false}' },
  ]);
});
