import { rpc } from "./mcp-wire.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/*
  Signed-in computers: what MCP records about each sign-in, how a sign-out refuses it, and the
  person's own list and sign-out routes.
*/

const claude = "client_01CLAUDECODE";
const cursor = "client_01CURSOR";
const codex = "https://chatgpt.com/codex/client-metadata.json";
const challenge =
  'Bearer resource_metadata="https://talkto.test/.well-known/oauth-protected-resource/mcp", scope="openid offline_access", error="invalid_token"';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, message = "timed out") => {
  for (let i = 0; i < 200; i++) {
    const value = await check();
    if (value) return value;
    await sleep(20);
  }
  assert.fail(message);
};
const rows = async (x, user = "user_alice") =>
  (
    await x.db
      .prepare("SELECT * FROM mcp_client_sessions WHERE user_id=? ORDER BY first_seen_at,sid")
      .bind(user)
      .all()
  ).results;
const clientToken = (x, user, clientId, sid) =>
  x.mcpToken(undefined, user, { claims: { client_id: clientId, sid } });
const discover = (x, token, init = {}) => {
  const request = rpc("server/discover", {}, token);
  Object.assign(request.headers, init.headers ?? {});
  return x.raw("/mcp", { ...request, cf: init.cf });
};
const app = (id, clientId, name) => ({
  id: `authorized_connect_app_${id}`,
  applicationId: `conn_app_${id}`,
  clientId,
  name,
  createdAt: "2026-11-01T12:00:00.000Z",
});
// A new token issued after a sign-out: issue times have one-second resolution.
const nextSecond = () => sleep(1100);

test("MCP tokens record where each app signed in, never the token, at most once per 5 minutes", async (t) => {
  const x = await start(t);
  const token = await clientToken(x, "user_alice", claude, "app_consent_laptop");
  const first = await discover(x, token, {
    headers: { "user-agent": "claude-code/2.1.0 (darwin; arm64)" },
    cf: { city: "San Francisco", country: "US" },
  });
  assert.equal(first.status, 200, await first.text());
  const [row] = await until(async () => {
    const found = await rows(x);
    return found.length === 1 ? found : null;
  });
  assert.equal(row.client_id, claude);
  assert.equal(row.sid, "app_consent_laptop");
  assert.equal(row.agent, "claude-code");
  assert.equal(row.city, "San Francisco");
  assert.equal(row.country, "US");
  assert.equal(row.first_seen_at, row.last_seen_at);
  assert.equal(row.signed_out_at, null);
  for (const value of Object.values(row)) assert.ok(!String(value).includes(token.slice(0, 40)));

  // This isolate remembers the write: another request within 5 minutes writes nothing.
  assert.equal((await discover(x, token)).status, 200);
  await sleep(200);
  assert.equal((await rows(x))[0].last_seen_at, row.last_seen_at);
  // Another isolate (caches cleared) also writes nothing while the row is recent.
  const recent = row.last_seen_at - 60_000;
  await x.db
    .prepare("UPDATE mcp_client_sessions SET last_seen_at=?,first_seen_at=? WHERE id=?")
    .bind(recent, recent, row.id)
    .run();
  await x.control("sign-in-caches");
  assert.equal((await discover(x, token)).status, 200);
  await sleep(200);
  assert.equal((await rows(x))[0].last_seen_at, recent);
  // Five minutes later the next request writes it, keeping the first sign-in time.
  const stale = row.last_seen_at - 6 * 60_000;
  await x.db
    .prepare("UPDATE mcp_client_sessions SET last_seen_at=?,first_seen_at=? WHERE id=?")
    .bind(stale, stale, row.id)
    .run();
  await x.control("sign-in-caches");
  assert.equal((await discover(x, token)).status, 200);
  const [updated] = await until(async () => {
    const found = await rows(x);
    return found[0].last_seen_at > stale ? found : null;
  });
  assert.equal(updated.first_seen_at, stale);
  assert.ok(updated.country, "the latest request’s location is kept");

  // A token without client_id still works and records nothing; one without sid records sid NULL.
  assert.equal((await discover(x, await x.mcpToken())).status, 200);
  assert.equal(
    (await discover(x, await clientToken(x, "user_alice", cursor, undefined))).status,
    200,
  );
  const both = await until(async () => {
    const found = await rows(x);
    return found.length === 2 ? found : null;
  });
  assert.deepEqual(
    both.map((item) => [item.client_id, item.sid]),
    [
      [claude, "app_consent_laptop"],
      [cursor, null],
    ],
  );
  // A malformed client_id is a malformed token.
  const malformed = await discover(
    x,
    await x.mcpToken(undefined, "user_alice", { claims: { client_id: 42 } }),
  );
  assert.equal(malformed.status, 401);
  assert.equal(malformed.headers.get("www-authenticate"), challenge);

  // When D1 cannot be read, MCP keeps working.
  await x.control("sign-in-caches");
  await x.raw("/__control/database-down?value=true", { method: "POST" });
  assert.equal((await discover(x, token)).status, 200);
  await x.raw("/__control/database-down?value=false", { method: "POST" });
});

