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
const now = new Date("2026-11-16T12:00:00.000Z");
const claude = {
  id: "6f0c3e1b-9a52-4c1e-8f0d-2b6c7a1e4d90",
  app: "Claude Code",
  clientId: "client_01CLAUDE",
  shared: false,
  place: "San Francisco, US",
  agent: "claude-code",
  firstSignedInAt: "2026-11-02T09:00:00.000Z",
  lastActiveAt: "2026-11-16T11:57:00.000Z",
  signOut: ["this"],
};
const codex = {
  id: "9a1f7c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b",
  app: "Codex",
  clientId: "https://chatgpt.com/codex/client-metadata.json",
  shared: true,
  place: "Lisbon, PT",
  agent: "codex_cli_rs",
  firstSignedInAt: "2025-12-24T09:00:00.000Z",
  lastActiveAt: "2026-11-14T12:00:00.000Z",
  signOut: ["this", "app"],
};
const goose = {
  id: "authorized_connect_app_01GOOSE",
  app: "Goose",
  clientId: "client_01GOOSE",
  shared: false,
  place: null,
  agent: null,
  firstSignedInAt: null,
  lastActiveAt: null,
  signOut: ["this"],
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
  const page = await vite.ssrLoadModule("/src/sign-ins.tsx");
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
  return { page, account, render, services, createApi };
}

test("each signed-in computer shows its app, place, last activity, first sign-in and Sign out", async (t) => {
  const { page, render, services } = await setup(t);
  const list = (signIns) =>
    render(() => createElement(page.SignInList, { signIns, now, choose: () => {} }));
  const html = await list({ items: [claude, codex, goose], provider: "ok" });
  const text = words(html);
  assert.match(
    text,
    /Claude Code San Francisco, US Active in the last 10 minutes · First signed in Nov 2 Sign out/,
  );
  // The program is left out when it is the app; years show for an earlier year.
  assert.match(
    text,
    /Codex Lisbon, PT Active 2 days ago · First signed in Dec 24, 2025 Sign out Sign out every Codex/,
  );
  // It is shown when it adds to the app's name.
  const named = words(
    await list({ items: [{ ...claude, app: "Work laptop agent" }], provider: "ok" }),
  );
  assert.match(named, /Work laptop agent San Francisco, US · claude-code Active/);
  assert.match(
    text,
    /Goose Place not recorded Not active since TalkTo began listing sign-ins Sign out/,
  );
  assert.doesNotMatch(text, /could not reach/);

  const empty = words(await list({ items: [], provider: "ok" }));
  assert.match(empty, /No computers are signed in\./);
  assert.match(empty, /When an agent app connects to TalkTo and you approve its sign-in/);
  const offline = words(await list({ items: [claude], provider: "unavailable" }));
  assert.match(offline, /TalkTo could not reach its sign-in provider just now\./);

  services.queries.setQueryData(["human", user.id, "sign-ins"], {
    data: { items: [claude], provider: "ok" },
    meta: meta(),
  });
  const full = words(await render(() => createElement(page.SignedInComputers)));
  assert.match(full, /Signed-in computers/);
  assert.match(full, /Agent apps that signed in to TalkTo as alice@example\.com ?\./);
  assert.match(full, /Claude Code San Francisco, US/);
});

test("the confirmation says every agent using the sign-in stops, and sends the chosen sign-out", async (t) => {
  const { page, render, createApi } = await setup(t);
  const form = (item, scope, extra = {}) =>
    render(() =>
      createElement(page.SignOutForm, {
        item,
        scope,
        submit: () => {},
        pending: false,
        error: null,
        close: () => {},
        ...extra,
      }),
    );
  const one = words(await form(claude, "this"));
  assert.match(one, /Every agent using this sign-in stops until someone signs in there again\./);
  assert.match(one, /Cancel Sign out/);
  assert.doesNotMatch(one, /Other computers/);
  const copy = words(await form(codex, "this"));
  assert.match(copy, /Other computers signed in to Codex keep working\./);
  const every = words(await form(codex, "app"));
  assert.match(
    every,
    /Every agent using Codex on any computer stops until someone signs in there again\. Cancel Sign out every Codex/,
  );
  const busy = await form(claude, "this", { pending: true });
  assert.match(words(busy), /Signing out…/);
  assert.match(busy, /<button type="submit" class="ops-danger" disabled=""/);

  const requests = [];
  const http = createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    requests.push({ method: req.method, path: req.url, input: Buffer.concat(body).toString() });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { scope: "app", provider: "revoked" }, meta: meta() }));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    http.closeAllConnections();
    http.close();
  });
  const api = createApi(`http://127.0.0.1:${http.address().port}`);
  const result = await page.signOut(api, codex.id, "app");
  assert.deepEqual(result.data, { scope: "app", provider: "revoked" });
  assert.deepEqual(requests, [
    { method: "POST", path: `/v1/me/sign-ins/${codex.id}/sign-out`, input: '{"scope":"app"}' },
  ]);
});

test("the Account page links to Signed-in computers", async (t) => {
  const { account, render } = await setup(t);
  const html = await render(() => createElement(account.AccountSettings));
  assert.match(html, /href="\/app\/account\/sign-ins"[^>]*>Signed-in computers<\/a>/);
  assert.match(words(html), /See where your agent apps are signed in to TalkTo/);
});

test("last activity reads as recent within 10 minutes, then in minutes, hours and days", async (t) => {
  const { page } = await setup(t);
  const ago = (ms) => page.formatActive(new Date(now.getTime() - ms).toISOString(), now);
  assert.equal(ago(4 * 60_000), "Active in the last 10 minutes");
  assert.equal(ago(25 * 60_000), "Active 25 minutes ago");
  assert.equal(ago(3 * 3_600_000), "Active 3 hours ago");
  assert.equal(ago(86_400_000), "Active yesterday");
  assert.equal(ago(9 * 86_400_000), "Active 9 days ago");
});
