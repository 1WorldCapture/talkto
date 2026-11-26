import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";
import { rpc } from "./mcp-wire.mjs";

/*
  Self-host sign-in with Cloudflare Access (docs/self-host-cloudflare-access.md). The real
  verifier and D1 store run against a fake Access team: every request must carry a token signed
  with the team's keys, for this application, with an email.
*/
const origin = "https://talkto.test";

const harness = async (t, options = {}) => {
  const x = await start(t, { access: true, selfHosted: true, ...options });
  /** One request as Access forwards it, optionally from the person's browser. */
  const send = async (path, init = {}) => {
    const { email = "alice@example.com", token, browser = false, body, ...rest } = init;
    const headers = { "content-type": "application/json", ...rest.headers };
    const credential = token ?? (email === null ? undefined : await x.accessToken(email));
    if (credential !== undefined) headers["cf-access-jwt-assertion"] = credential;
    if (browser) {
      headers.cookie = `CF_Authorization=${credential}`;
      headers.origin = origin;
    }
    return x.raw(path, {
      method: rest.method ?? "GET",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
  };
  const json = async (path, init = {}, status = 200) => {
    const response = await send(path, init);
    const text = await response.text();
    assert.equal(response.status, status, text);
    const parsed = JSON.parse(text);
    return parsed.data ?? parsed;
  };
  /** The person's user ID, as their own sign-in reports it. */
  const userId = async (email) => (await json("/v1/me", { email })).user.id;
  return { ...x, send, json, userId };
};

test("Access mode signs people in only with a valid Access token that carries an email", async (t) => {
  const x = await harness(t);
  const { user: me, connection } = await x.json("/v1/me", { email: "Alice@Example.com" });
  // The dashboard learns that invitations here send no email.
  assert.equal(connection.signIn, "cloudflare-access");
  assert.match(me.id, /^user_[0-9a-f]{32}$/);
  assert.equal(await x.userId("alice@example.com"), me.id, "one person whatever the letter case");
  assert.equal(me.email, "alice@example.com");
  assert.equal(me.emailVerified, true);
  assert.equal(me.firstName, "alice");

  const refused = async (label, token) => {
    const response = await x.send("/v1/me", { token });
    assert.equal(response.status, 401, label);
    return (await response.json()).error.message;
  };
  await refused("no token", "");
  assert.equal((await x.send("/v1/me", { email: null })).status, 401, "no header");
  await refused(
    "another application",
    await x.accessToken("alice@example.com", { audience: ["b".repeat(64)] }),
  );
  await refused(
    "another team",
    await x.accessToken("alice@example.com", { issuer: "https://other.cloudflareaccess.com" }),
  );
  await refused(
    "expired",
    await x.accessToken("alice@example.com", { expiry: Math.floor(Date.now() / 1000) - 60 }),
  );
  await refused(
    "signed with another key",
    await x.accessToken("alice@example.com", { aliasKey: true, kid: "test" }),
  );
  assert.match(
    await refused("a service token", await x.accessToken(null, { subject: "" })),
    /Service tokens cannot sign in/,
  );
  // A WorkOS bearer token means nothing here: only Access's header signs a request in.
  const bearer = await x.raw("/v1/me", {
    headers: { authorization: `Bearer ${await x.token("user_alice")}` },
  });
  assert.equal(bearer.status, 401);
  // Nor does a personal API key: Access checks every request first, so this copy takes no keys.
  const key = await x.raw("/v1/me", { headers: { authorization: `Bearer tk_${"a".repeat(43)}` } });
  assert.equal(key.status, 401);
  // Nor an invited agent's key: it is refused before anything else.
  const invited = await x.raw("/v1/me", {
    headers: { authorization: `Bearer tka_${randomUUID()}.${"a".repeat(43)}` },
  });
  assert.equal(invited.status, 403);
});

test("Access mode is refused outside a self-hosted copy", async (t) => {
  const x = await start(t, { access: true });
  const response = await x.raw("/v1/me", {
    headers: { "cf-access-jwt-assertion": await x.accessToken() },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "identity_unavailable");
});

test("organizations, invitations and server access work without WorkOS", async (t) => {
  const x = await harness(t);
  const alice = "alice@example.com";
  const bob = "bob@example.com";
  const account = await x.json("/v1/accounts", {
    email: alice,
    method: "POST",
    body: { name: "Team", requestKey: randomUUID() },
  });
  assert.match(account.organizationId, /^org_[0-9a-f]{32}$/);
  assert.equal(account.createdBy, await x.userId(alice));
  const server = await x.json(`/v1/accounts/${account.id}/servers`, {
    email: alice,
    method: "POST",
    body: { name: "Development", requestKey: randomUUID() },
  });
  assert.equal((await x.json("/v1/accounts", { email: alice })).items.length, 1);
  // Onboarding reads its settings without any WorkOS variable.
  assert.equal((await x.send("/v1/onboarding", { email: alice })).status, 200);

  // No email is sent: the invitation waits for Bob's first Access sign-in.
  const invitation = await x.json(`/v1/accounts/${account.id}/invitations`, {
    email: alice,
    method: "POST",
    body: { email: "Bob@Example.com" },
  });
  assert.equal(invitation.state, "pending");
  assert.equal(invitation.email, bob);
  const again = await x.json(
    `/v1/accounts/${account.id}/invitations`,
    { email: alice, method: "POST", body: { email: bob } },
    400,
  );
  assert.match(again.error?.message ?? JSON.stringify(again), /already has a pending invitation/);

  // Bob's first sign-in fires several requests at once, as the dashboard does: one membership.
  await Promise.all(Array.from({ length: 6 }, () => x.json("/v1/me", { email: bob })));
  const bobId = await x.userId(bob);
  const invitations = await x.json(`/v1/accounts/${account.id}/invitations`, { email: alice });
  assert.equal(invitations.items[0].state, "accepted");
  const members = await x.json(`/v1/accounts/${account.id}/members`, { email: alice });
  assert.deepEqual(
    members.items.map((item) => item.userId ?? item.user?.id ?? item.id).sort(),
    [await x.userId(alice), bobId].sort(),
    JSON.stringify(members),
  );
  assert.equal((await x.json("/v1/accounts", { email: bob })).items.length, 1);
  await x.scheduled();
  const rows = await x.db
    .prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id=? AND status='active'")
    .bind(bobId)
    .first();
  assert.equal(rows.n, 1, "concurrent sign-ins record one membership");

  // Membership alone grants nothing; the owner's grant gives Bob the server.
  assert.equal((await x.json("/v1/servers", { email: bob })).items.length, 0);
  await x.json(`/v1/servers/${server.id}/access/${bobId}`, { email: alice, method: "PUT" });
  await x.scheduled();
  const found = await x.json("/v1/servers", { email: bob });
  assert.deepEqual(
    found.items.map((item) => item.id),
    [server.id],
  );

  // Removing Bob ends his membership and his server access.
  const removed = await x.send(`/v1/accounts/${account.id}/members/${bobId}`, {
    email: alice,
    method: "DELETE",
  });
  assert.equal(removed.status, 200, await removed.text());
  assert.equal((await x.json("/v1/servers", { email: bob })).items.length, 0);
  assert.equal((await x.json("/v1/accounts", { email: bob })).items.length, 0);
});

test("only a browser with Access's cookie and this site's Origin is a website session", async (t) => {
  const x = await harness(t);
  // A browser request that changes something must come from this site.
  const token = await x.accessToken();
  const forged = await x.raw("/v1/accounts", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": token,
      cookie: `CF_Authorization=${token}`,
      origin: "https://evil.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Team", requestKey: randomUUID() }),
  });
  assert.equal(forged.status, 403, await forged.text());
  // A junk cookie beside a valid token (as a sibling subdomain could plant) is still cross-site.
  const planted = await x.raw("/v1/accounts", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": token,
      cookie: "CF_Authorization=junk",
      origin: "https://evil.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Team", requestKey: randomUUID() }),
  });
  assert.equal(planted.status, 403, await planted.text());
  // Someone else's cookie does not make a request a website session.
  const mixed = await x.raw("/v1/me", {
    headers: {
      "cf-access-jwt-assertion": token,
      cookie: `CF_Authorization=${await x.accessToken("mallory@example.com")}`,
    },
  });
  assert.equal(mixed.status, 200);
  assert.equal((await mixed.json()).data.user.email, "alice@example.com");
});