test("signing out refuses that sign-in at once with invalid_token, keeps the others, and signing in again works", async (t) => {
  const x = await start(t);
  const laptop = await clientToken(x, "user_alice", claude, "app_consent_laptop");
  const editor = await clientToken(x, "user_alice", cursor, "app_consent_editor");
  assert.equal((await discover(x, laptop, { cf: { city: "Lisbon", country: "PT" } })).status, 200);
  assert.equal(
    (await discover(x, editor, { headers: { "user-agent": "Cursor/1.4" } })).status,
    200,
  );
  await until(async () => (await rows(x)).length === 2);
  await x.control("authorized-applications", {
    userId: "user_alice",
    apps: [
      app("01A", claude, "Claude Code"),
      app("01B", cursor, ""),
      app("01C", "client_01NEVERUSED", "Goose"),
    ],
  });

  const listed = await x.call("user_alice", "GET", "/v1/me/sign-ins");
  assert.equal(listed.provider, "ok");
  assert.equal(listed.items.length, 3);
  const [claudeItem, cursorItem] = [claude, cursor].map((id) =>
    listed.items.find((item) => item.clientId === id),
  );
  assert.equal(claudeItem.app, "Claude Code");
  assert.equal(claudeItem.place, "Lisbon, PT");
  assert.equal(claudeItem.shared, false);
  assert.deepEqual(claudeItem.signOut, ["this"]);
  assert.ok(claudeItem.firstSignedInAt && claudeItem.lastActiveAt);
  assert.equal(cursorItem.app, "Cursor", "a nameless WorkOS app is named from its User-Agent");
  assert.equal(cursorItem.agent, "cursor");
  const goose = listed.items.find((item) => item.clientId === "client_01NEVERUSED");
  assert.deepEqual(
    { id: goose.id, app: goose.app, lastActiveAt: goose.lastActiveAt, place: goose.place },
    { id: "authorized_connect_app_01C", app: "Goose", lastActiveAt: null, place: null },
  );
  assert.equal(goose.firstSignedInAt, "2026-11-01T12:00:00.000Z");
  // WorkOS's name is kept for when WorkOS cannot be asked.
  assert.equal((await rows(x)).find((row) => row.client_id === claude).client_name, "Claude Code");

  // A person sees and signs out only their own sign-ins.
  assert.deepEqual((await x.call("user_bob", "GET", "/v1/me/sign-ins")).items, []);
  const refused = await x.call(
    "user_bob",
    "POST",
    `/v1/me/sign-ins/${claudeItem.id}/sign-out`,
    {},
    404,
  );
  assert.equal(refused.error.code, "not_found");
  await x.call("user_bob", "POST", `/v1/me/sign-ins/${goose.id}/sign-out`, {}, 404);
  assert.deepEqual((await x.control("authorized-applications").then((r) => r.json())).revoked, []);

  const signedOut = await x.call(
    "user_alice",
    "POST",
    `/v1/me/sign-ins/${claudeItem.id}/sign-out`,
    {},
  );
  assert.deepEqual(signedOut, { scope: "this", provider: "revoked" });
  const provider = await x.control("authorized-applications").then((r) => r.json());
  assert.deepEqual(provider.revoked, [{ userId: "user_alice", clientId: claude }]);

  const rejected = await discover(x, laptop);
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get("www-authenticate"), challenge);
  const body = await rejected.json();
  assert.equal(body.error.code, "unauthenticated");
  assert.match(body.error.message, /signed out on the Signed-in computers page/);
  assert.equal((await discover(x, editor)).status, 200, "other sign-ins keep working");
  // Another isolate learns of it when its 30-second cache is read again.
  await x.control("sign-in-caches");
  assert.equal((await discover(x, laptop)).status, 401);
  const after = await x.call("user_alice", "GET", "/v1/me/sign-ins");
  assert.deepEqual(after.items.map((item) => item.clientId).sort(), [cursor, "client_01NEVERUSED"]);

  // Signing in again from that computer issues new tokens, which work and list it again.
  await nextSecond();
  const again = await clientToken(x, "user_alice", claude, "app_consent_laptop");
  assert.equal((await discover(x, again)).status, 200);
  await until(async () => {
    const row = (await rows(x)).find((item) => item.client_id === claude);
    return row.signed_out_at === null;
  }, "the sign-in is listed again");
  assert.equal((await discover(x, laptop)).status, 401, "the old token stays refused");

  // A sign-in only WorkOS knows is signed out at WorkOS by its client.
  assert.deepEqual(
    await x.call("user_alice", "POST", `/v1/me/sign-ins/${goose.id}/sign-out`, { scope: "this" }),
    { scope: "this", provider: "revoked" },
  );
  assert.deepEqual(
    (await x.control("authorized-applications").then((r) => r.json())).revoked.at(-1),
    { userId: "user_alice", clientId: "client_01NEVERUSED" },
  );
  // Unknown fields are refused.
  await x.call("user_alice", "POST", `/v1/me/sign-ins/${goose.id}/sign-out`, { all: true }, 400);
});

