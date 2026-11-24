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

const commit = "9f3c2ab4d1e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0";
const path = "specs/billing-rewrite/api.md";
const note = "Draft API for the billing rewrite. Review before Thursday.";

/** One server with a registered agent that has announced one share in General. */
const shared = async (t) => {
  const app = await start(t, { files: true });
  const account = await app.account();
  const credential = await app.mcpToken(account.organizationId);
  const server = await app.server(account.id);
  const registered = await app.mcp(credential, "register_participant", {
    serverId: server.id,
    name: "design-engineer-cloud-agents",
    agentType: "claude-code",
    requestKey: randomUUID(),
  });
  const participantId = registered.data.item.id;
  const general = registered.data.generalConversationId;
  await app.mcp(credential, "share_file", {
    serverId: server.id,
    participantId,
    target: { kind: "conversation", conversationId: general },
    requestKey: randomUUID(),
    body: note,
    path,
    commit,
    ref: "main",
    bytes: 18432,
  });
  const read = async (url) =>
    (await app.raw(url, { headers: { authorization: `Bearer ${await app.token()}` } })).json();
  return {
    app,
    account,
    server,
    general,
    shares: await read(`/v1/servers/${server.id}/files/shares`),
    messages: await read(`/v1/servers/${server.id}/messages?conversationId=${general}&limit=25`),
    me: await app.call("user_alice", "GET", "/v1/me"),
    context: await app.call("user_alice", "GET", `/v1/accounts/${account.id}`),
    managed: await app.call("user_alice", "GET", `/v1/accounts/${account.id}/servers/${server.id}`),
  };
};

/** Server-rendered dashboard over a seeded cache; every query this view needs is supplied. */
const dashboard = async (t, fixture, search, shares, failure) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { Dashboard } = await vite.ssrLoadModule("/src/dashboard.tsx");
  const { createServices, Services, Human } = await vite.ssrLoadModule("/src/session.tsx");
  const services = createServices("https://talkto.test");
  t.after(() => services.queries.clear());
  const user = fixture.me.user;
  const scope = ["human", user.id, fixture.account.id];
  services.queries.setQueryData(["session"], { data: fixture.me });
  services.queries.setQueryData([...scope, "account"], { data: fixture.context });
  services.queries.setQueryData([...scope, fixture.server.id, "management"], {
    data: fixture.managed,
  });
  const sharesKey = [...scope, fixture.server.id, "file-shares", ""];
  if (shares) services.queries.setQueryData(sharesKey, shares);
  if (failure)
    services.queries.getQueryCache().build(services.queries, { queryKey: sharesKey }).setState({
      data: undefined,
      dataUpdatedAt: 0,
      error: failure,
      status: "error",
      fetchStatus: "idle",
    });
  const route = `/app/accounts/${fixture.account.id}/servers/${fixture.server.id}${search}`;
  const root = createRootRoute({ validateSearch: (input) => input });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/app/$",
    component: () => createElement(Dashboard),
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [route] }),
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

test("the Files tab lists shares with their sharer, conversation and reference", async (t) => {
  const fixture = await shared(t);
  assert.equal(fixture.shares.data.items.length, 1);
  const html = await dashboard(t, fixture, "?tab=files", fixture.shares);
  const tabs = [
    // The server's own navigation; the organization bar has its own Settings link.
    ...html
      .slice(html.indexOf('aria-label="Server navigation"'))
      .matchAll(/<a\b[^>]*>(Activity|Channels|Direct chats|Agents|Files|Settings)</g),
  ].map(([, label]) => label);
  assert.deepEqual(tabs, ["Activity", "Channels", "Direct chats", "Agents", "Files", "Settings"]);
  assert.ok(html.includes("Remote"));
  const remote = fixture.managed.files.repository.remote;
  assert.match(remote, /^https:\/\/fake\.artifacts\.test\/git\/test\/srv-.*\.git$/);
  assert.ok(html.includes(`<code>${remote}</code>`), "the remote line shows the URL in code");
  assert.ok(html.includes(">Copy</button>"), "the remote line has a copy control");
  assert.ok(html.includes("get_files_access"), "the remote line explains how agents get access");
  assert.ok(html.includes("<b>1</b> share"), "counts the loaded shares");
  assert.ok(html.includes("<b>1</b> file"), "counts the distinct paths");
  assert.ok(html.includes(path));
  assert.ok(html.includes(note), "the agent's own note is the row description");
  assert.ok(html.includes("main · 9f3c2ab · 18 KB"), "ref, short commit and agent-reported size");
  assert.ok(!html.includes(commit), "the full commit never replaces the short one");
  assert.ok(html.includes("design-engineer-cloud-agents"));
  assert.ok(html.includes("# General"), "the row names the conversation the share came from");
  assert.ok(
    html.includes(`channel=${fixture.general}`),
    "the path opens the message's conversation",
  );
  assert.ok(!html.includes("No files shared yet"));
});

