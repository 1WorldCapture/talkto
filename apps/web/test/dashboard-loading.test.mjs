import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createServer as createVite } from "vite";
import { start } from "../../server/test/platform-harness.mjs";

test("Home prefetch reuses each selected page size and preserves its continuation", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const server = await app.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const agent = (
    await app.call("user_alice", "POST", `${root}/participants`, {
      name: "loading-check",
      agentType: "codex",
      requestKey: randomUUID(),
    })
  ).item;
  const channel = (await app.call("user_alice", "GET", root)).generalConversationId;
  await app.control("activity-seed", {
    serverId: server.id,
    messages: Array.from({ length: 60 }, (_, i) => ({
      participantId: agent.id,
      conversationId: channel,
      at: new Date(Date.now() - (60 - i) * 1000).toISOString(),
      body: `Message ${i}`,
    })),
  });
  await app.control(`project?server=${server.id}`);
  await app.control(`project?server=${server.id}`);
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { createServices } = await vite.ssrLoadModule("/src/session.tsx");
  const { request } = await vite.ssrLoadModule("/src/api.ts");
  const { homeQuery } = await vite.ssrLoadModule("/src/dashboard-queries.ts");
  const received = [];
  const gateway = createServer(async (req, res) => {
    received.push(req.url);
    const response = await app.raw(req.url, {
      headers: { authorization: `Bearer ${await app.token()}` },
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    gateway.closeAllConnections();
    gateway.close();
  });
  const { api, queries } = createServices(`http://127.0.0.1:${gateway.address().port}`);
  t.after(() => queries.clear());
  for (const limit of [10, 25, 50]) {
    const options = homeQuery(api, "user_alice", account.id, limit);
    await queries.prefetchQuery(options);
    const home = await queries.fetchQuery(options);
    assert.equal(home.data.feed.items.length, limit);
    assert.equal(home.data.feedLimit, limit);
    assert.equal(received.filter((url) => url.endsWith(`/dashboard?limit=${limit}`)).length, 1);
    const messages = [...home.data.feed.items];
    let cursor = home.data.feed.nextCursor;
    while (cursor) {
      const next = await request(
        api.platform.activity({
          params: { accountId: account.id },
          query: { cursor, limit },
        }),
      );
      messages.push(...next.data.items);
      cursor = next.data.nextCursor;
    }
    assert.equal(messages.length, 60);
    assert.equal(new Set(messages.map((item) => item.message.id)).size, 60);
  }
});

test("account denial clears completed prefetches and cancels pending route reads", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { createServices } = await vite.ssrLoadModule("/src/session.tsx");
  const { ApiError } = await vite.ssrLoadModule("/src/api.ts");
  const { homeQuery, managedServerQuery } = await vite.ssrLoadModule("/src/dashboard-queries.ts");
  const { api, queries } = createServices("http://localhost");
  t.after(() => queries.clear());
  const accountId = randomUUID();
  const serverId = randomUUID();
  const scope = ["human", "user_alice", accountId];
  const home = homeQuery(api, "user_alice", accountId, 25);
  const management = managedServerQuery(api, "user_alice", accountId, serverId);
  for (const [completed, waiting] of [
    [home, management],
    [management, home],
  ]) {
    const late = Promise.withResolvers();
    let signal;
    queries.setQueryData(completed.queryKey, { protected: "already received" });
    const pending = queries.prefetchQuery({
      ...waiting,
      queryFn: (context) => {
        signal = context.signal;
        return late.promise;
      },
    });
    await assert.rejects(
      queries.fetchQuery({
        queryKey: [...scope, "account"],
        retry: false,
        queryFn: () => {
          throw new ApiError("not_found", "Organization unavailable");
        },
      }),
    );
    assert.equal(signal.aborted, true);
    late.resolve({ protected: "late response" });
    await pending;
    assert.equal(queries.getQueryData(home.queryKey), undefined);
    assert.equal(queries.getQueryData(management.queryKey), undefined);
  }
});