test("sign-in and sign-out hand over to Access", async (t) => {
  const x = await harness(t);
  const login = await x.send("/auth/login?return_to=/app/servers");
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), `${origin}/app/servers`);
  const unsafe = await x.send("/auth/login?return_to=https://evil.example");
  assert.equal(unsafe.headers.get("location"), `${origin}/app`);
  const logout = await x.send("/auth/logout", { method: "POST", browser: true });
  assert.equal(logout.status, 303);
  assert.equal(
    logout.headers.get("location"),
    `${origin}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(`${origin}/`)}`,
  );
  const crossSite = await x.raw("/auth/logout", {
    method: "POST",
    headers: { origin: "https://evil.example" },
    redirect: "manual",
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await x.send("/auth/callback")).status, 404);
  // The WorkOS device sign-in for the CLI does not exist on a copy without WorkOS.
  assert.equal((await x.send("/auth")).status, 503);
});

test("agents reach /mcp through Access's sign-in, and TalkTo advertises no OAuth server", async (t) => {
  const x = await harness(t);
  const metadata = await x.raw("/.well-known/oauth-protected-resource/mcp");
  assert.equal(metadata.status, 404);
  const unsigned = await x.raw("/mcp", rpc("tools/list"));
  assert.equal(unsigned.status, 401);
  // Access answers agents' sign-in, so TalkTo never points them at an OAuth server of its own.
  assert.doesNotMatch(unsigned.headers.get("www-authenticate") ?? "", /resource_metadata/);
  const request = rpc("tools/call", { name: "get_context", arguments: {} });
  request.headers["cf-access-jwt-assertion"] = await x.accessToken();
  const response = await x.raw("/mcp", request);
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.ok(result.result, JSON.stringify(result));
  assert.equal(result.result.isError ?? false, false, JSON.stringify(result));
});

