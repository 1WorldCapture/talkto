import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useSearch,
} from "@tanstack/react-router";
import { createServer as createVite } from "vite";

test("dashboard navigation marks only the selected view current across shared paths and filters", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { AppLink } = await vite.ssrLoadModule("/src/components.tsx");
  const { conversationTab } = await vite.ssrLoadModule("/src/conversations.tsx");
  const path = "accounts/example/servers/server";
  const tabs = ["activity", "channels", "directs", "agents"];
  function Navigation() {
    const search = useSearch({ strict: false });
    const selectedTab = search.channel
      ? conversationTab(search.channel === "direct" ? "direct" : "channel", search.tab)
      : (search.tab ?? "activity");
    return createElement(
      "nav",
      null,
      ...tabs.map((tab) =>
        createElement(
          AppLink,
          { key: tab, path, search: { tab }, current: tab === selectedTab },
          tab,
        ),
      ),
      createElement(AppLink, { path: "accounts/example/servers", current: true }, "Servers"),
      createElement(AppLink, { path, search: { channel: "general" } }, "General"),
    );
  }
  const root = createRootRoute({ validateSearch: (search) => search });
  const route = createRoute({ getParentRoute: () => root, path: "/app/$", component: Navigation });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/app/${path}`] }),
  });
  await router.load();
  for (const [query, expected] of [
    ["", "activity"],
    ...tabs.map((tab) => [`tab=${tab}`, tab]),
    ["channel=general", "channels"],
    ["tab=channels&channel=general&query=review&cursor=older", "channels"],
    ["tab=activity&channel=general", "channels"],
    ["tab=directs&channel=general", "channels"],
    ["channel=direct", "directs"],
    ["tab=channels&channel=direct", "directs"],
    ["tab=directs&channel=direct&query=review&cursor=older", "directs"],
    ["tab=agents&query=overseer&cursor=older", "agents"],
    ["tab=activity&range=week&query=review", "activity"],
  ]) {
    router.history.push(`/app/${path}${query ? `?${query}` : ""}`);
    await router.load();
    const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
    const links = [...html.matchAll(/<a\b([^>]*)>([^<]+)<\/a>/g)];
    assert.equal(links.length, 6);
    const current = links.filter(([, attrs]) => attrs.includes('aria-current="page"'));
    assert.deepEqual(
      current.map(([, , label]) => label),
      [expected, "Servers"],
      query || "default Activity view",
    );
    assert.equal(links.filter(([, attrs]) => attrs.includes('data-status="active"')).length, 2);
    assert.ok(
      !html.includes('class="active"'),
      "router path matching cannot add a competing active class",
    );
  }
});

test("join and shared paths open their own views; malformed ones never open an organization", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { dashboardRoute, sharedServerPath, accountServerPath } =
    await vite.ssrLoadModule("/src/app-routes.ts");
  const invitation = "sinv_abcdefghijklmnopqrstuvwxyz";
  const uuid = "3f6c1f4e-8a43-4b8e-9f52-1c2d3e4f5a6b";
  assert.deepEqual(dashboardRoute(`/app/join/${invitation}`), {
    kind: "join",
    invitationId: invitation,
  });
  // A truncated or altered link still opens the join page, which explains it.
  for (const path of ["/app/join", "/app/join/sinv_short", `/app/join/${invitation}/extra`])
    assert.deepEqual(dashboardRoute(path), { kind: "join", invitationId: null }, path);
  assert.deepEqual(dashboardRoute(`/app/shared/${uuid}`), {
    kind: "shared",
    serverId: uuid,
    task: undefined,
  });
  for (const path of ["/app/shared", "/app/shared/not-a-server", `/app/shared/${uuid}/x`])
    assert.deepEqual(
      dashboardRoute(path),
      { kind: "shared", serverId: null, task: undefined },
      path,
    );
  // A Board task page keeps its server and names the task.
  assert.deepEqual(dashboardRoute(`/app/shared/${uuid}/board/T-14`), {
    kind: "shared",
    serverId: uuid,
    task: "T-14",
  });
  assert.deepEqual(dashboardRoute(`/app/accounts/${uuid}/servers/${uuid}/board/T-14`), {
    kind: "account",
    accountId: uuid,
    view: "servers",
    serverId: uuid,
    task: "T-14",
  });
  // A server ID in the shared path is never read as an organization.
  assert.equal(dashboardRoute(`/app/shared/${uuid}`).kind, "shared");
  assert.deepEqual(dashboardRoute(`/app/accounts/${uuid}/servers/${uuid}`), {
    kind: "account",
    accountId: uuid,
    view: "servers",
    serverId: uuid,
    task: undefined,
  });
  assert.deepEqual(dashboardRoute("/app"), { kind: "entry" });
  assert.deepEqual(dashboardRoute("/app/organizations"), { kind: "organizations" });
  assert.deepEqual(dashboardRoute("/app/account"), { kind: "account-settings" });
  assert.deepEqual(dashboardRoute("/app/account/sign-ins"), { kind: "sign-ins" });
  assert.equal(sharedServerPath(uuid), `shared/${uuid}`);
  assert.equal(accountServerPath(uuid, uuid), `accounts/${uuid}/servers/${uuid}`);
});

test("/app never sends an invited person with no organization to onboarding", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { entryTarget } = await vite.ssrLoadModule("/src/app-routes.ts");
  const newcomer = { completedAt: null, dismissedAt: null, run: null };
  const done = { completedAt: "2026-11-18T09:00:00.000Z", dismissedAt: null, run: null };
  const running = { completedAt: null, dismissedAt: null, run: { step: "agents" } };
  const nothing = { servers: [], invitations: [] };
  const server = { id: "3f6c1f4e-8a43-4b8e-9f52-1c2d3e4f5a6b" };
  const invitation = { id: "sinv_abcdefghijklmnopqrstuvwxyz" };
  const org = { id: "9a6c1f4e-8a43-4b8e-9f52-1c2d3e4f5a6b" };
  const entry = (overrides) =>
    entryTarget({
      accounts: [],
      more: false,
      setup: newcomer,
      shared: nothing,
      billing: false,
      ...overrides,
    });
  // Without anything shared, a first visit still starts onboarding.
  assert.deepEqual(entry({}), { kind: "onboarding" });
  // One shared server and nothing else opens it; anything more shows the list.
  assert.deepEqual(entry({ shared: { servers: [server], invitations: [] } }), {
    kind: "shared",
    serverId: server.id,
  });
  assert.deepEqual(entry({ shared: { servers: [], invitations: [invitation] } }), {
    kind: "directory",
  });
  assert.deepEqual(entry({ shared: { servers: [server], invitations: [invitation] } }), {
    kind: "directory",
  });
  assert.deepEqual(entry({ shared: { servers: [server, server], invitations: [] } }), {
    kind: "directory",
  });
  // Setup in progress does not win over a shared server either.
  assert.deepEqual(entry({ setup: running, shared: { servers: [], invitations: [invitation] } }), {
    kind: "directory",
  });
  // When the shared read failed, someone with no organization sees the list and its notice.
  assert.deepEqual(entry({ shared: null }), { kind: "directory" });
  // Members keep today's rules; something shared keeps them on the list, where it shows.
  assert.deepEqual(entry({ accounts: [org], setup: done }), { kind: "account", accountId: org.id });
  assert.deepEqual(entry({ accounts: [org], setup: done, shared: null }), {
    kind: "account",
    accountId: org.id,
  });
  assert.deepEqual(
    entry({ accounts: [org], setup: done, shared: { servers: [server], invitations: [] } }),
    { kind: "directory" },
  );
  assert.deepEqual(entry({ accounts: [org], setup: running }), { kind: "onboarding" });
  assert.deepEqual(entry({ accounts: [org], setup: running, billing: true }), {
    kind: "account",
    accountId: org.id,
  });
  assert.deepEqual(entry({ accounts: [org, org], setup: done }), { kind: "directory" });
  assert.deepEqual(entry({ more: true, setup: newcomer }), { kind: "directory" });
});