test("one copy of a shared (CIMD) app signs out by its sid; every copy needs the explicit choice", async (t) => {
  const x = await start(t);
  const laptop = await clientToken(x, "user_alice", codex, "app_consent_codex_laptop");
  const desktop = await clientToken(x, "user_alice", codex, "app_consent_codex_desktop");
  const anonymous = await clientToken(x, "user_alice", codex, undefined);
  for (const token of [laptop, desktop, anonymous])
    assert.equal((await discover(x, token)).status, 200);
  await until(async () => (await rows(x)).length === 3);
  await x.control("authorized-applications", {
    userId: "user_alice",
    apps: [app("01X", codex, "Codex")],
  });
  const listed = await x.call("user_alice", "GET", "/v1/me/sign-ins");
  assert.equal(listed.items.length, 3);
  const bySid = Object.fromEntries(
    (await rows(x)).map((row) => [row.sid ?? "none", listed.items.find((i) => i.id === row.id)]),
  );
  assert.ok(Object.values(bySid).every((item) => item.app === "Codex" && item.shared));
  assert.deepEqual(bySid.app_consent_codex_laptop.signOut, ["this", "app"]);
  assert.deepEqual(bySid.none.signOut, ["app"]);

  // This copy only: TalkTo refuses its sid; WorkOS is not asked, so the other copies keep working.
  assert.deepEqual(
    await x.call(
      "user_alice",
      "POST",
      `/v1/me/sign-ins/${bySid.app_consent_codex_laptop.id}/sign-out`,
      { scope: "this" },
    ),
    { scope: "this", provider: "skipped" },
  );
  assert.deepEqual((await x.control("authorized-applications").then((r) => r.json())).revoked, []);
  assert.equal((await discover(x, laptop)).status, 401);
  assert.equal((await discover(x, desktop)).status, 200);
  // A refreshed token of the same sign-in (same sid, newer issue time) stays refused.
  await nextSecond();
  assert.equal(
    (await discover(x, await clientToken(x, "user_alice", codex, "app_consent_codex_laptop")))
      .status,
    401,
  );
  // A copy without a sid cannot be told apart from the others.
  const ambiguous = await x.call(
    "user_alice",
    "POST",
    `/v1/me/sign-ins/${bySid.none.id}/sign-out`,
    { scope: "this" },
    400,
  );
  assert.equal(ambiguous.error.code, "invalid_input");
  assert.equal((await discover(x, anonymous)).status, 200);

  // Every copy: WorkOS ends the app's authorization and TalkTo refuses every earlier token.
  assert.deepEqual(
    await x.call(
      "user_alice",
      "POST",
      `/v1/me/sign-ins/${bySid.app_consent_codex_desktop.id}/sign-out`,
      { scope: "app" },
    ),
    { scope: "app", provider: "revoked" },
  );
  assert.deepEqual((await x.control("authorized-applications").then((r) => r.json())).revoked, [
    { userId: "user_alice", clientId: codex },
  ]);
  assert.equal((await discover(x, desktop)).status, 401);
  assert.equal((await discover(x, anonymous)).status, 401);
  assert.deepEqual((await x.call("user_alice", "GET", "/v1/me/sign-ins")).items, []);
  // After signing in again, even the earlier per-copy sign-out no longer applies.
  await nextSecond();
  assert.equal(
    (await discover(x, await clientToken(x, "user_alice", codex, "app_consent_codex_laptop")))
      .status,
    200,
  );
});

