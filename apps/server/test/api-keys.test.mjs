import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";
import { rpc } from "./mcp-wire.mjs";

/*
  Personal API keys: made only in the website, shown once, stored as a hash, acting as exactly the
  person who made them (so grants and agent ownership see that person), narrowed to reads or to one
  organization, refused once revoked or expired, and never accepted on /mcp.
*/

/** The website's session for one person. */
const website = async (x, user = "user_alice") => {
  const flow = await x.browserLogin(user);
  const cookie = (await flow.callback()).headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
  return async (method, path, value) => {
    const response = await x.raw(path, {
      method,
      headers: { cookie, origin: "https://talkto.test", "content-type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    return { status: response.status, json: await response.json() };
  };
};
/** A request with a key as the bearer credential. */
const withKey = (x, secret) => async (method, path, value) => {
  const response = await x.raw(path, {
    method,
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  return { status: response.status, json: await response.json() };
};
const make = async (session, input) => {
  const made = await session("POST", "/v1/me/api-keys", input);
  assert.equal(made.status, 200, JSON.stringify(made.json));
  return made.json.data;
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
/** Billing switched on with a Stripe that fails every call; a refused key never reaches it. */
const stripe = () => {
  const calls = [];
  return {
    calls,
    handler: async (request) => {
      calls.push(new URL(request.url).pathname);
      return new Response("{}", { status: 500 });
    },
  };
};

test("the website makes a key, shows its secret once and stores only its hash", async (t) => {
  const x = await start(t);
  const alice = await website(x);
  const made = await make(alice, { name: "  CI deploys  ", access: "full", expiresInDays: 30 });
  assert.match(made.secret, /^tk_[A-Za-z0-9_-]{43}$/);
  assert.equal(made.key.name, "CI deploys");
  assert.equal(made.key.access, "full");
  assert.equal(made.key.accountId, null);
  assert.equal(made.key.prefix, made.secret.slice(0, 11));
  assert.equal(made.key.lastUsedAt, null);
  const lifetime = Date.parse(made.key.expiresAt) - Date.parse(made.key.createdAt);
  assert.equal(lifetime, 30 * 86_400_000);

  const listed = await alice("GET", "/v1/me/api-keys");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.data.items, [made.key]);
  assert.equal(listed.json.data.max, 20);
  assert.ok(!JSON.stringify(listed.json).includes(made.secret));

  const rows = (await x.db.prepare("SELECT * FROM api_keys").all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, "user_alice");
  assert.equal(rows[0].secret_hash, sha256(made.secret));
  for (const value of Object.values(rows[0])) assert.ok(!String(value).includes(made.secret));
});

test("only the website makes keys: a sign-in token or a key is refused", async (t) => {
  const x = await start(t);
  await x.call("user_alice", "POST", "/v1/me/api-keys", { name: "x", access: "full" }, 403);
  const { secret } = await make(await website(x), { name: "first", access: "full" });
  const again = await withKey(x, secret)("POST", "/v1/me/api-keys", { name: "y", access: "full" });
  assert.equal(again.status, 403, JSON.stringify(again.json));
  assert.equal(again.json.error.code, "forbidden");
});

test("a key acts as its person: same grants, and their agents send", async (t) => {
  const x = await start(t, { agentOwnership: "enforce" });
  const { secret } = await make(await website(x), { name: "bot", access: "full" });
  const key = withKey(x, secret);

  const me = await key("GET", "/v1/me");
  assert.equal(me.status, 200, JSON.stringify(me.json));
  assert.equal(me.json.data.user.id, "user_alice");

  // Organizations and servers, made with the key, are Alice's.
  const account = await key("POST", "/v1/accounts", { name: "Keyed", requestKey: randomUUID() });
  assert.equal(account.status, 200, JSON.stringify(account.json));
  const server = await key("POST", `/v1/accounts/${account.json.data.id}/servers`, {
    name: "Builds",
    requestKey: randomUUID(),
  });
  assert.equal(server.status, 200, JSON.stringify(server.json));
  assert.equal(server.json.data.createdBy, "user_alice");
  const root = `/v1/servers/${server.json.data.id}`;

  // An agent registered and driven by the key passes the agent-ownership check as Alice.
  const registered = await key("POST", `${root}/participants`, {
    name: "deployer",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.json));
  const agent = registered.json.data.item.id;
  const general = registered.json.data.generalConversationId;
  const sent = await key("POST", `${root}/conversations/${general}/messages`, {
    participantId: agent,
    requestKey: randomUUID(),
    body: "Deployed.",
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  // Her sign-in sees the same agent and message.
  const read = await x.call("user_alice", "GET", `${root}/conversations/${general}/messages`);
  assert.deepEqual(
    read.items.map((item) => item.body),
    ["Deployed."],
  );

  // A key is the person, so the dashboard's own actions work with it (owner, 25 Nov): renaming,
  // and removing and restoring an agent. A sign-in token, which agents use, still cannot.
  const rename = await key(
    "POST",
    `/v1/accounts/${account.json.data.id}/servers/${server.json.data.id}/rename`,
    { name: "Renamed", requestKey: randomUUID() },
  );
  assert.equal(rename.status, 200, JSON.stringify(rename.json));
  const renamedAccount = await key("POST", `/v1/accounts/${account.json.data.id}/rename`, {
    name: "Keyed again",
    requestKey: randomUUID(),
  });
  assert.equal(renamedAccount.status, 200, JSON.stringify(renamedAccount.json));
  const byToken = await x.call(
    "user_alice",
    "POST",
    `${root}/participants/${agent}/remove`,
    {},
    403,
  );
  assert.equal(byToken.error.code, "forbidden");
  const removed = await key("POST", `${root}/participants/${agent}/remove`, {});
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  const restored = await key("POST", `${root}/participants/${agent}/restore`, {});
  assert.equal(restored.status, 200, JSON.stringify(restored.json));

  // The key's use is recorded, after the response.
  for (let i = 0; i < 100; i++) {
    const [row] = (await x.db.prepare("SELECT last_used_at FROM api_keys").all()).results;
    if (row.last_used_at !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("the key's use was never recorded");
});

test("a key reads the Board and a read key still cannot rename", async (t) => {
  const x = await start(t, { board: true });
  const account = await x.account();
  const server = await x.server(account.id, { board: true });
  const alice = await website(x);
  const full = withKey(x, (await make(alice, { name: "board", access: "full" })).secret);
  const board = await full("GET", `/v1/servers/${server.id}/board`);
  assert.equal(board.status, 200, JSON.stringify(board.json));
  const tasks = await full("GET", `/v1/servers/${server.id}/board/tasks`);
  assert.equal(tasks.status, 200, JSON.stringify(tasks.json));
  const read = withKey(x, (await make(alice, { name: "reader", access: "read" })).secret);
  assert.equal((await read("GET", `/v1/servers/${server.id}/board`)).status, 200);
  const rename = await read("POST", `/v1/accounts/${account.id}/servers/${server.id}/rename`, {
    name: "Nope",
    requestKey: randomUUID(),
  });
  assert.equal(rename.status, 403, JSON.stringify(rename.json));
});

test("a key never reaches another person's servers or agents", async (t) => {
  const x = await start(t, { agentOwnership: "enforce" });
  const account = await x.account();
  const server = await x.server(account.id);
  const { secret } = await make(await website(x, "user_bob"), { name: "bob", access: "full" });
  const bob = withKey(x, secret);
  const denied = await bob("GET", `/v1/servers/${server.id}/channels`);
  assert.equal(denied.status, 404, JSON.stringify(denied.json));
  assert.equal(denied.json.error.code, "server_unavailable");
});

test("a read key reads, and can only revoke itself otherwise", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const alice = await website(x);
  const made = await make(alice, { name: "dashboard", access: "read" });
  const key = withKey(x, made.secret);
  assert.equal((await key("GET", `/v1/accounts/${account.id}`)).status, 200);
  const write = await key("POST", "/v1/accounts", { name: "No", requestKey: randomUUID() });
  assert.equal(write.status, 403, JSON.stringify(write.json));
  assert.match(write.json.error.message, /can only read/);
  const revoked = await key("DELETE", `/v1/me/api-keys/${made.key.id}`);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
  assert.equal(revoked.json.data.id, made.key.id);
  // Revoked: refused in the same words as an unknown key.
  const after = await key("GET", "/v1/me");
  assert.equal(after.status, 401, JSON.stringify(after.json));
  const unknown = await withKey(x, `tk_${"A".repeat(43)}`)("GET", "/v1/me");
  assert.equal(unknown.status, 401);
  assert.equal(unknown.json.error.message, after.json.error.message);
  assert.deepEqual((await alice("GET", "/v1/me/api-keys")).json.data.items, []);
  // Revoking again is not found.
  assert.equal((await alice("DELETE", `/v1/me/api-keys/${made.key.id}`)).status, 404);
});

test("an organization-limited key stays inside its organization", async (t) => {
  const x = await start(t);
  const inside = await x.account();
  const outside = await x.account();
  const insideServer = await x.server(inside.id);
  const outsideServer = await x.server(outside.id);
  const { secret } = await make(await website(x), {
    name: "team bot",
    access: "full",
    accountId: inside.id,
  });
  const key = withKey(x, secret);
  assert.equal((await key("GET", `/v1/accounts/${inside.id}`)).status, 200);
  assert.equal((await key("GET", `/v1/servers/${insideServer.id}/channels`)).status, 200);
  for (const path of [`/v1/accounts/${outside.id}`, `/v1/servers/${outsideServer.id}/channels`]) {
    const refused = await key("GET", path);
    assert.equal(refused.status, 403, `${path}: ${JSON.stringify(refused.json)}`);
  }
  // Writes outside any organization are refused too.
  const created = await key("POST", "/v1/accounts", { name: "No", requestKey: randomUUID() });
  assert.equal(created.status, 403);
  // Outside its organization it reads only who it is: no listing of other organizations or keys.
  for (const path of ["/v1/accounts", "/v1/servers", "/v1/shared", "/v1/me/api-keys"]) {
    const refused = await key("GET", path);
    assert.equal(refused.status, 403, `${path}: ${JSON.stringify(refused.json)}`);
  }
  assert.equal((await key("GET", "/v1/me")).status, 200);
});

test("a read key revokes only itself; a full key revokes any of its person's keys", async (t) => {
  const x = await start(t);
  const alice = await website(x);
  const reader = await make(alice, { name: "reader", access: "read" });
  const other = await make(alice, { name: "other", access: "read" });
  const writer = await make(alice, { name: "writer", access: "full" });
  const refused = await withKey(x, reader.secret)("DELETE", `/v1/me/api-keys/${other.key.id}`);
  assert.equal(refused.status, 403, JSON.stringify(refused.json));
  assert.equal((await withKey(x, other.secret)("GET", "/v1/me")).status, 200);
  const revoked = await withKey(x, writer.secret)("DELETE", `/v1/me/api-keys/${other.key.id}`);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
  assert.equal((await withKey(x, other.secret)("GET", "/v1/me")).status, 401);
});

test("no key changes billing or removes members; a full key deletes a server", async (t) => {
  const provider = stripe();
  const x = await start(t, { stripeHandler: provider.handler });
  const account = await x.account();
  const server = await x.server(account.id);
  const { secret } = await make(await website(x), { name: "admin", access: "full" });
  const key = withKey(x, secret);
  for (const [method, path, body] of [
    [
      "POST",
      `/v1/accounts/${account.id}/billing/checkout`,
      { plan: "studio", requestKey: randomUUID() },
    ],
    [
      "POST",
      `/v1/accounts/${account.id}/billing/plan`,
      { plan: "studio", requestKey: randomUUID() },
    ],
    ["POST", `/v1/accounts/${account.id}/billing/portal`],
    ["DELETE", `/v1/accounts/${account.id}/members/user_bob`],
  ]) {
    const refused = await key(method, path, body);
    assert.equal(refused.status, 403, `${method} ${path}: ${JSON.stringify(refused.json)}`);
    assert.match(refused.json.error.message, /on the TalkTo website/);
  }
  assert.equal((await key("GET", `/v1/servers/${server.id}`)).status, 200);
  assert.deepEqual(provider.calls, []);
  const deleted = await key("POST", `/v1/accounts/${account.id}/servers/${server.id}/delete`, {});
  assert.notEqual(deleted.status, 403, JSON.stringify(deleted.json));
});

test("a key can be limited only to an organization its person is in", async (t) => {
  const x = await start(t);
  const alice = await website(x);
  const missing = await alice("POST", "/v1/me/api-keys", {
    name: "nowhere",
    access: "read",
    accountId: randomUUID(),
  });
  assert.equal(missing.status, 404, JSON.stringify(missing.json));
  const bobs = await x.call("user_bob", "POST", "/v1/accounts", {
    name: "Bob's",
    requestKey: randomUUID(),
  });
  const theirs = await alice("POST", "/v1/me/api-keys", {
    name: "theirs",
    access: "read",
    accountId: bobs.id,
  });
  // The same answer as an organization that does not exist.
  assert.equal(theirs.status, 404, JSON.stringify(theirs.json));
  assert.equal(theirs.json.error.message, missing.json.error.message);
});

test("deleting the account stops its keys at once", async (t) => {
  const x = await start(t);
  const alice = await website(x);
  const { secret } = await make(alice, { name: "doomed", access: "full" });
  const key = withKey(x, secret);
  assert.equal((await key("GET", "/v1/me")).status, 200);
  const deleted = await alice("POST", "/v1/me/delete", { confirmation: "user_alice@example.com" });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  for (const [method, path, body] of [
    ["GET", "/v1/me/api-keys"],
    ["PUT", "/v1/me/email", { productUpdates: true }],
  ]) {
    const refused = await key(method, path, body);
    assert.equal(refused.status, 401, `${method} ${path}: ${JSON.stringify(refused.json)}`);
  }
  const rows = (await x.db.prepare("SELECT revoked_at FROM api_keys").all()).results;
  assert.ok(rows.every((row) => row.revoked_at !== null));
});

test("with a tag secret, keys are tagged and a made-up key is refused before D1", async (t) => {
  const x = await start(t, { apiKeySecret: true, signalKey: true });
  const alice = await website(x);
  const { secret } = await make(alice, { name: "tagged", access: "read" });
  const bytes = Buffer.from(secret.slice(3), "base64url");
  const tag = createHmac("sha256", Buffer.from(x.apiKeySecret, "base64url"))
    .update(`talkto-api-key-v1:${bytes.subarray(0, 16).toString("base64url")}`)
    .digest()
    .subarray(0, 16);
  assert.deepEqual(bytes.subarray(16), tag);
  assert.equal((await withKey(x, secret)("GET", "/v1/me")).status, 200);
  // Same format, wrong tag: refused in the same words as a revoked key.
  const forged = `tk_${Buffer.concat([bytes.subarray(0, 16), Buffer.alloc(16)]).toString("base64url")}`;
  const refused = await withKey(x, forged)("GET", "/v1/me");
  assert.equal(refused.status, 401);
  assert.match(refused.json.error.message, /unknown, revoked or expired/);
});

test("a network that sends too many bad keys gets 429 with Retry-After, before any lookup", async (t) => {
  const x = await start(t, { apiKeySecret: true, signalFailuresPerMinute: 2 });
  const from = (address) => (secret) =>
    x.raw("/v1/me", {
      headers: { authorization: `Bearer ${secret}`, "cf-connecting-ip": address },
    });
  const bad = from("203.0.113.20");
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await bad(`tk_${"B".repeat(43)}`)).status);
  assert.deepEqual(statuses.slice(0, 2), [401, 401]);
  const limited = await bad(`tk_${"B".repeat(43)}`);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  const body = await limited.json();
  assert.equal(body.error.code, "rate_limited");
  assert.equal(body.error.scope, "network");
  // Another network is unaffected.
  const { secret } = await make(await website(x), { name: "good", access: "read" });
  assert.equal((await from("203.0.113.21")(secret)).status, 200);
});

test("a D1 outage locks out no real key, and a remembered key passes a network's block", async (t) => {
  const outage = async (x) => {
    await x.db.prepare("ALTER TABLE api_keys RENAME TO api_keys_away").run();
    return () => x.db.prepare("ALTER TABLE api_keys_away RENAME TO api_keys").run();
  };
  const from = (x, address) => (secret) =>
    x.raw("/v1/me", {
      headers: { authorization: `Bearer ${secret}`, "cf-connecting-ip": address },
    });

  // With a tag secret, D1 failures are not counted: forgeries never reach D1.
  const tagged = await start(t, { apiKeySecret: true, signalFailuresPerMinute: 2 });
  const alice = await website(tagged);
  const cached = (await make(alice, { name: "cached", access: "read" })).secret;
  const fresh = (await make(alice, { name: "fresh", access: "read" })).secret;
  const office = from(tagged, "203.0.113.30");
  assert.equal((await office(cached)).status, 200);
  const restore = await outage(tagged);
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await office(fresh)).status);
  assert.deepEqual(statuses, [503, 503, 503, 503, 503]);
  assert.equal((await office(cached)).status, 200);
  await restore();
  assert.equal((await office(fresh)).status, 200);

  // Without one, D1 failures count, but a key this isolate already checked still passes the block.
  const plain = await start(t, { signalFailuresPerMinute: 2 });
  const bob = await website(plain);
  const known = (await make(bob, { name: "known", access: "read" })).secret;
  const lab = from(plain, "203.0.113.31");
  assert.equal((await lab(known)).status, 200);
  await outage(plain);
  const counted = [];
  for (let i = 0; i < 4; i++) counted.push((await lab(`tk_${"C".repeat(43)}`)).status);
  assert.equal(counted.at(-1), 429);
  assert.equal((await lab(known)).status, 200);
});

test("member removal and billing refuse keys however the path is spelled", async (t) => {
  const provider = stripe();
  const x = await start(t, { stripeHandler: provider.handler });
  const account = await x.account();
  const members = ["user_bob", "user_carol", "user_dave", "user_erin"];
  for (const user of members) await x.control("member", x.member(account.organizationId, user));
  const { secret } = await make(await website(x), { name: "admin", access: "full" });
  const key = withKey(x, secret);
  const base = `/v1/accounts/${account.id}`;
  for (const [method, path, body] of [
    ["DELETE", `${base}/members/user_bob`],
    ["DELETE", `${base}/members/user_bob/`],
    ["DELETE", `${base}//members/user_carol`],
    ["DELETE", `${base}/MEMBERS/user_dave`],
    ["DELETE", `${base}/%6Dembers/user_erin`],
    ["POST", `${base}/billing/plan`, { plan: "studio", requestKey: randomUUID() }],
    ["POST", `${base}/billing/plan/`, { plan: "studio", requestKey: randomUUID() }],
    ["POST", `${base}//billing/portal`],
    ["POST", `${base}/BILLING/portal`, {}],
    ["POST", `${base}/%62illing/portal`, {}],
  ]) {
    const refused = await key(method, path, body);
    // Billing has its own router: an odd spelling of its paths matches no route at all (404).
    // Every spelling that reaches a handler, and every member removal, is refused there.
    const oddBilling =
      /billing/i.test(decodeURIComponent(path)) && !path.includes(`${account.id}/billing/`);
    if (oddBilling && refused.status === 404) continue;
    assert.equal(refused.status, 403, `${method} ${path}: ${JSON.stringify(refused.json)}`);
    assert.match(refused.json.error.message, /on the TalkTo website/);
  }
  assert.equal((await key("DELETE", `${base}/members/user_bob`)).status, 403);
  assert.deepEqual(provider.calls, [], "no billing request reached Stripe");
  const listed = await x.call("user_alice", "GET", `${base}/members`);
  const status = new Map(listed.items.map((item) => [item.userId, item.status]));
  for (const user of members) assert.equal(status.get(user), "active", user);
  // A signed-in person can still remove one: the refusal is about the key.
  await x.call("user_alice", "DELETE", `${base}/members/user_bob`);
});

test("an expired key is refused, and a person has at most 20 keys", async (t) => {
  const x = await start(t);
  const alice = await website(x);
  const made = await make(alice, { name: "short", access: "full", expiresInDays: 1 });
  await x.db
    .prepare("UPDATE api_keys SET expires_at=? WHERE id=?")
    .bind(Date.now() - 1, made.key.id)
    .run();
  assert.equal((await withKey(x, made.secret)("GET", "/v1/me")).status, 401);
  // An expired key no longer counts toward the 20.
  for (let i = 1; i <= 20; i++) await make(alice, { name: `key ${i}`, access: "read" });
  const full = await alice("POST", "/v1/me/api-keys", { name: "one more", access: "read" });
  assert.equal(full.status, 409, JSON.stringify(full.json));
  assert.equal(full.json.error.code, "api_key_limit_reached");
});

test("keys never work on /mcp", async (t) => {
  const x = await start(t);
  const { secret } = await make(await website(x), { name: "bot", access: "full" });
  const response = await x.raw("/mcp", rpc("server/discover", {}, secret));
  assert.equal(response.status, 401);
});

test("the OpenAPI document describes the key routes", async (t) => {
  const x = await start(t);
  const spec = await (await x.raw("/openapi.json")).json();
  assert.ok(spec.paths["/v1/me/api-keys"]?.get);
  assert.ok(spec.paths["/v1/me/api-keys"]?.post);
  assert.ok(spec.paths["/v1/me/api-keys/{id}"]?.delete);
});

test("a person-only action refuses a forged key marker, read keys and keys outside their organization", async (t) => {
  const x = await start(t, { board: true });
  const alice = await website(x);
  const full = withKey(x, (await make(alice, { name: "full", access: "full" })).secret);
  const read = withKey(x, (await make(alice, { name: "read", access: "read" })).secret);
  const home = (await full("POST", "/v1/accounts", { name: "Home", requestKey: randomUUID() })).json
    .data.id;
  const away = (await full("POST", "/v1/accounts", { name: "Away", requestKey: randomUUID() })).json
    .data.id;
  const limited = withKey(
    x,
    (await make(alice, { name: "home", access: "full", accountId: home })).secret,
  );
  const serverIn = async (accountId) =>
    (
      await full("POST", `/v1/accounts/${accountId}/servers`, {
        name: "Builds",
        requestKey: randomUUID(),
        board: true,
      })
    ).json.data.id;
  const awayServer = await serverIn(away);
  const root = `/v1/servers/${awayServer}`;
  const agent = (
    await full("POST", `${root}/participants`, {
      name: "deployer",
      agentType: "codex",
      requestKey: randomUUID(),
    })
  ).json.data.item.id;

  // A sign-in token with a forged marker is still not the person, in any spelling.
  for (const marker of ["api-key", "API-KEY", "api-key, website-session", "website-session"]) {
    const forged = await x.raw(`${root}/participants/${agent}/remove`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await x.token("user_alice")}`,
        "x-talkto-authenticated-by": marker,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(forged.status, 403, marker);
  }

  const writes = [
    ["POST", `${root}/participants/${agent}/remove`, {}],
    ["POST", `${root}/participants/${agent}/restore`, {}],
    [
      "POST",
      `${root}/participants/${agent}/wakes`,
      { kind: "claude_routine", url: "https://example.com/", token: "x", directChats: "own" },
    ],
    ["POST", `${root}/participants/${agent}/wakes/${randomUUID()}/test`, undefined],
    [
      "POST",
      `${root}/people/me/tasks/${randomUUID()}/cancel`,
      { expectedRevision: 1, requestKey: randomUUID() },
    ],
    [
      "POST",
      `${root}/people/me/tasks/${randomUUID()}/reopen`,
      { expectedRevision: 1, requestKey: randomUUID() },
    ],
    [
      "POST",
      `/v1/accounts/${away}/servers/${awayServer}/rename`,
      { name: "No", requestKey: randomUUID() },
    ],
  ];
  for (const [method, path, body] of writes) {
    const byRead = await read(method, path, body);
    assert.equal(byRead.status, 403, `read key ${path}: ${JSON.stringify(byRead.json)}`);
    const outside = await limited(method, path, body);
    assert.equal(outside.status, 403, `limited key ${path}: ${JSON.stringify(outside.json)}`);
  }
  for (const path of [`${root}/board`, `${root}/board/tasks`, `${root}/board/labels`]) {
    assert.equal((await limited("GET", path)).status, 403, path);
  }
  // Another organization's server under the key's own organization's address is not found.
  const smuggled = await limited("POST", `/v1/accounts/${home}/servers/${awayServer}/rename`, {
    name: "Smuggled",
    requestKey: randomUUID(),
  });
  assert.ok([403, 404].includes(smuggled.status), JSON.stringify(smuggled.json));
  const names = await full("GET", `/v1/accounts/${away}/servers/${awayServer}/renames`);
  assert.deepEqual(names.json.data.items, []);
});

test("no key deletes the account or an organization, or makes a key", async (t) => {
  const x = await start(t);
  const full = withKey(x, (await make(await website(x), { name: "full", access: "full" })).secret);
  const account = (await full("POST", "/v1/accounts", { name: "Keep", requestKey: randomUUID() }))
    .json.data.id;
  for (const [path, body] of [
    // Real confirmations (the person's email, the organization's name), so only the key refuses.
    ["/v1/me/delete", { confirmation: "alice@example.com" }],
    [`/v1/accounts/${account}/delete`, { confirmation: "Keep" }],
    ["/v1/me/api-keys", { name: "child", access: "full" }],
  ]) {
    const refused = await full("POST", path, body);
    assert.equal(refused.status, 403, `${path}: ${JSON.stringify(refused.json)}`);
    assert.match(refused.json.error.message, /website/i, path);
  }
  assert.equal((await full("GET", "/v1/me")).status, 200);
});

test("a member's key cannot rename a server it does not manage", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const server = await x.server(account.id);
  await x.control("member", x.member(account.organizationId, "user_bob"));
  await x.call("user_alice", "PUT", `/v1/servers/${server.id}/access/user_bob`);
  const bob = withKey(
    x,
    (await make(await website(x, "user_bob"), { name: "bob", access: "full" })).secret,
  );
  const rename = await bob("POST", `/v1/accounts/${account.id}/servers/${server.id}/rename`, {
    name: "Bobs",
    requestKey: randomUUID(),
  });
  assert.equal(rename.status, 403, JSON.stringify(rename.json));
});

test("one server or organization is renamed at most 10 times an hour", async (t) => {
  const x = await start(t);
  const key = withKey(x, (await make(await website(x), { name: "loop", access: "full" })).secret);
  const account = (await key("POST", "/v1/accounts", { name: "Loop", requestKey: randomUUID() }))
    .json.data.id;
  const server = (
    await key("POST", `/v1/accounts/${account}/servers`, { name: "Spin", requestKey: randomUUID() })
  ).json.data.id;
  for (const path of [
    `/v1/accounts/${account}/servers/${server}/rename`,
    `/v1/accounts/${account}/rename`,
  ]) {
    for (let i = 0; i < 10; i++) {
      const renamed = await key("POST", path, { name: `Name ${i}`, requestKey: randomUUID() });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
    }
    const refused = await key("POST", path, { name: "Eleventh", requestKey: randomUUID() });
    assert.equal(refused.status, 429, JSON.stringify(refused.json));
    assert.equal(refused.json.error.code, "rate_limited");
    assert.equal(refused.json.error.scope, path.includes("/servers/") ? "server" : "organization");
    assert.ok(refused.json.error.retryAfterSeconds >= 1);
  }
});

test("parallel renames cannot pass the hourly limit together", async (t) => {
  const x = await start(t);
  const key = withKey(x, (await make(await website(x), { name: "burst", access: "full" })).secret);
  const account = (await key("POST", "/v1/accounts", { name: "Burst", requestKey: randomUUID() }))
    .json.data.id;
  const requests = Array.from({ length: 40 }, (_, i) => ({
    name: `Burst ${i}`,
    requestKey: randomUUID(),
  }));
  const answers = await Promise.all(
    requests.map((request) => key("POST", `/v1/accounts/${account}/rename`, request)),
  );
  const statuses = answers.map((answer) => answer.status);
  assert.equal(statuses.filter((status) => status === 200).length, 10, JSON.stringify(statuses));
  assert.equal(statuses.filter((status) => status === 429).length, 30, JSON.stringify(statuses));
  // Past the limit, retrying a rename that went through still answers with its outcome.
  const first = answers.findIndex((answer) => answer.status === 200);
  const retried = await key("POST", `/v1/accounts/${account}/rename`, requests[first]);
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  assert.equal(retried.json.data.changed, false);
});

test("the docs API page's examples work with a key", async (t) => {
  const x = await start(t);
  const key = withKey(x, (await make(await website(x), { name: "docs", access: "full" })).secret);
  const account = await key("POST", "/v1/accounts", { name: "acme", requestKey: "create-acme-1" });
  assert.equal(account.status, 200, JSON.stringify(account.json));
  const accountId = account.json.data.id;
  const server = await key("POST", `/v1/accounts/${accountId}/servers`, {
    name: "builds",
    requestKey: "create-builds-1",
  });
  assert.equal(server.status, 200, JSON.stringify(server.json));
  const swarm = await key("POST", `/v1/accounts/${accountId}/servers`, {
    name: "swarm",
    requestKey: "create-swarm-1",
    board: true,
  });
  assert.equal(swarm.status, 200, JSON.stringify(swarm.json));
  const serverId = server.json.data.id;
  const member = await key("POST", `/v1/accounts/${accountId}/invitations`, {
    email: "bob@example.com",
  });
  assert.equal(member.status, 200, JSON.stringify(member.json));
  const guest = await key("POST", `/v1/servers/${serverId}/invitations`, {
    email: "carol@example.com",
  });
  assert.equal(guest.status, 200, JSON.stringify(guest.json));
  const candidates = await key("GET", `/v1/servers/${serverId}/access/candidates`);
  assert.equal(candidates.status, 200, JSON.stringify(candidates.json));
  // Grant and revoke a member's access to the server.
  await x.control("member", x.member(account.json.data.organizationId, "user_dave"));
  const granted = await key("PUT", `/v1/servers/${serverId}/access/user_dave`);
  assert.equal(granted.status, 200, JSON.stringify(granted.json));
  const revoked = await key("DELETE", `/v1/servers/${serverId}/access/user_dave`);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
  const registered = await key("POST", `/v1/servers/${serverId}/participants`, {
    name: "deployer",
    agentType: "script",
    requestKey: "register-deployer-1",
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.json));
  const agentId = registered.json.data.item.id;
  const generalId = registered.json.data.generalConversationId;
  const reader = await key("POST", `/v1/servers/${serverId}/participants`, {
    name: "reader",
    agentType: "script",
    requestKey: "register-reader-1",
  });
  assert.equal(reader.status, 200, JSON.stringify(reader.json));
  const sent = await key("POST", `/v1/servers/${serverId}/conversations/${generalId}/messages`, {
    participantId: agentId,
    body: "Deployed.",
    requestKey: "deploy-note-1",
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  const updates = await key("POST", `/v1/servers/${serverId}/updates`, {
    participantId: reader.json.data.item.id,
    mode: "start",
    startAt: "beginning",
    channelIds: [generalId],
    directChats: "own",
  });
  assert.equal(updates.status, 200, JSON.stringify(updates.json));
  assert.deepEqual(
    updates.json.data.messages.map((message) => message.body),
    ["Deployed."],
  );
});