test("the Files tab is always there; its Git view follows the server's files capability", async (t) => {
  const fixture = await shared(t);
  const empty = { ...fixture.shares, data: { items: [], nextCursor: null } };
  const bare = await dashboard(t, fixture, "", empty);
  assert.ok(bare.includes(">Agents</a>"));
  assert.ok(bare.includes(">Files</a>"), "the tab is present with zero shares");
  const pending = await dashboard(t, fixture, "", undefined);
  assert.ok(pending.includes(">Files</a>"), "the tab does not wait for the shares request");
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { ApiError } = await vite.ssrLoadModule("/src/api.ts");
  const unavailable = new ApiError("files_unavailable", "File sharing is unavailable.");
  const failed = await dashboard(t, fixture, "", undefined, unavailable);
  assert.ok(failed.includes(">Files</a>"), "a failed shares request does not hide the tab");
  const opened = await dashboard(t, fixture, "?tab=files", empty);
  assert.ok(opened.includes(">Files</a>"), "an opened Files view keeps its tab");
  assert.ok(opened.includes("No files shared yet. Agents share with share_file."));
  const absent = { ...fixture, managed: { ...fixture.managed, files: null } };
  const hosted = await dashboard(t, absent, "", fixture.shares);
  assert.ok(hosted.includes(">Agents</a>"));
  assert.ok(hosted.includes(">Files</a>"), "transfers need no Git capability");
  const transfers = await dashboard(t, absent, "?tab=files", fixture.shares);
  assert.ok(transfers.includes(">Files</a>"));
  assert.ok(transfers.includes("Loading files…"), "?tab=files opens the transfers view");
  assert.ok(!transfers.includes("get_files_access"), "no Git remote without the capability");
  const unanswered = { ...fixture, managed: { ...fixture.managed, files: { repository: null } } };
  const hint = await dashboard(t, unanswered, "?tab=files", fixture.shares);
  assert.ok(hint.includes(">Files</a>"));
  assert.ok(hint.includes("get_files_access"), "the hint stands alone until the store answers");
  assert.ok(!hint.includes("<code>"), "no remote, no URL");
  assert.ok(!hint.includes(">Copy</button>"), "no remote, no copy control");
});

test("a deployment without Git answers the shares route and still shows the Files tab", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const server = await app.server(account.id);
  const response = await app.raw(`/v1/servers/${server.id}/files/shares`, {
    headers: { authorization: `Bearer ${await app.token()}` },
  });
  const page = await response.json();
  assert.equal(response.status, 200, "the route is not gated by the files capability");
  assert.deepEqual(page.data.items, []);
  const fixture = {
    account,
    server,
    me: await app.call("user_alice", "GET", "/v1/me"),
    context: await app.call("user_alice", "GET", `/v1/accounts/${account.id}`),
    managed: await app.call("user_alice", "GET", `/v1/accounts/${account.id}/servers/${server.id}`),
  };
  assert.equal(fixture.managed.files, null);
  const html = await dashboard(t, fixture, "", page);
  assert.ok(html.includes(">Agents</a>"));
  assert.ok(html.includes(">Files</a>"), "the Files tab lists transfers, not Git shares");
});

test("a share renders its chip under the message body wherever the dialogue renders", async (t) => {
  const fixture = await shared(t);
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { MessageDialogue } = await vite.ssrLoadModule("/src/message-dialogue.tsx");
  const page = fixture.messages;
  const render = async (files) => {
    const root = createRootRoute({
      validateSearch: (input) => input,
      component: () =>
        createElement(MessageDialogue, {
          rows: page.data.items.map((message) => ({ message, included: page.included })),
          position: "latest",
          empty: "No messages yet.",
          files,
        }),
    });
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({
        initialEntries: [`/app/accounts/${fixture.account.id}/servers/${fixture.server.id}`],
      }),
    });
    await router.load();
    return renderToStaticMarkup(createElement(RouterProvider, { router }));
  };
  const html = await render(true);
  assert.ok(html.includes(note), "the body still reads as the agent wrote it");
  assert.ok(html.includes(`<span class="ops-share-path">${path}</span>`));
  assert.ok(html.includes("main · 9f3c2ab · 18 KB"));
  assert.ok(html.includes(">open in Files</a>"));
  assert.ok(
    html.includes(`servers/${fixture.server.id}?tab=files"`),
    "the chip opens this server's Files view",
  );
  assert.ok(html.indexOf("ops-dialogue-body") < html.indexOf("ops-share-path"));
  // Hosted TalkTo retired Git sharing: an old share reads plainly, with no link to a gone Files view.
  for (const retired of [await render(false), await render(undefined)]) {
    assert.ok(retired.includes(note), "the old share message still reads");
    assert.ok(retired.includes(`<span class="ops-share-path">${path}</span>`));
    assert.ok(retired.includes("main · 9f3c2ab · 18 KB"));
    assert.ok(retired.includes("Git sharing has ended; this file can no longer be fetched"));
    assert.ok(!retired.includes("open in Files"));
    assert.ok(!retired.includes("tab=files"), "no link to a Files view the server no longer has");
  }
});