test("a WorkOS failure keeps the sign-in listed and refused until sign-out is repeated; the list works without WorkOS", async (t) => {
  const x = await start(t);
  const token = await clientToken(x, "user_alice", claude, "app_consent_laptop");
  assert.equal(
    (await discover(x, token, { headers: { "user-agent": "claude-code/2.1.0" } })).status,
    200,
  );
  await until(async () => (await rows(x)).length === 1);
  await x.control("authorized-applications", {
    userId: "user_alice",
    apps: [app("01A", claude, "Claude Code (TalkTo)")],
  });
  const [item] = (await x.call("user_alice", "GET", "/v1/me/sign-ins")).items;
  assert.equal(item.app, "Claude Code (TalkTo)");

  await x.control("authorized-applications", { faults: { list: 1 } });
  const offline = await x.call("user_alice", "GET", "/v1/me/sign-ins");
  assert.equal(offline.provider, "unavailable");
  assert.deepEqual(
    offline.items.map((entry) => [entry.id, entry.app]),
    [[item.id, "Claude Code (TalkTo)"]],
  );

  await x.control("authorized-applications", { faults: { revoke: 1 } });
  const failed = await x.call("user_alice", "POST", `/v1/me/sign-ins/${item.id}/sign-out`, {}, 503);
  assert.equal(failed.error.code, "identity_unavailable");
  assert.match(failed.error.message, /Try again/);
  assert.equal((await discover(x, token)).status, 401, "the revocation was written first");
  assert.equal((await x.call("user_alice", "GET", "/v1/me/sign-ins")).items.length, 1);
  assert.deepEqual(await x.call("user_alice", "POST", `/v1/me/sign-ins/${item.id}/sign-out`, {}), {
    scope: "this",
    provider: "revoked",
  });
  assert.deepEqual((await x.call("user_alice", "GET", "/v1/me/sign-ins")).items, []);
});

test("the WorkOS adapter lists authorized applications and revokes by client ID, or by application ID for a shared client", async (t) => {
  const requests = [];
  const x = await start(t, {
    realIdentity: true,
    providerHandler: async (request) => {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      if (request.method === "GET")
        return Response.json({
          object: "list",
          data: [
            {
              object: "authorized_connect_application",
              id: "authorized_connect_app_01DCR",
              granted_scopes: ["openid", "offline_access"],
              application: {
                object: "connect_application",
                id: "conn_app_01DCR",
                client_id: claude,
                name: "Claude Code",
                created_at: "2026-10-01T00:00:00.000Z",
              },
            },
            {
              object: "authorized_connect_application",
              id: "authorized_connect_app_01CIMD",
              created_at: "2026-11-02T08:00:00.000Z",
              application: {
                object: "connect_application",
                id: "conn_app_01CIMD",
                client_id: codex,
                name: "Codex",
              },
            },
            { object: "authorized_connect_application", id: "unreadable", application: {} },
          ],
          list_metadata: { before: null, after: null },
        });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    },
  });
  const listed = await x.call("user_alice", "GET", "/v1/me/sign-ins");
  assert.equal(listed.provider, "ok");
  assert.deepEqual(
    listed.items.map((item) => [
      item.id,
      item.app,
      item.shared,
      item.firstSignedInAt,
      item.signOut,
    ]),
    [
      ["authorized_connect_app_01DCR", "Claude Code", false, null, ["this"]],
      ["authorized_connect_app_01CIMD", "Codex", true, "2026-11-02T08:00:00.000Z", ["app"]],
    ],
  );
  assert.deepEqual(requests, [
    "GET /user_management/users/user_alice/authorized_applications?limit=100",
  ]);
  requests.length = 0;
  await x.call("user_alice", "POST", "/v1/me/sign-ins/authorized_connect_app_01DCR/sign-out", {});
  assert.deepEqual(requests, [
    "GET /user_management/users/user_alice/authorized_applications?limit=100",
    `DELETE /user_management/users/user_alice/authorized_applications/${claude}`,
  ]);
  requests.length = 0;
  await x.call("user_alice", "POST", "/v1/me/sign-ins/authorized_connect_app_01CIMD/sign-out", {
    scope: "app",
  });
  assert.deepEqual(requests, [
    "GET /user_management/users/user_alice/authorized_applications?limit=100",
    "GET /user_management/users/user_alice/authorized_applications?limit=100",
    "DELETE /user_management/users/user_alice/authorized_applications/conn_app_01CIMD",
  ]);
});

test("the minute cron deletes sign-ins unseen for 90 days and expired revocations", async (t) => {
  const x = await start(t);
  const now = Date.now();
  const day = 86_400_000;
  const insert = (id, lastSeen) =>
    x.db
      .prepare(
        "INSERT INTO mcp_client_sessions(id,user_id,client_id,sid,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(id, "user_alice", claude, id, lastSeen - day, lastSeen)
      .run();
  await insert("old", now - 91 * day);
  await insert("recent", now - 89 * day);
  const revoke = (sid, expiresAt) =>
    x.db
      .prepare(
        "INSERT INTO mcp_revocations(user_id,client_id,sid,revoked_at,expires_at) VALUES(?,?,?,?,?)",
      )
      .bind("user_alice", claude, sid, now - 2 * day, expiresAt)
      .run();
  await revoke("expired", now - day);
  await revoke("current", now + day);
  await x.control("sync");
  assert.deepEqual(
    (await rows(x)).map((row) => row.id),
    ["recent"],
  );
  assert.deepEqual(
    (await x.db.prepare("SELECT sid FROM mcp_revocations").all()).results.map((row) => row.sid),
    ["current"],
  );
});
