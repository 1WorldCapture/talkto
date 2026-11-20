import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createServer as createVite } from "vite";
import { start } from "../../server/test/platform-harness.mjs";

/** One server with two agents; the person removes one through the website, as the dashboard does. */
const seeded = async (t) => {
  const app = await start(t);
  const account = await app.account();
  const credential = await app.mcpToken(account.organizationId);
  const server = await app.server(account.id);
  const register = async (name) =>
    (
      await app.mcp(credential, "register_participant", {
        serverId: server.id,
        name,
        agentType: "claude-code",
        requestKey: randomUUID(),
      })
    ).data.item;
  const builder = await register("builder-macbook");
  const reviewer = await register("reviewer-mini");
  const read = async (url) =>
    (await app.raw(url, { headers: { authorization: `Bearer ${await app.token()}` } })).json();
  const active = await read(`/v1/servers/${server.id}/participants?limit=24`);
  const flow = await app.browserLogin();
  const cookie = (await flow.callback()).headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
  const removed = await app.raw(`/v1/servers/${server.id}/participants/${reviewer.id}/remove`, {
    method: "POST",
    headers: { cookie, origin: "https://talkto.test" },
  });
  assert.equal(removed.status, 200, await removed.clone().text());
  return {
    app,
    account,
    server,
    builder,
    reviewer,
    active,
    remaining: await read(`/v1/servers/${server.id}/participants?limit=24`),
    removed: await read(`/v1/servers/${server.id}/participants?state=removed&limit=24`),
    removals: await read(`/v1/servers/${server.id}/removals?limit=10`),
    me: await app.call("user_alice", "GET", "/v1/me"),
    context: await app.call("user_alice", "GET", `/v1/accounts/${account.id}`),
    managed: await app.call("user_alice", "GET", `/v1/accounts/${account.id}/servers/${server.id}`),
  };
};

const modules = async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  return {
    ...(await vite.ssrLoadModule("/src/session.tsx")),
    ...(await vite.ssrLoadModule("/src/agent-removals.tsx")),
    ...(await vite.ssrLoadModule("/src/dashboard.tsx")),
    ...(await vite.ssrLoadModule("/src/api.ts")),
  };
};

/** Render the dashboard at `search` over a cache seeded with `seed(set, scope)`. */
const page = async (t, ui, fixture, search, seed) => {
  const services = ui.createServices("https://talkto.test");
  t.after(() => services.queries.clear());
  const user = fixture.me.user;
  const scope = ["human", user.id, fixture.account.id];
  services.queries.setQueryData(["session"], { data: fixture.me });
  services.queries.setQueryData([...scope, "account"], { data: fixture.context });
  services.queries.setQueryData([...scope, fixture.server.id, "management"], {
    data: fixture.managed,
  });
  seed((key, value) => services.queries.setQueryData(key, value), [...scope, fixture.server.id]);
  const root = createRootRoute({ validateSearch: (input) => input });
  const route = createRoute({
    getParentRoute: () => root,
    path: "/app/$",
    component: () => createElement(ui.Dashboard),
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({
      initialEntries: [`/app/accounts/${fixture.account.id}/servers/${fixture.server.id}${search}`],
    }),
  });
  await router.load();
  return renderToStaticMarkup(
    createElement(
      ui.Services.Provider,
      { value: services },
      createElement(
        QueryClientProvider,
        { client: services.queries },
        createElement(
          ui.Human.Provider,
          { value: user },
          createElement(RouterProvider, { router }),
        ),
      ),
    ),
  );
};

test("each active agent card offers Remove; removed agents are hidden until the Removed filter", async (t) => {
  const fixture = await seeded(t);
  const ui = await modules(t);
  const before = await page(t, ui, fixture, "?tab=agents", (set, scope) =>
    set([...scope, "agents", "", undefined], fixture.active),
  );
  assert.ok(before.includes('aria-label="Remove builder-macbook from this server"'));
  assert.ok(before.includes('aria-label="Remove reviewer-mini from this server"'));
  assert.ok(before.includes('aria-label="Agent status"'), "a status filter like channels'");

  const after = await page(t, ui, fixture, "?tab=agents", (set, scope) =>
    set([...scope, "agents", "", undefined], fixture.remaining),
  );
  assert.ok(after.includes("builder-macbook"));
  assert.ok(!after.includes("reviewer-mini"), "removed agents are hidden by default");

  const removed = await page(t, ui, fixture, "?tab=agents&state=removed", (set, scope) =>
    set([...scope, "agents", "", undefined, "removed"], fixture.removed),
  );
  assert.ok(removed.includes("reviewer-mini"));
  assert.ok(removed.includes(">Removed</span>"), "the card says it was removed");
  assert.ok(removed.includes('aria-label="Restore reviewer-mini"'));
  assert.ok(removed.includes('aria-label="Rename reviewer-mini"'), "renaming frees its name");
  assert.ok(!removed.includes('aria-label="Remove reviewer-mini from this server"'));
  assert.ok(!removed.includes('aria-label="Auto-start for reviewer-mini"'));
  assert.ok(!removed.includes('aria-label="Message reviewer-mini"'));
});

test("the confirmation names the agent and says what stops, what stays, and what it does not do", async (t) => {
  const fixture = await seeded(t);
  const ui = await modules(t);
  const services = ui.createServices("https://talkto.test");
  t.after(() => services.queries.clear());
  const html = renderToStaticMarkup(
    createElement(
      ui.Services.Provider,
      { value: services },
      createElement(
        QueryClientProvider,
        { client: services.queries },
        createElement(
          ui.Human.Provider,
          { value: fixture.me.user },
          createElement(ui.RemoveAgentDialog, {
            accountId: fixture.account.id,
            serverId: fixture.server.id,
            agent: fixture.builder,
            close: () => {},
          }),
        ),
      ),
    ),
  );
  assert.ok(html.includes("Remove builder-macbook from this server?"));
  assert.ok(
    html.includes(
      "builder-macbook can no longer send, receive messages or be woken on this server. Its messages stay in history, marked removed.",
    ),
  );
  assert.ok(
    html.includes("could join again under a new name; to cut a computer off, sign it out."),
  );
  assert.ok(html.includes(">Remove from server</button>"));
  assert.ok(html.includes(">Cancel</button>"));
});

test("the Activity view notes who removed which agent", async (t) => {
  const fixture = await seeded(t);
  const ui = await modules(t);
  const services = ui.createServices("https://talkto.test");
  t.after(() => services.queries.clear());
  const user = fixture.me.user;
  services.queries.setQueryData(
    ["human", user.id, fixture.account.id, fixture.server.id, "removals"],
    fixture.removals,
  );
  const html = renderToStaticMarkup(
    createElement(
      ui.Services.Provider,
      { value: services },
      createElement(
        QueryClientProvider,
        { client: services.queries },
        createElement(
          ui.Human.Provider,
          { value: user },
          createElement(ui.RemovalNotices, {
            accountId: fixture.account.id,
            serverId: fixture.server.id,
          }),
        ),
      ),
    ),
  );
  const [event] = fixture.removals.data.items;
  assert.match(html, new RegExp(`${event.by.name} removed <strong>reviewer-mini</strong>`));
});
