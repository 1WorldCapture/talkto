import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/** The Feedback button's `POST /v1/feedback` on the real Worker/D1 path. */
const message = (input = {}) => ({
  kind: "bug",
  message: "The Files tab shows nothing after I share a file.",
  page: "/app/accounts/00000000-0000-4000-8000-000000000000/servers/abc",
  appVersion: "talkto@e99e466",
  requestKey: randomUUID(),
  ...input,
});
const agentFeedback = (input = {}) => ({
  kind: "feedback",
  message: "Search missed a message I sent an hour ago.",
  requestKey: randomUUID(),
  ...input,
});
const register = async (x, credential, serverId, name = "Proof") =>
  (
    await x.mcp(credential, "register_participant", {
      serverId,
      name,
      agentType: "codex",
      requestKey: randomUUID(),
    })
  ).data.item.id;
const rows = async (x) =>
  (await x.db.prepare("SELECT * FROM feedback ORDER BY created_at, id").all()).results;
const nextMidnight = () => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
};

test("a signed-in person's feedback is stored with its page, version, browser and account", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const before = Date.now();
  const sent = await x.call(
    "user_alice",
    "POST",
    "/v1/feedback",
    message({
      kind: "feedback",
      message: "  I'd like a dark mode for the docs.  ",
      page: `/app/accounts/${account.id}`,
      accountId: account.id,
    }),
    200,
    { "user-agent": `Mozilla/5.0 ${"x".repeat(400)}` },
  );
  assert.deepEqual(Object.keys(sent).sort(), ["createdAt", "id", "kind"]);
  assert.equal(sent.kind, "feedback");
  assert.ok(Date.parse(sent.createdAt) >= before - 1000);
  const [row, ...others] = await rows(x);
  assert.equal(others.length, 0);
  assert.equal(row.id, sent.id);
  assert.equal(row.created_at, sent.createdAt);
  assert.equal(row.kind, "feedback");
  assert.equal(row.message, "I'd like a dark mode for the docs.", "Trimmed");
  assert.equal(row.user_id, "user_alice");
  assert.equal(row.account_id, account.id);
  assert.equal(row.page, `/app/accounts/${account.id}`);
  assert.equal(row.app_version, "talkto@e99e466");
  assert.equal(row.user_agent.length, 256);
  assert.ok(row.user_agent.startsWith("Mozilla/5.0 "));
  assert.equal(row.read_at, null);
  assert.equal(row.source, "dashboard");
  assert.equal(row.server_id, null);
  assert.equal(row.participant_id, null);
  assert.ok(!JSON.stringify(row).includes("@example.com"), "No email address is stored");

  // An account the sender cannot open is not recorded; the message still arrives.
  await x.call(
    "user_bob",
    "POST",
    "/v1/feedback",
    message({ accountId: account.id, appVersion: undefined }),
  );
  const bob = (await rows(x)).find((value) => value.user_id === "user_bob");
  assert.equal(bob.account_id, null);
  assert.equal(bob.app_version, null);
  assert.equal(bob.kind, "bug");
});

test("signed-out requests are refused and store nothing", async (t) => {
  const x = await start(t);
  const body = JSON.stringify(message());
  for (const headers of [
    { "content-type": "application/json" },
    { "content-type": "application/json", authorization: "Bearer not-a-token" },
    {
      "content-type": "application/json",
      origin: "https://talkto.test",
      cookie: "__Host-talkto-session=not-a-session",
    },
  ]) {
    const response = await x.raw("/v1/feedback", { method: "POST", headers, body });
    const result = await response.json();
    assert.equal(response.status, 401, JSON.stringify(result));
    assert.equal(result.error.code, "unauthenticated");
  }
  assert.deepEqual(await rows(x), []);

  // The website's own session works.
  const flow = await x.browserLogin("user_alice");
  const cookie = (await flow.callback()).headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
  const response = await x.raw("/v1/feedback", {
    method: "POST",
    headers: { cookie, origin: "https://talkto.test", "content-type": "application/json" },
    body,
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await rows(x)).length, 1);
});

