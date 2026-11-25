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
  email: "alice@example.com",
  emailVerified: true,
  firstName: "Alice",
  lastName: null,
};
const now = new Date("2026-11-24T12:00:00.000Z");
const accountId = "3f2b8c1d-6e4a-4b7c-9d1e-2a3b4c5d6e7f";
const deploy = {
  id: "6f0c3e1b-9a52-4c1e-8f0d-2b6c7a1e4d90",
  name: "Deploy script",
  prefix: "tk_Ab3dE6gH",
  access: "full",
  accountId: null,
  createdAt: "2026-11-02T09:00:00.000Z",
  lastUsedAt: "2026-11-23T09:00:00.000Z",
  expiresAt: "2027-01-31T09:00:00.000Z",
};
const dashboard = {
  id: "9a1f7c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b",
  name: "Status board",
  prefix: "tk_Zy9xW8vU",
  access: "read",
  accountId,
  createdAt: "2025-12-24T09:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
};
const meta = () => ({
  requestId: randomUUID(),
  serverTime: now.toISOString(),
  instructions: { url: "https://talkto.test/instructions", text: "Instructions" },
});

async function setup(t) {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const page = await vite.ssrLoadModule("/src/api-keys.tsx");
  const account = await vite.ssrLoadModule("/src/account.tsx");
  const routes = await vite.ssrLoadModule("/src/app-routes.ts");
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
  return { page, account, routes, render, services, createApi };
}

test("each key shows its name, prefix, access, organization, last use and expiry, never a secret", async (t) => {
  const { page, render } = await setup(t);
  const organizations = new Map([[accountId, "Acme"]]);
  const html = await render(() =>
    createElement(page.ApiKeyList, {
      keys: [deploy, dashboard],
      organizations,
      now,
      revoke: () => {},
    }),
  );
  const text = words(html);
  assert.match(
    text,
    /Deploy script tk_Ab3dE6gH… · Full access · All your organizations Made Nov 2 · Last used Nov 23 · Expires Jan 31, 2027 Revoke/,
  );
  assert.match(
    text,
    /Status board tk_Zy9xW8vU… · Read only · Acme Made Dec 24, 2025 · Never used · Never expires Revoke/,
  );
  const empty = words(
    await render(() =>
      createElement(page.ApiKeyList, { keys: [], organizations, now, revoke: () => {} }),
    ),
  );
  assert.match(empty, /You have no API keys\. Make one for a script or service/);
});

test("the new key is shown once, plainly, with Copy and Done", async (t) => {
  const { page, render } = await setup(t);
  const secret = `tk_${"A".repeat(43)}`;
  const text = words(await render(() => createElement(page.NewKey, { secret, close: () => {} })));
  assert.match(text, /Copy this key now\. TalkTo shows it only once and keeps no copy/);
  assert.ok(text.includes(secret));
  assert.match(text, /Copy key Done/);
});

test("the form offers access, organization and expiry, and the page explains keys", async (t) => {
  const { page, render, services } = await setup(t);
  const form = words(
    await render(() =>
      createElement(page.MakeKeyForm, {
        accounts: [{ id: accountId, name: "Acme" }],
        submit: () => {},
        pending: false,
        error: null,
        close: () => {},
      }),
    ),
  );
  assert.match(form, /Full access: read and make changes/);
  assert.match(form, /Read only/);
  assert.match(form, /All your organizations Only Acme/);
  assert.match(form, /30 days 90 days 1 year Never/);
  assert.match(form, /Cancel Make key/);

  services.queries.setQueryData(["human", user.id, "api-keys"], {
    data: { items: [deploy], max: 20 },
    meta: meta(),
  });
  const full = words(await render(() => createElement(page.ApiKeys)));
  assert.match(full, /API keys Make a key/);
  assert.match(full, /call the TalkTo API as alice@example\.com/);
  assert.match(full, /Deploy script/);
});

test("revoking says a key may keep working for up to 30 seconds", async (t) => {
  const { page, render } = await setup(t);
  const text = words(
    await render(() => createElement(page.RevokeDialog, { apiKey: deploy, close: () => {} })),
  );
  assert.match(text, /Anything using this key stops working within 30 seconds/);
  assert.match(text, /Cancel Revoke key/);
});

test("the Account page links to API keys, and the route opens it", async (t) => {
  const { account, routes, render } = await setup(t);
  const html = await render(() => createElement(account.AccountSettings));
  assert.match(html, /href="\/app\/account\/api-keys"[^>]*>API keys<\/a>/);
  assert.deepEqual(routes.dashboardRoute("/app/account/api-keys"), { kind: "api-keys" });
});

test("making and revoking a key call the key routes", async (t) => {
  const { page, createApi } = await setup(t);
  const requests = [];
  const http = createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    requests.push({ method: req.method, path: req.url, input: Buffer.concat(body).toString() });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        req.method === "POST"
          ? { data: { key: deploy, secret: `tk_${"B".repeat(43)}` }, meta: meta() }
          : { data: { id: deploy.id, revokedAt: now.toISOString() }, meta: meta() },
      ),
    );
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    http.closeAllConnections();
    http.close();
  });
  const api = createApi(`http://127.0.0.1:${http.address().port}`);
  await page.createKey(api, { name: "Deploy script", access: "full", expiresInDays: 90 });
  await page.revokeKey(api, deploy.id);
  assert.deepEqual(requests, [
    {
      method: "POST",
      path: "/v1/me/api-keys",
      input: '{"name":"Deploy script","access":"full","expiresInDays":90}',
    },
    { method: "DELETE", path: `/v1/me/api-keys/${deploy.id}`, input: "" },
  ]);
});
