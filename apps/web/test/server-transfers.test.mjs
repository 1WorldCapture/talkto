import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
import { decode } from "./copy-rules.mjs";

const sha = "c".repeat(64);
const emptyCopy =
  "No files yet. When agents send files with prepare_transfer, they appear here for 30 days.";

/**
 * A hosted server (transfers, no Git) where one agent sent a file in General, a folder in a
 * direct chat, and prepared a third file it never sent.
 */
const seeded = async (t) => {
  const app = await start(t, { transfers: true });
  const account = await app.account();
  const credential = await app.mcpToken(account.organizationId);
  const server = await app.server(account.id);
  const register = async (name, agentType) =>
    (
      await app.mcp(credential, "register_participant", {
        serverId: server.id,
        name,
        agentType,
        requestKey: randomUUID(),
      })
    ).data;
  const sender = await register("design-engineer", "claude-code");
  const receiver = (await register("reviewer", "codex")).item.id;
  const general = sender.generalConversationId;
  const call = (name, args) => app.mcp(credential, name, { serverId: server.id, ...args });
  const prepare = async (args) =>
    (
      await call("prepare_transfer", {
        participantId: sender.item.id,
        requestKey: randomUUID(),
        kind: "file",
        sha256: sha,
        ...args,
      })
    ).data.transferId;
  const put = (transferId, part, bytes) =>
    app.control(
      `transfer-object?key=${encodeURIComponent(`r30/${server.id}/${transferId}/${part}`)}&bytes=${bytes}`,
    );
  const send = async (args, target) => {
    const transferId = await prepare(args);
    await put(transferId, "payload", args.bytes);
    if (args.kind === "folder") await put(transferId, "manifest", args.manifestBytes);
    return (
      await call("complete_transfer", {
        participantId: sender.item.id,
        requestKey: randomUUID(),
        target,
        transferId,
        body: "For review.",
      })
    ).data.item;
  };
  const file = await send(
    { name: "billing-spec.md", bytes: 18_432 },
    { kind: "conversation", conversationId: general },
  );
  const folder = await send(
    { name: "landing-site", kind: "folder", bytes: 2_400_000, fileCount: 14, manifestBytes: 300 },
    { kind: "direct", recipientId: receiver },
  );
  const draft = await prepare({ name: "notes.txt", bytes: 10 });
  const read = async (url) =>
    (await app.raw(url, { headers: { authorization: `Bearer ${await app.token()}` } })).json();
  return {
    app,
    account,
    server,
    general,
    file,
    folder,
    draft,
    transfers: await read(`/v1/servers/${server.id}/files/transfers?limit=25`),
    me: await app.call("user_alice", "GET", "/v1/me"),
    context: await app.call("user_alice", "GET", `/v1/accounts/${account.id}`),
    managed: await app.call("user_alice", "GET", `/v1/accounts/${account.id}/servers/${server.id}`),
  };
};

/** Server-rendered dashboard over a seeded cache: the transfers page, its error, or neither. */
const dashboard = async (t, fixture, search, transfers, failure) => {
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
  const key = [...scope, fixture.server.id, "transfers", ""];
  if (transfers) services.queries.setQueryData(key, transfers);
  if (failure) {
    // The error class must come from this render's own module graph. A first render would
    // otherwise retry at once and show loading, so this cached failure is shown as it is.
    const { ApiError } = await vite.ssrLoadModule("/src/api.ts");
    services.queries.setQueryDefaults(key, { retryOnMount: false });
    services.queries
      .getQueryCache()
      .build(services.queries, { queryKey: key })
      .setState({
        data: undefined,
        dataUpdatedAt: 0,
        error: new ApiError(failure.code, failure.message),
        status: "error",
        fetchStatus: "idle",
      });
  }
  const root = createRootRoute({ validateSearch: (input) => input });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/app/$",
    component: () => createElement(Dashboard),
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({
      initialEntries: [`/app/accounts/${fixture.account.id}/servers/${fixture.server.id}${search}`],
    }),
  });
  await router.load();
  return {
    html: renderToStaticMarkup(
      createElement(
        Services.Provider,
        { value: services },
        createElement(
          QueryClientProvider,
          { client: services.queries },
          createElement(Human.Provider, { value: user }, createElement(RouterProvider, { router })),
        ),
      ),
    ),
  };
};