test("invalid feedback is refused without echoing it, and 5,000 characters fit", async (t) => {
  const x = await start(t);
  const secret = "my-private-note-1234";
  for (const input of [
    { message: "   " },
    { message: "" },
    { message: `${secret}${"x".repeat(5000)}` },
    { kind: "praise" },
    { page: `/app/accounts?token=${secret}` },
    { page: `/app#${secret}` },
    { page: "app" },
    { page: `/${"a".repeat(512)}` },
    { appVersion: "talkto web <script>" },
    { accountId: "not-an-account" },
    { requestKey: "" },
    { email: `${secret}@example.com` },
  ]) {
    const refused = await x.call("user_alice", "POST", "/v1/feedback", message(input), 400);
    assert.equal(refused.error.code, "invalid_input", JSON.stringify(input));
    assert.ok(!JSON.stringify(refused).includes(secret), "The refusal never echoes the input");
  }
  const missing = message();
  delete missing.requestKey;
  await x.call("user_alice", "POST", "/v1/feedback", missing, 400);
  assert.deepEqual(await rows(x), []);
  await x.call("user_alice", "POST", "/v1/feedback", message({ message: "y".repeat(5000) }));
  assert.equal((await rows(x))[0].message.length, 5000);
});

test("each person can send ten a UTC day, then gets a typed limit until midnight", async (t) => {
  const x = await start(t);
  const first = message();
  await x.call("user_alice", "POST", "/v1/feedback", first);
  for (let i = 1; i < 10; i++) await x.call("user_alice", "POST", "/v1/feedback", message());
  const response = await x.raw("/v1/feedback", {
    method: "POST",
    headers: {
      authorization: `Bearer ${await x.token("user_alice")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(message({ message: "One more" })),
  });
  const refused = await response.json();
  assert.equal(response.status, 429, JSON.stringify(refused));
  assert.equal(refused.error.code, "feedback_limited");
  assert.equal(refused.error.retryable, true);
  assert.equal(refused.error.action, "retry_after");
  assert.equal(refused.error.retryAt, nextMidnight());
  assert.equal(response.headers.get("retry-after"), String(refused.error.retryAfterSeconds));
  assert.match(refused.error.message, /today's 10 messages/);
  assert.ok(!JSON.stringify(refused).includes("One more"));
  assert.equal((await rows(x)).length, 10, "The refused message was not stored");
  // A retry of a message that was stored is still answered, and is not counted again.
  await x.call("user_alice", "POST", "/v1/feedback", first);
  // Another person has their own limit.
  await x.call("user_bob", "POST", "/v1/feedback", message());
  // Yesterday's messages no longer count.
  await x.db
    .prepare(
      "UPDATE feedback SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'-1 day') WHERE user_id='user_alice'",
    )
    .run();
  await x.call("user_alice", "POST", "/v1/feedback", message());
  assert.equal((await rows(x)).length, 12);
});

test("retrying a request key returns the first message; a different message under it conflicts", async (t) => {
  const x = await start(t);
  const input = message();
  const first = await x.call("user_alice", "POST", "/v1/feedback", input);
  const again = await x.call("user_alice", "POST", "/v1/feedback", input);
  assert.deepEqual(again, first);
  assert.equal((await rows(x)).length, 1);
  const conflict = await x.call(
    "user_alice",
    "POST",
    "/v1/feedback",
    { ...input, message: "Something else" },
    409,
  );
  assert.equal(conflict.error.code, "idempotency_conflict");
  // Request keys belong to their sender.
  const bob = await x.call("user_bob", "POST", "/v1/feedback", input);
  assert.notEqual(bob.id, first.id);
  assert.equal((await rows(x)).length, 2);
});

test("an agent's send_feedback is stored under the person behind its grant", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const server = await x.server(account.id);
  const credential = await x.mcpToken(account.organizationId);
  const participantId = await register(x, credential, server.id);
  const sent = await x.mcp(
    credential,
    "send_feedback",
    agentFeedback({ kind: "bug", serverId: server.id, participantId }),
  );
  assert.deepEqual(Object.keys(sent.data).sort(), ["createdAt", "id", "kind"]);
  assert.equal(sent.data.kind, "bug");
  const [row, ...others] = await rows(x);
  assert.equal(others.length, 0);
  assert.equal(row.id, sent.data.id);
  assert.equal(row.source, "agent");
  assert.equal(row.user_id, "user_alice");
  assert.equal(row.account_id, account.id, "The account comes from the server");
  assert.equal(row.server_id, server.id);
  assert.equal(row.participant_id, participantId);
  assert.equal(row.page, null);
  assert.equal(row.app_version, null);
  assert.equal(row.message, "Search missed a message I sent an hour ago.");

  // Without a server, only the person is recorded.
  await x.mcp(credential, "send_feedback", agentFeedback());
  const bare = (await rows(x)).find((value) => value.id !== sent.data.id);
  assert.equal(bare.source, "agent");
  assert.equal(bare.server_id, null);
  assert.equal(bare.account_id, null);

  // A participant needs its server; invalid input stores nothing.
  const secret = "my-private-note-1234";
  for (const input of [
    { participantId },
    { message: "   " },
    { message: `${secret}${"x".repeat(5000)}` },
    { kind: "praise" },
    { page: "/app" },
  ]) {
    const refused = await x.mcp(credential, "send_feedback", agentFeedback(input), true);
    assert.equal(refused.error.code, "invalid_input", JSON.stringify(input));
    assert.ok(!JSON.stringify(refused).includes(secret));
  }
  assert.equal((await rows(x)).length, 2);

  // A retried request key returns the first message.
  const input = agentFeedback({ serverId: server.id });
  const first = await x.mcp(credential, "send_feedback", input);
  assert.deepEqual((await x.mcp(credential, "send_feedback", input)).data, first.data);
  assert.equal((await rows(x)).length, 3);
});

test("send_feedback records a server and agent only when they belong to the person's own access", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const server = await x.server(account.id);
  const alice = await x.mcpToken(account.organizationId);
  await x.control("member", x.member(account.organizationId));
  await x.call("user_alice", "PUT", `/v1/servers/${server.id}/access/user_bob`);
  const bob = await x.mcpToken(account.organizationId, "user_bob");
  const bobs = await register(x, bob, server.id, "Bobs");
  const own = await register(x, alice, server.id);

  // Bob's agent on the same server is not Alice's to name.
  const named = await x.mcp(
    alice,
    "send_feedback",
    agentFeedback({ serverId: server.id, participantId: bobs }),
  );
  // An agent that does not exist is not recorded either.
  const missing = await x.mcp(
    alice,
    "send_feedback",
    agentFeedback({ serverId: server.id, participantId: randomUUID() }),
  );
  // A server the person cannot open is not recorded, and neither is its agent.
  const others = await x.call("user_bob", "POST", "/v1/accounts", {
    name: "Bob's",
    requestKey: randomUUID(),
  });
  const closed = await x.call("user_bob", "POST", `/v1/accounts/${others.id}/servers`, {
    name: "Private",
    requestKey: randomUUID(),
  });
  const bobsPrivate = await register(
    x,
    await x.mcpToken(others.organizationId, "user_bob"),
    closed.id,
  );
  const outside = await x.mcp(
    alice,
    "send_feedback",
    agentFeedback({ serverId: closed.id, participantId: bobsPrivate }),
  );
  // Bob can name his own agent on Alice's server.
  const bobsOwn = await x.mcp(
    bob,
    "send_feedback",
    agentFeedback({ serverId: server.id, participantId: bobs }),
  );
  const byId = new Map((await rows(x)).map((row) => [row.id, row]));
  assert.equal(byId.get(named.data.id).server_id, server.id);
  assert.equal(byId.get(named.data.id).participant_id, null);
  assert.equal(byId.get(missing.data.id).server_id, server.id);
  assert.equal(byId.get(missing.data.id).participant_id, null);
  assert.equal(byId.get(outside.data.id).server_id, null);
  assert.equal(byId.get(outside.data.id).participant_id, null);
  assert.equal(byId.get(outside.data.id).account_id, null);
  assert.equal(byId.get(bobsOwn.data.id).user_id, "user_bob");
  assert.equal(byId.get(bobsOwn.data.id).participant_id, bobs);
  assert.notEqual(own, bobs);
});

test("the dashboard and agents share one daily limit per person", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const credential = await x.mcpToken(account.organizationId);
  for (let i = 0; i < 5; i++) await x.call("user_alice", "POST", "/v1/feedback", message());
  for (let i = 0; i < 5; i++) await x.mcp(credential, "send_feedback", agentFeedback());
  const refused = await x.mcp(
    credential,
    "send_feedback",
    agentFeedback({ message: "One more" }),
    true,
  );
  assert.equal(refused.error.code, "feedback_limited");
  assert.equal(refused.error.retryable, true);
  assert.equal(refused.error.retryAt, nextMidnight());
  assert.match(refused.error.message, /today's 10 messages/);
  assert.ok(!JSON.stringify(refused).includes("One more"));
  const dashboard = await x.call("user_alice", "POST", "/v1/feedback", message(), 429);
  assert.equal(dashboard.error.code, "feedback_limited");
  assert.equal((await rows(x)).length, 10);
});