test("a person whose sign-in record was deleted comes back with a new ID", async (t) => {
  const x = await harness(t);
  const first = await x.userId("carol@example.com");
  await x.db.prepare("DELETE FROM local_users WHERE id=?").bind(first).run();
  // Another isolate would remember Carol for a few minutes; a fresh harness has no such memory.
  const y = await harness(t);
  assert.match(await y.userId("carol@example.com"), /^user_[0-9a-f]{32}$/);
});

test("emails outside ASCII are refused, so lowercasing never merges two people", async (t) => {
  const x = await harness(t);
  const response = await x.send("/v1/me", { email: "\u212Aelvin@example.com" });
  assert.equal(response.status, 401);
});

test("behind Access, joining with an invite code is refused: an invited key cannot work there", async (t) => {
  const x = await start(t, { access: true, selfHosted: true });
  const code = `tki_${randomUUID()}.${"A".repeat(43)}`;
  const redeemed = await x.raw("/v1/agent-invites/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: "outsider", agentType: "script" }),
  });
  assert.equal(redeemed.status, 403);
  assert.match((await redeemed.json()).error.message, /behind Cloudflare Access/);
  const joined = await x.raw("/mcp/join", rpc("tools/list"));
  assert.equal(joined.status, 403);
  assert.equal(joined.headers.get("www-authenticate"), null);
  // An invited agent's key on /mcp is refused the same way, never sent to sign in.
  const key = `tka_${randomUUID()}.${"a".repeat(43)}`;
  const mcp = await x.raw("/mcp", rpc("tools/list", {}, key));
  assert.equal(mcp.status, 403);
  assert.match((await mcp.json()).error.message, /behind Cloudflare Access/);
});