/** The rendered row for one transfer, by its name. */
const row = (html, name) => {
  const found = [...html.matchAll(/<tr data-state="[^"]*">[\s\S]*?<\/tr>/g)]
    .map(([markup]) => markup)
    .find((markup) => markup.includes(`>${name}<`));
  assert.ok(found, `a row for ${name}`);
  return found;
};

test("Files sits after Direct chats and lists every transfer with where it was sent", async (t) => {
  const fixture = await seeded(t);
  assert.equal(fixture.managed.files, null, "hosted TalkTo has no Git sharing");
  assert.equal(fixture.transfers.data.items.length, 3);
  const { html } = await dashboard(t, fixture, "?tab=files", fixture.transfers);
  const tabs = [
    // The server's own navigation; the organization bar has its own Settings link.
    ...html
      .slice(html.indexOf('aria-label="Server navigation"'))
      .matchAll(/<a\b[^>]*>(Activity|Channels|Direct chats|Agents|Files|Settings)</g),
  ].map(([, label]) => label);
  assert.deepEqual(tabs, ["Activity", "Channels", "Direct chats", "Agents", "Files", "Settings"]);
  assert.match(html, /<a[^>]*aria-current="page"[^>]*>Files<\/a>/, "the Files item is current");
  assert.ok(html.includes('<h2 class="ops-page-title">Files</h2>'));
  const headers = [...html.matchAll(/<th scope="col">([^<]*)</g)].map(([, label]) => label);
  assert.deepEqual(headers, ["Name", "Size", "Sender", "Where", "Sent", "Expires", ""]);

  const file = row(html, "billing-spec.md");
  assert.ok(file.includes("18 KB"));
  assert.ok(file.includes("design-engineer"));
  assert.ok(file.includes("# General"));
  assert.ok(
    decode(file).includes(
      `tab=channels&channel=${fixture.general}&message=${fixture.file.sequence}`,
    ),
    "Where opens General at the offer",
  );
  assert.ok(file.includes(">in 30 days<"));
  assert.ok(file.includes('aria-label="Download billing-spec.md"'));
  assert.ok(file.includes(">Download</button>"));

  const folder = row(html, "landing-site");
  assert.ok(folder.includes('data-kind="folder"'), "a folder shows the folder mark");
  assert.ok(folder.includes("2.3 MB · 14 files"));
  assert.ok(decode(folder).includes("design-engineer ↔ reviewer"), "a direct chat by its members");
  assert.ok(decode(folder).includes(`tab=directs&channel=${fixture.folder.conversationId}`));
  assert.ok(folder.includes(">Download</button>"));

  const draft = row(html, "notes.txt");
  assert.ok(draft.includes('data-state="incomplete"'));
  assert.ok(draft.includes("Upload not finished"));
  assert.ok(!draft.includes("<button"), "nothing to download from an unsent transfer");
  assert.ok(!html.includes(emptyCopy));
});

test("an expired file says so and offers no download", async (t) => {
  const fixture = await seeded(t);
  await fixture.app.control(`transfers-expired?server=${fixture.server.id}`);
  const response = await fixture.app.raw(`/v1/servers/${fixture.server.id}/files/transfers`, {
    headers: { authorization: `Bearer ${await fixture.app.token()}` },
  });
  const { html } = await dashboard(t, fixture, "?tab=files", await response.json());
  const file = row(html, "billing-spec.md");
  assert.ok(file.includes('data-state="expired"'));
  assert.ok(file.includes(">Expired<"));
  assert.ok(!file.includes("<button"));
});

test("the Files page has plain empty, loading and error states", async (t) => {
  const fixture = await seeded(t);
  const empty = { ...fixture.transfers, data: { items: [], nextCursor: null } };
  const { html } = await dashboard(t, fixture, "?tab=files", empty);
  assert.ok(html.includes(emptyCopy));
  assert.ok(!html.includes("<table"));
  assert.ok(!/!/.test(decode(html.match(/<section aria-label="Files"[\s\S]*<\/section>/)[0])));

  const loading = (await dashboard(t, fixture, "?tab=files")).html;
  assert.ok(loading.includes('role="status">Loading files…</p>'));

  const failure = {
    code: "storage_unavailable",
    message: "The server is temporarily unavailable.",
  };
  const failed = (await dashboard(t, fixture, "?tab=files", undefined, failure)).html;
  assert.ok(failed.includes('role="alert"'));
  assert.ok(failed.includes("The server is temporarily unavailable."));
  assert.ok(failed.includes(">Try again</button>"));
  assert.ok(failed.includes(">Files</a>"), "a failed listing keeps the tab");
});

test("on narrow screens each file stacks into a block with Download beside it", async () => {
  const css = await readFile(new URL("../src/server-transfers.css", import.meta.url), "utf8");
  const start = css.indexOf("@media (max-width: 1099px) {");
  assert.ok(start >= 0);
  const block = css.slice(start);
  assert.match(block, /\.ops-files-table tr \{[^}]*display: grid;/);
  assert.match(block, /\.ops-files-action \{[^}]*grid-area: action;/);
  assert.match(block, /\.ops-files-action \.ops-new \{[^}]*min-height: 44px;/, "44px target");
});
