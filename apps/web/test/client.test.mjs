import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createServer as createVite } from "vite";
import { start } from "../../server/test/platform-harness.mjs";

test("generated browser client decodes real services, recovers committed creation and cancels transport", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const vite = await createVite({ server: { middlewareMode: true }, appType: "custom" });
  t.after(() => vite.close());
  const { createApi, request, ApiError } = await vite.ssrLoadModule("/src/api.ts");
  let interrupt = true;
  let delayed = false;
  let startDelayed;
  const delayStarted = new Promise((resolve) => {
    startDelayed = resolve;
  });
  let cancelTransport;
  const transportClosed = new Promise((resolve) => {
    cancelTransport = resolve;
  });
  let committedId;
  const server = createServer(async (req, res) => {
    if (delayed) {
      startDelayed();
      res.on("close", cancelTransport);
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await app.raw(req.url, {
      method: req.method,
      headers: { authorization: `Bearer ${await app.token()}`, "content-type": "application/json" },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    if (interrupt && req.method === "POST") {
      interrupt = false;
      committedId = (await response.json()).data.id;
      const result = await app.raw("/v1/me");
      const failure = await result.json();
      failure.error = { code: "storage_unavailable", message: "Confirmation was interrupted." };
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify(failure));
      return;
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address?.port);
  const api = createApi(`http://127.0.0.1:${address.port}`);
  const context = await request(api.platform.getAccount({ params: { accountId: account.id } }));
  assert.equal(context.data.name, account.name);
  const payload = { name: "Recovery", requestKey: randomUUID() };
  await assert.rejects(
    request(api.platform.createServer({ params: { accountId: account.id }, payload })),
    (error) =>
      error instanceof ApiError && error.code === "storage_unavailable" && !!error.requestId,
  );
  const recovered = await request(
    api.platform.createServer({ params: { accountId: account.id }, payload }),
  );
  assert.equal(recovered.data.id, committedId);
  assert.equal(recovered.data.status, "ready");
  const directory = await request(
    api.platform.managedServers({ params: { accountId: account.id }, query: {} }),
  );
  assert.equal(directory.data.items.length, 1);

  // Direct-chat browsing needs names even before the first message, and its feed
  // must never fall back to the server's combined activity.
  const params = { serverId: recovered.data.id };
  const peers = [];
  for (const [name, agentType] of [
    ["release-review-with-a-long-dashed-name", "codex"],
    ["browser-review", "chatgpt-web"],
    ["build-review", "claude-code"],
  ]) {
    const joined = await request(
      api.server.registerParticipant({
        params,
        payload: { name, agentType, requestKey: randomUUID() },
      }),
    );
    peers.push(joined.data.item);
  }
  const chats = [];
  for (const recipient of peers.slice(1)) {
    const opened = await request(
      api.server.openDirectConversation({
        params,
        payload: { participantId: peers[0].id, recipientId: recipient.id },
      }),
    );
    chats.push(opened.data.item);
  }
  const firstChatPage = await request(
    api.server.listDirectConversations({ params, query: { limit: 1 } }),
  );
  assert.equal(firstChatPage.data.items.length, 1);
  assert.ok(firstChatPage.data.nextCursor);
  for (const id of firstChatPage.data.items[0].participantIds)
    assert.ok(firstChatPage.included.participants.some((peer) => peer.id === id && peer.name));
  const secondChatPage = await request(
    api.server.listDirectConversations({
      params,
      query: { cursor: firstChatPage.data.nextCursor, limit: 1 },
    }),
  );
  assert.equal(secondChatPage.data.nextCursor, null);
  assert.notEqual(firstChatPage.data.items[0].id, secondChatPage.data.items[0].id);
  const conversationParams = { ...params, conversationId: chats[0].id };
  const selected = await request(api.server.getConversation({ params: conversationParams }));
  assert.equal(selected.data.kind, "direct");
  assert.equal(selected.data.messageCount, 0);
  assert.equal(selected.included.participants.length, 2);
  const emptyFeed = await request(
    api.server.serverFeed({ params, query: { conversationId: chats[0].id } }),
  );
  assert.equal(emptyFeed.data.items.length, 0);
  for (const chat of chats)
    await request(
      api.server.sendMessage({
        params: { ...params, conversationId: chat.id },
        payload: {
          participantId: peers[0].id,
          body: `History for ${chat.id}`,
          requestKey: randomUUID(),
        },
      }),
    );
  const selectedFeed = await request(
    api.server.serverFeed({ params, query: { conversationId: chats[0].id } }),
  );
  assert.deepEqual(
    selectedFeed.data.items.map((message) => message.conversationId),
    [chats[0].id],
  );
  assert.equal((await request(api.server.serverFeed({ params, query: {} }))).data.items.length, 2);
  delayed = true;
  const abort = new AbortController();
  const pending = request(api.platform.currentUser(), abort.signal).catch((error) => error);
  await delayStarted;
  abort.abort();
  assert.ok((await pending) instanceof Error);
  await transportClosed;
});

test("Query cancellation fences late account results and rejects invalid filters before transport", async (t) => {
  const vite = await createVite({ server: { middlewareMode: true }, appType: "custom" });
  t.after(() => vite.close());
  const { createServices } = await vite.ssrLoadModule("/src/session.tsx");
  const { input, ApiError } = await vite.ssrLoadModule("/src/api.ts");
  const P = await vite.ssrLoadModule("/../../packages/api/src/platform.ts");
  const { queries } = createServices("http://localhost");
  t.after(() => queries.clear());
  let resolveOld;
  const old = new Promise((resolve) => {
    resolveOld = resolve;
  });
  const key = ["human", "user_alice", "account-a", "servers"];
  const pending = queries.fetchQuery({ queryKey: key, queryFn: () => old }).catch((error) => error);
  await queries.cancelQueries({ queryKey: key });
  queries.setQueryData(["human", "user_alice", "account-b", "servers"], ["B"]);
  resolveOld(["A"]);
  await pending;
  assert.equal(queries.getQueryData(key), undefined);
  assert.deepEqual(queries.getQueryData(["human", "user_alice", "account-b", "servers"]), ["B"]);
  assert.deepEqual(input(P.IdentityListing, { query: "", after: undefined, limit: 9 }), {
    limit: 9,
  });
  assert.throws(() => input(P.IdentityListing, { query: "x".repeat(129) }), ApiError);
});

test("a denied server read removes cached agent data and fences in-flight account activity", async (t) => {
  const vite = await createVite({ server: { middlewareMode: true }, appType: "custom" });
  t.after(() => vite.close());
  const { createServices } = await vite.ssrLoadModule("/src/session.tsx");
  const { ApiError } = await vite.ssrLoadModule("/src/api.ts");
  const { queries } = createServices("http://localhost");
  t.after(() => queries.clear());
  const scope = ["human", "user_alice", "account-a"];
  const summary = [...scope, "server-a", "summary"];
  const timeline = [...scope, "server-a", "timeline", "day"];
  const feed = [...scope, "aggregate", "feed"];
  const management = [...scope, "server-a", "management"];
  const chats = [...scope, "server-a", "direct-chats"];
  const conversation = [...scope, "server-a", "conversation", "pair-a"];
  queries.setQueryData(summary, { private: "agents" });
  queries.setQueryData(timeline, { private: "counts and sending agents" });
  queries.setQueryData(management, { owner: true });
  queries.setQueryData(chats, { private: "agent pairs" });
  queries.setQueryData(conversation, { private: "selected agents" });
  let resolveLate;
  const late = new Promise((resolve) => {
    resolveLate = resolve;
  });
  const pending = queries
    .fetchQuery({ queryKey: feed, queryFn: () => late })
    .catch((error) => error);
  await assert.rejects(
    queries.fetchQuery({
      queryKey: summary,
      staleTime: 0,
      queryFn: () => {
        throw new ApiError("forbidden", "Access revoked");
      },
    }),
  );
  resolveLate({ private: "late messages" });
  await pending;
  assert.equal(queries.getQueryData(summary), undefined);
  assert.equal(queries.getQueryData(timeline), undefined);
  assert.equal(queries.getQueryData(feed), undefined);
  assert.equal(queries.getQueryData(chats), undefined);
  assert.equal(queries.getQueryData(conversation), undefined);
  assert.deepEqual(queries.getQueryData(management), { owner: true });
});
