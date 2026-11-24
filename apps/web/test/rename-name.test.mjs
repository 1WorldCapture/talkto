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

/** Alice's organization and server, renamed through the website as the dashboard does. */
const seeded = async (t) => {
  const app = await start(t);
  const account = await app.account();
  const server = await app.server(account.id);
  await app.control("member", app.member(account.organizationId, "user_bob"));
  await app.call("user_alice", "PUT", `/v1/servers/${server.id}/access/user_bob`);
  const flow = await app.browserLogin();
  const cookie = (await flow.callback()).headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
  const post = async (path, name) => {
    const response = await app.raw(path, {
      method: "POST",
      headers: { cookie, origin: "https://talkto.test", "content-type": "application/json" },
      body: JSON.stringify({ name, requestKey: randomUUID() }),
    });
    assert.equal(response.status, 200, await response.clone().text());
  };
  const before = {
    context: await app.call("user_alice", "GET", `/v1/accounts/${account.id}`),
    managed: await app.call("user_alice", "GET", `/v1/accounts/${account.id}/servers/${server.id}`),
  };
  await post(`/v1/accounts/${account.id}/rename`, "Acme Robotics");
  await post(`/v1/accounts/${account.id}/servers/${server.id}/rename`, "Launch room");
  return {
    app,
    account,
    server,
    before,
    me: await app.call("user_alice", "GET", "/v1/me"),
    bob: await app.call("user_bob", "GET", "/v1/me"),
    context: await app.call("user_alice", "GET", `/v1/accounts/${account.id}`),
    bobContext: await app.call("user_bob", "GET", `/v1/accounts/${account.id}`),
    managed: await app.call("user_alice", "GET", `/v1/accounts/${account.id}/servers/${server.id}`),
    renames: await app.call(
      "user_alice",
      "GET",
      `/v1/accounts/${account.id}/servers/${server.id}/renames`,
    ),
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
    ...(await vite.ssrLoadModule("/src/rename-name.tsx")),
    ...(await vite.ssrLoadModule("/src/dashboard.tsx")),
    ...(await vite.ssrLoadModule("/src/api.ts")),
  };
};

/** Render the dashboard at `path` for `user` over a cache seeded with `seed`. */
const page = async (t, ui, user, path, seed) => {
  const services = ui.createServices("https://talkto.test");
  t.after(() => services.queries.clear());
  seed((key, value) => services.queries.setQueryData(["human", user.user.id, ...key], value));
  services.queries.setQueryData(["session"], { data: user });
  const root = createRootRoute({ validateSearch: (input) => input });
  const route = createRoute({
    getParentRoute: () => root,
    path: "/app/$",
    component: () => createElement(ui.Dashboard),
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [path] }),
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
          { value: user.user },
          createElement(RouterProvider, { router }),
        ),
      ),
    ),
  );
};

test("the owner's organization Settings offers Rename and shows the new name in the header", async (t) => {
  const fixture = await seeded(t);
  const ui = await modules(t);
  const path = `/app/accounts/${fixture.account.id}/settings`;
  const html = await page(t, ui, fixture.me, path, (set) =>
    set([fixture.account.id, "account"], { data: fixture.context }),
  );
  assert.ok(html.includes(">Settings</a>"), "the organization bar links Settings for the owner");
  assert.ok(html.includes("Organization name"));
  assert.ok(html.includes(">Rename organization…</button>"));
  assert.ok(html.includes('aria-label="Switch organization, current: Acme Robotics"'));
  assert.ok(html.includes(">Acme Robotics</strong>"));
  // A member has no Settings tab and no rename control.
  const member = await page(t, ui, fixture.bob, path, (set) =>
    set([fixture.account.id, "account"], { data: fixture.bobContext }),
  );
  assert.ok(!member.includes(">Settings</a>"));
  assert.ok(!member.includes("Rename organization"));
  assert.ok(member.includes("Page not found."));
});

test("server Settings offers Rename above deletion; Activity notes the rename", async (t) => {
  const fixture = await seeded(t);
  const ui = await modules(t);
  const base = `/app/accounts/${fixture.account.id}/servers/${fixture.server.id}`;
  const seed = (set) => {
    set([fixture.account.id, "account"], { data: fixture.context });
    set([fixture.account.id, fixture.server.id, "management"], { data: fixture.managed });
    set([fixture.account.id, fixture.server.id, "server-renames"], { data: fixture.renames });
  };
  const settings = await page(t, ui, fixture.me, `${base}?tab=settings`, seed);
  assert.ok(settings.includes(">Server name</h2>"));
  assert.ok(settings.includes(">Rename server…</button>"));
  assert.ok(settings.indexOf("Rename server…") < settings.indexOf("Delete server…"));
  assert.ok(settings.includes(">Launch room</strong>"));
  const activity = await page(t, ui, fixture.me, base, seed);
  assert.ok(activity.includes('aria-label="Server renames"'));
  assert.ok(activity.includes("<span>Development</span>"));
  assert.ok(activity.includes("<strong>Launch room</strong>"));
  assert.ok(activity.includes("server renamed by alice"));
});

test("the rename dialog starts on the current name and says what stays the same", async (t) => {
  const fixture = await seeded(t);
  const ui = await modules(t);
  const services = ui.createServices("https://talkto.test");
  t.after(() => services.queries.clear());
  const render = (subject) =>
    renderToStaticMarkup(
      createElement(
        ui.Services.Provider,
        { value: services },
        createElement(
          QueryClientProvider,
          { client: services.queries },
          createElement(
            ui.Human.Provider,
            { value: fixture.me.user },
            createElement(ui.RenameNameDialog, { subject, close: () => {} }),
          ),
        ),
      ),
    );
  const organization = render({ kind: "organization", account: fixture.before.context });
  assert.ok(organization.includes("Rename organization"));
  assert.ok(organization.includes('value="Team"'));
  assert.ok(organization.includes('maxLength="100"'));
  assert.ok(organization.includes("IDs, servers, members and billing stay the same."));
  const server = render({ kind: "server", server: fixture.before.managed });
  assert.ok(server.includes('value="Development"'));
  assert.ok(server.includes("Other servers in the organization may share it."));
  assert.ok(server.includes("messages, agents and access stay the same."));
});
