import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decodeJwt, generateKeyPair, SignJWT } from "jose";
import { start } from "./platform-harness.mjs";
import { rpc } from "./mcp-wire.mjs";

/*
  Self-host sign-in with Better Auth (docs/self-host-better-auth.md). The real Better Auth, its
  OAuth provider and the D1 store run in the Worker: people sign in on TalkTo's own pages, and an
  MCP client registers, authorizes, exchanges a code and calls /mcp exactly as Claude Code does.
*/
const origin = "https://talkto.test";
const password = "correct horse battery staple";
const redirectUri = "http://127.0.0.1:51234/callback";
/** What a browser sends when it opens a page. */
const navigation = { accept: "text/html" };
/**
 * Where Better Auth's authorize endpoint sends the browser. A browser's navigation gets a 302; the
 * test's fetch always says `sec-fetch-mode: cors`, so Better Auth answers the same URL as JSON.
 */
const destination = async (response) => {
  if (response.status === 302) return new URL(response.headers.get("location"), origin);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.redirect, true, text);
  return new URL(body.url, origin);
};

/** `pnpm selfhost:link`, as an owner runs it: the account link's path and query. */
const linkTool = fileURLToPath(new URL("../tools/better-auth-link.mjs", import.meta.url));
const accountLink = (secret, email, hours) => {
  // Without --hours, as the guide runs it; with it, as an owner choosing a lifetime.
  const args = hours === undefined ? [email] : [email, "--hours", String(hours)];
  const printed = execFileSync(process.execPath, [linkTool, ...args], {
    env: { PATH: process.env.PATH, TALKTO_SERVICE_ORIGIN: origin, BETTER_AUTH_SECRET: secret },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const url = new URL(printed);
  assert.equal(url.origin, origin);
  return url.searchParams.get("claim");
};
/** An account link's code made by hand, for expiries the tool refuses to make. */
const mintedLink = (secret, email, expiry) => {
  const nonce = randomBytes(16).toString("hex");
  const mac = createHmac("sha256", secret)
    .update(`talkto better-auth account link v1\n${email}\n${expiry}\n${nonce}`)
    .digest("base64url");
  return `${Buffer.from(email).toString("base64url")}.${expiry}.${nonce}.${mac}`;
};

const harness = async (t, options = {}) => {
  const x = await start(t, { betterAuth: true, selfHosted: true, ...options });
  const link = (email, hours) => accountLink(x.betterAuthSecret, email, hours);
  /** A browser form post from this site. */
  const post = (path, fields, cookie, extra = {}) => {
    // Each post comes from its own network, so Better Auth's per-network limits stay out of the
    // way; a test of the limits names one network itself.
    const headers = {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      "cf-connecting-ip": `10.${randomBytes(3).join(".")}`,
    };
    if (cookie !== undefined) headers.cookie = cookie;
    return x.raw(path, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });
  };
  const cookieOf = (response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .filter((value) => value.startsWith("__Host-talkto.session_token=") && !value.endsWith("="))
      .join("; ");
  /** Create an account on the sign-up page; answers the session cookie. */
  const signUp = async (email, fields = {}) => {
    const response = await post("/auth/sign-up", {
      name: "Alice Example",
      email,
      password,
      return_to: "/app",
      ...fields,
    });
    assert.equal(response.status, 303, await response.text());
    const cookie = cookieOf(response);
    assert.ok(cookie, "the account is signed in");
    return cookie;
  };
  /** The first owner: an account link from the secret, then the sign-up form. */
  const owner = (email = "owner@example.com") => signUp(email, { claim: link(email) });
  const signIn = async (email, secret = password) => {
    const response = await post("/auth/sign-in", { email, password: secret, return_to: "/app" });
    return { response, cookie: cookieOf(response) };
  };
  const json = async (path, cookie, init = {}, status = 200) => {
    const headers = { "content-type": "application/json" };
    if (cookie !== undefined) headers.cookie = cookie;
    if (init.method !== undefined && init.method !== "GET") headers.origin = origin;
    const response = await x.raw(path, {
      method: init.method ?? "GET",
      headers: { ...headers, ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    assert.equal(response.status, status, text);
    const parsed = JSON.parse(text);
    return parsed.data ?? parsed;
  };
  /** An MCP client: registers itself, then signs a person in through the browser. */
  const register = async (name = "Claude Code") => {
    const response = await x.raw("/auth/api/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: ["http://127.0.0.1/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 201, text);
    return JSON.parse(text).client_id;
  };
  const authorize = (clientId, extra = {}) => {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: "state-1",
      scope: "openid offline_access",
      resource: `${origin}/mcp`,
      ...extra,
    });
    return { verifier, path: `/auth/api/oauth2/authorize?${query}` };
  };
  const exchange = async (clientId, code, verifier, extra = {}) => {
    const response = await x.raw("/auth/api/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${origin}/mcp`,
        ...extra,
      }).toString(),
    });
    return { status: response.status, body: await response.json() };
  };
  /** The whole browser part of an agent's sign-in, for a person with an account. */
  const agentSignIn = async (clientId, email = "owner@example.com") => {
    const flow = authorize(clientId);
    const started = await x.raw(flow.path, { headers: navigation, redirect: "manual" });
    const login = await destination(started);
    assert.equal(login.pathname, "/auth/sign-in");
    const page = await x.raw(`${login.pathname}${login.search}`);
    const html = await page.text();
    assert.equal(page.status, 200, html);
    assert.match(html, /An agent app asked to sign in as you/);
    const oauthQuery = /name="oauth_query" value="([^"]+)"/
      .exec(html)[1]
      .replaceAll("&amp;", "&")
      .replaceAll("&#39;", "'")
      .replaceAll("&quot;", '"');
    const signedIn = await post("/auth/sign-in", { email, password, oauth_query: oauthQuery });
    assert.equal(signedIn.status, 303, await signedIn.text());
    const cookie = cookieOf(signedIn);
    let next = new URL(signedIn.headers.get("location"), origin);
    if (next.pathname === "/auth/consent") {
      const consent = await x.raw(`${next.pathname}${next.search}`, { headers: { cookie } });
      const text = await consent.text();
      assert.equal(consent.status, 200, text);
      const query = /name="oauth_query" value="([^"]+)"/.exec(text)[1].replaceAll("&amp;", "&");
      const allowed = await post("/auth/consent", { accept: "yes", oauth_query: query }, cookie);
      assert.equal(allowed.status, 303, await allowed.text());
      next = new URL(allowed.headers.get("location"));
    }
    assert.equal(`${next.origin}${next.pathname}`, redirectUri);
    assert.equal(next.searchParams.get("state"), "state-1");
    assert.equal(next.searchParams.get("iss"), origin);
    const tokens = await exchange(clientId, next.searchParams.get("code"), flow.verifier);
    assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
    return { ...tokens.body, cookie };
  };
  const mcpCall = (token, name = "get_context", args = {}) =>
    x.raw("/mcp", rpc("tools/call", { name, arguments: args }, token));
  return {
    ...x,
    post,
    link,
    owner,
    signUp,
    signIn,
    json,
    register,
    authorize,
    exchange,
    agentSignIn,
    mcpCall,
    cookieOf,
  };
};

test("the owner creates an account, signs in and out, and the dashboard knows Better Auth", async (t) => {
  const x = await harness(t);
  // Nobody can sign up without a link: not a stranger, and not an owner's address either, since
  // an address proves nothing by itself here.
  for (const email of ["mallory@example.com", "owner@example.com"]) {
    const refused = await x.post("/auth/sign-up", { name: "Mallory", email, password });
    assert.equal(refused.status, 403, email);
    assert.match(await refused.text(), /could not be created/);
  }
  // The owner's account link opens the form with the address filled in.
  const code = x.link("owner@example.com");
  const form = await (await x.raw(`/auth/sign-in?${new URLSearchParams({ claim: code })}`)).text();
  assert.match(form, /Create your TalkTo account/);
  assert.match(form, /name="email" type="email"[^>]*value="owner@example.com"/);
  const created = await x.post("/auth/sign-up", {
    name: "Alice Example",
    email: "Owner@Example.com",
    password,
    claim: code,
    return_to: "/app",
  });
  assert.equal(created.status, 303, await created.text());
  const cookie = x.cookieOf(created);
  // The session cookie is a __Host- cookie: Secure, this host only, every path.
  const set = created.headers.getSetCookie().find((value) => value.startsWith("__Host-talkto."));
  assert.match(set, /^__Host-talkto\.session_token=[^;]+;/);
  assert.match(set, /; Path=\/(;|$)/);
  assert.match(set, /; Secure/i);
  assert.match(set, /; HttpOnly/i);
  assert.doesNotMatch(set, /Domain=/i);
  const { user, connection } = await x.json("/v1/me", cookie);
  assert.equal(connection.signIn, "better-auth");
  assert.match(user.id, /^user_[0-9a-f]{32}$/);
  assert.equal(user.email, "owner@example.com");
  assert.equal(user.emailVerified, true);
  assert.equal(user.firstName, "Alice Example");
  // Better Auth's user is the same person as TalkTo's.
  const row = await x.db.prepare("SELECT id FROM ba_user WHERE email=?").bind(user.email).first();
  assert.equal(row.id, user.id);
  // A second account for the same address is refused with the very answer a stranger gets, so
  // the page tells no one which addresses have accounts. The used link does not work again.
  const twice = await x.post("/auth/sign-up", {
    name: "Again",
    email: "owner@example.com",
    password,
    claim: code,
  });
  assert.equal(twice.status, 403);
  assert.match(await twice.text(), /could not be created/);

  const wrong = await x.signIn("owner@example.com", "not the password");
  assert.equal(wrong.response.status, 401);
  assert.match(await wrong.response.text(), /email or password is wrong/);
  const again = await x.signIn("owner@example.com");
  assert.equal(again.response.status, 303);
  assert.equal(again.response.headers.get("location"), `${origin}/app`);
  assert.equal((await x.json("/v1/me", again.cookie)).user.id, user.id);

  // /auth/login sends a signed-in person straight back, and others to the sign-in page.
  const login = await x.raw("/auth/login?return_to=/app/servers", {
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(login.headers.get("location"), `${origin}/app/servers`);
  const anonymous = await x.raw("/auth/login?return_to=https://evil.example", {
    redirect: "manual",
  });
  assert.equal(anonymous.headers.get("location"), `${origin}/auth/sign-in?return_to=%2Fapp`);
  const page = await x.raw("/auth/sign-in");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);

  // Signing out ends the session itself, not only the cookie.
  const out = await x.post("/auth/logout", {}, cookie);
  assert.equal(out.status, 303);
  assert.equal(out.headers.get("location"), `${origin}/`);
  assert.ok(out.headers.getSetCookie().some((value) => /session_token=;/.test(value)));
  await x.json("/v1/me", cookie, {}, 401);
  assert.equal((await x.json("/v1/me", again.cookie)).user.id, user.id, "other sessions stay");
  // Signing out from another site is refused.
  const forged = await x.raw("/auth/logout", {
    method: "POST",
    headers: { origin: "https://evil.example", cookie: again.cookie },
    redirect: "manual",
  });
  assert.equal(forged.status, 403);
});

test("only this site's browser session signs a request in", async (t) => {
  const x = await harness(t);
  const cookie = await x.owner();
  // A change from another site is refused even with the cookie.
  const crossSite = await x.raw("/v1/accounts", {
    method: "POST",
    headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
    body: JSON.stringify({ name: "Team", requestKey: randomUUID() }),
  });
  assert.equal(crossSite.status, 403, await crossSite.text());
  // No cookie, a junk cookie, or a WorkOS-style bearer token: none signs in.
  await x.json("/v1/me", undefined, {}, 401);
  await x.json("/v1/me", "__Host-talkto.session_token=junk", {}, 401);
  const bearer = await x.raw("/v1/me", {
    headers: { authorization: `Bearer ${await x.token("user_alice")}` },
  });
  assert.equal(bearer.status, 401);
  // Better Auth's other endpoints are not reachable from outside; its pages are the only door.
  for (const path of [
    "/auth/api/sign-up/email",
    "/auth/api/sign-in/email",
    "/auth/api/get-session",
  ])
    assert.equal((await x.raw(path, { method: "POST" })).status, 404, path);
  assert.equal((await x.raw("/auth/api/token")).status, 404);
  assert.equal((await x.raw("/auth/callback")).status, 404);
  // The WorkOS device sign-in for the CLI does not exist here.
  assert.equal((await x.raw("/auth")).status, 503);
});

test("invitations: an invited person creates an account with the invitation's code", async (t) => {
  const x = await harness(t);
  const owner = await x.owner();
  const account = await x.json("/v1/accounts", owner, {
    method: "POST",
    body: { name: "Team", requestKey: randomUUID() },
  });
  const server = await x.json(`/v1/accounts/${account.id}/servers`, owner, {
    method: "POST",
    body: { name: "Development", requestKey: randomUUID() },
  });
  const invitation = await x.json(`/v1/accounts/${account.id}/invitations`, owner, {
    method: "POST",
    body: { email: "Bob@Example.com" },
  });
  assert.equal(invitation.state, "pending");

  // The sign-in page opens on account creation with the code filled in.
  const page = await (await x.raw(`/auth/sign-in?invitation=${invitation.id}`)).text();
  assert.match(page, new RegExp(`name="invitation" value="${invitation.id}"`));
  // Without the code, with another code, or with the code for another address: refused.
  for (const fields of [
    { email: "bob@example.com" },
    { email: "bob@example.com", invitation: "invitation_0000000000000000" },
    { email: "carol@example.com", invitation: invitation.id },
  ]) {
    const refused = await x.post("/auth/sign-up", { name: "Bob", password, ...fields });
    assert.equal(refused.status, 403, JSON.stringify(fields));
  }
  const bob = await x.signUp("bob@example.com", { name: "Bob", invitation: invitation.id });
  const bobId = (await x.json("/v1/me", bob)).user.id;
  const invitations = await x.json(`/v1/accounts/${account.id}/invitations`, owner);
  assert.equal(invitations.items[0].state, "accepted");
  assert.equal((await x.json("/v1/accounts", bob)).items.length, 1);
  // A sixth account attempt within a minute from one network is refused before anything else.
  const network = { "cf-connecting-ip": "192.0.2.7" };
  const attempt = () =>
    x.post(
      "/auth/sign-up",
      { name: "Eve", email: "eve@example.com", password },
      undefined,
      network,
    );
  for (let n = 0; n < 5; n++) assert.equal((await attempt()).status, 403);
  const flood = await attempt();
  assert.equal(flood.status, 429);
  assert.match(await flood.text(), /Too many attempts/);

  // Server access still comes only from the owner's grant.
  await x.scheduled();
  assert.equal((await x.json("/v1/servers", bob)).items.length, 0);
  await x.json(`/v1/servers/${server.id}/access/${bobId}`, owner, { method: "PUT" });
  await x.scheduled();
  assert.deepEqual(
    (await x.json("/v1/servers", bob)).items.map((item) => item.id),
    [server.id],
  );
});

test("an MCP client registers, signs a person in, gets a token and calls /mcp", async (t) => {
  const x = await harness(t);
  await x.owner();

  // Discovery, as an MCP client does it from a bare 401.
  const unsigned = await x.raw("/mcp", rpc("tools/list"));
  assert.equal(unsigned.status, 401);
  assert.match(
    unsigned.headers.get("www-authenticate"),
    /resource_metadata="https:\/\/talkto\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
  const resource = await (await x.raw("/.well-known/oauth-protected-resource/mcp")).json();
  assert.deepEqual(resource.authorization_servers, [origin]);
  assert.equal(resource.resource, `${origin}/mcp`);
  const metadata = await (await x.raw("/.well-known/oauth-authorization-server")).json();
  assert.equal(metadata.issuer, origin);
  assert.equal(metadata.authorization_endpoint, `${origin}/auth/api/oauth2/authorize`);
  assert.equal(metadata.token_endpoint, `${origin}/auth/api/oauth2/token`);
  assert.equal(metadata.registration_endpoint, `${origin}/auth/api/oauth2/register`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.ok(!metadata.grant_types_supported.includes("client_credentials"));
  assert.equal((await x.raw("/.well-known/openid-configuration")).status, 200);

  const clientId = await x.register("Claude Code");
  const tokens = await x.agentSignIn(clientId);
  const claims = decodeJwt(tokens.access_token);
  const me = await x.json("/v1/me", tokens.cookie);
  assert.equal(claims.sub, me.user.id);
  assert.equal(claims.iss, origin);
  assert.ok([claims.aud].flat().includes(`${origin}/mcp`));
  assert.equal(claims.client_id, clientId);
  assert.equal(tokens.expires_in, 3600);
  assert.ok(tokens.refresh_token);

  const called = await x.mcpCall(tokens.access_token);
  const result = await called.json();
  assert.equal(called.status, 200, JSON.stringify(result));
  assert.equal(result.result.isError ?? false, false, JSON.stringify(result));
  // The connection proves the person, never an agent: get_context lists servers, nothing more.
  assert.equal(result.result.structuredContent.data.kind, "servers");

  // A second sign-in by the same app skips consent: the person already allowed it.
  const again = await x.agentSignIn(clientId);
  assert.equal((await x.mcpCall(again.access_token)).status, 200);

  // A refresh gives a new access token that also works.
  const refreshed = await x.raw("/auth/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: `${origin}/mcp`,
    }).toString(),
  });
  const renewed = await refreshed.json();
  assert.equal(refreshed.status, 200, JSON.stringify(renewed));
  assert.equal((await x.mcpCall(renewed.access_token)).status, 200);

  // A wrong PKCE verifier or a reused code gets no token.
  const flow = x.authorize(clientId);
  const started = await x.raw(flow.path, {
    headers: { cookie: tokens.cookie, ...navigation },
    redirect: "manual",
  });
  const code = (await destination(started)).searchParams.get("code");
  assert.equal((await x.exchange(clientId, code, "wrong-verifier".repeat(4))).status, 400);
  assert.equal((await x.exchange(clientId, code, flow.verifier)).status, 200);
  assert.equal(
    (await x.exchange(clientId, code, flow.verifier)).status,
    400,
    "codes are single-use",
  );
});

test("/mcp refuses tokens that are not this copy's, for /mcp, and current", async (t) => {
  const x = await harness(t);
  await x.owner();
  const clientId = await x.register();
  const { access_token: token, cookie } = await x.agentSignIn(clientId);
  const refused = async (label, credential) => {
    const response = await x.mcpCall(credential);
    assert.equal(response.status, 401, label);
    assert.match(response.headers.get("www-authenticate"), /error="invalid_token"/, label);
  };
  await refused("tampered", `${token.slice(0, -4)}AAAA`);
  // Signed by someone else with the same claims.
  const { privateKey } = await generateKeyPair("RS256");
  const claims = decodeJwt(token);
  const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
  await refused(
    "another key",
    await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: header.kid })
      .sign(privateKey),
  );
  // A token issued without the `resource` parameter is opaque and not for /mcp.
  const flow = x.authorize(clientId);
  const started = await x.raw(flow.path.replace(/&resource=[^&]*/, ""), {
    headers: { cookie, ...navigation },
    redirect: "manual",
  });
  const code = (await destination(started)).searchParams.get("code");
  const other = await x.exchange(clientId, code, flow.verifier, { resource: "" });
  if (other.status === 200) await refused("no resource", other.body.access_token);
  // A WorkOS-style token for the same resource from another issuer.
  await refused(
    "another issuer",
    await x.mcpToken("org_test", claims.sub, { claims: { aud: `${origin}/mcp` } }),
  );
  await refused("garbage", "not-a-token");
});

test("signing an agent app out on Signed-in computers ends its tokens", async (t) => {
  const x = await harness(t);
  const owner = await x.owner();
  const clientId = await x.register("Codex");
  const tokens = await x.agentSignIn(clientId);
  assert.equal((await x.mcpCall(tokens.access_token)).status, 200);

  const listed = await x.json("/v1/me/sign-ins", owner);
  assert.equal(listed.provider, "ok");
  const signIn = listed.items.find((item) => item.clientId === clientId);
  assert.ok(signIn, JSON.stringify(listed));
  assert.equal(signIn.app, "Codex");
  const out = await x.json(`/v1/me/sign-ins/${signIn.id}/sign-out`, owner, {
    method: "POST",
    body: { scope: "this" },
  });
  assert.equal(out.provider, "revoked");
  // The access token is refused, and its refresh token gets no new one.
  const refused = await x.mcpCall(tokens.access_token);
  assert.equal(refused.status, 401);
  const refresh = await x.raw("/auth/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    }).toString(),
  });
  assert.equal(refresh.status, 400);
  const left = await x.db
    .prepare("SELECT COUNT(*) AS n FROM ba_oauth_consent WHERE clientId=?")
    .bind(clientId)
    .first();
  assert.equal(left.n, 0, "the app must ask for consent again");
  // Signing in again works, after the person allows the app again.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const back = await x.agentSignIn(clientId);
  assert.equal((await x.mcpCall(back.access_token)).status, 200);
});

test("deleting an account deletes its Better Auth records too", async (t) => {
  const x = await harness(t);
  const owner = await x.owner();
  const id = (await x.json("/v1/me", owner)).user.id;
  const clientId = await x.register();
  await x.agentSignIn(clientId);
  const deleted = await x.json("/v1/me/delete", owner, {
    method: "POST",
    body: { confirmation: "owner@example.com" },
  });
  assert.equal(deleted.status, "deleted");
  await x.json("/v1/me", owner, {}, 401);
  for (const table of [
    "ba_user",
    "ba_session",
    "ba_account",
    "ba_oauth_consent",
    "ba_oauth_refresh_token",
  ]) {
    const column = table === "ba_user" ? "id" : "userId";
    const row = await x.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`)
      .bind(id)
      .first();
    assert.equal(row.n, 0, table);
  }
});

test("API keys: the website session makes one, and it acts as that person on /v1 but not /mcp", async (t) => {
  const x = await harness(t, { board: true });
  const owner = await x.owner();
  const id = (await x.json("/v1/me", owner)).user.id;
  const made = await x.json("/v1/me/api-keys", owner, {
    method: "POST",
    body: { name: "CI", access: "full" },
  });
  assert.match(made.secret, /^tk_[A-Za-z0-9_-]{43}$/);
  const withKey = (path, init = {}) =>
    x.raw(path, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${made.secret}`, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const me = await withKey("/v1/me");
  const text = await me.text();
  assert.equal(me.status, 200, text);
  assert.equal(JSON.parse(text).data.user.id, id);
  // The key acts as the person: an organization and a swarm server it makes are theirs.
  const account = await withKey("/v1/accounts", {
    method: "POST",
    body: { name: "Team", requestKey: randomUUID() },
  });
  assert.equal(account.status, 200);
  const accountId = (await account.json()).data.id;
  const server = await withKey(`/v1/accounts/${accountId}/servers`, {
    method: "POST",
    body: { name: "Swarm", requestKey: randomUUID(), board: true },
  });
  assert.equal(server.status, 200);
  const serverId = (await server.json()).data.id;
  assert.equal((await x.json("/v1/accounts", owner)).items.length, 1);
  assert.equal((await withKey(`/v1/servers/${serverId}/board`)).status, 200);
  // Only the website makes keys, and keys never work on /mcp.
  const again = await withKey("/v1/me/api-keys", {
    method: "POST",
    body: { name: "Again", access: "full" },
  });
  assert.equal(again.status, 403);
  assert.equal((await again.json()).error.code, "forbidden");
  assert.equal((await x.raw("/mcp", rpc("server/discover", {}, made.secret))).status, 401);
  // A revoked key stops at once on this isolate.
  await x.json(`/v1/me/api-keys/${made.key.id}`, owner, { method: "DELETE" });
  assert.equal((await withKey("/v1/me")).status, 401);
});

test("agent invites: the website session invites and approves, and the invited agent's key works", async (t) => {
  const x = await harness(t);
  const owner = await x.owner();
  const account = await x.json("/v1/accounts", owner, {
    method: "POST",
    body: { name: "Team", requestKey: randomUUID() },
  });
  const server = await x.json(`/v1/accounts/${account.id}/servers`, owner, {
    method: "POST",
    body: { name: "Builds", requestKey: randomUUID() },
  });
  const root = `/v1/servers/${server.id}`;
  const deployer = await x.json(`${root}/participants`, owner, {
    method: "POST",
    body: { name: "deployer", agentType: "script", requestKey: randomUUID() },
  });
  const invite = await x.json(`${root}/agent-invites`, owner, {
    method: "POST",
    body: { participantId: deployer.item.id, requestKey: randomUUID() },
  });
  assert.match(invite.code, /^tki_/);
  // Redeeming and checking need no sign-in.
  const redeem = await x.raw("/v1/agent-invites/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: invite.code, name: "reviewer", agentType: "claude-code" }),
  });
  const waiting = (await redeem.json()).data;
  assert.equal(waiting.status, "waiting");
  const check = async () =>
    (
      await (
        await x.raw(`/v1/agent-invites/requests/${waiting.requestId}?wait=0`, {
          headers: { "x-talkto-pickup": waiting.pickup },
        })
      ).json()
    ).data;
  // The website session is a person, so it may approve.
  const approved = await x.json(
    `${root}/agent-invites/requests/${waiting.requestId}/approve`,
    owner,
    {
      method: "POST",
    },
  );
  assert.equal(approved.decision, "approved");
  const joined = await check();
  assert.equal(joined.status, "joined");
  assert.match(joined.key, new RegExp(`^tka_${server.id}\\.`));
  const asInvited = (path, init = {}) =>
    x.raw(path, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${joined.key}`, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const participants = await asInvited(`${root}/participants`);
  assert.equal(participants.status, 200);
  const listed = (await participants.json()).data.items.find(
    (item) => item.id === joined.participantId,
  );
  assert.equal(listed.invite.invitedBy.name, "deployer");
  const sent = await asInvited(`${root}/conversations/${deployer.generalConversationId}/messages`, {
    method: "POST",
    body: { participantId: joined.participantId, body: "Reviewing.", requestKey: randomUUID() },
  });
  assert.equal(sent.status, 200, await sent.text());
  // The invited agent is never a person: it cannot approve or act on the person's routes.
  assert.equal((await asInvited("/v1/me")).status, 403);
});

test("agent invites over MCP: an agent joins at /mcp/join and works on /mcp with its key", async (t) => {
  const x = await harness(t);
  const owner = await x.owner();
  const account = await x.json("/v1/accounts", owner, {
    method: "POST",
    body: { name: "Team", requestKey: randomUUID() },
  });
  const server = await x.json(`/v1/accounts/${account.id}/servers`, owner, {
    method: "POST",
    body: { name: "Builds", requestKey: randomUUID() },
  });
  const root = `/v1/servers/${server.id}`;
  const deployer = await x.json(`${root}/participants`, owner, {
    method: "POST",
    body: { name: "deployer", agentType: "script", requestKey: randomUUID() },
  });
  const invite = await x.json(`${root}/agent-invites`, owner, {
    method: "POST",
    body: { participantId: deployer.item.id, requestKey: randomUUID() },
  });
  /** A tool on /mcp/join, which needs no sign-in: its structured answer. */
  const joinTool = async (name, args) => {
    const response = await x.raw("/mcp/join", rpc("tools/call", { name, arguments: args }));
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal(response.headers.get("www-authenticate"), null);
    return JSON.parse(text).result.structuredContent;
  };
  const waiting = await joinTool("redeem_agent_invite", {
    code: invite.code,
    name: "reviewer",
    agentType: "claude-code",
  });
  assert.equal(waiting.data.status, "waiting", JSON.stringify(waiting));
  await x.json(`${root}/agent-invites/requests/${waiting.data.requestId}/approve`, owner, {
    method: "POST",
  });
  const joined = await joinTool("check_agent_invite", {
    requestId: waiting.data.requestId,
    pickup: waiting.data.pickup,
  });
  assert.equal(joined.data.status, "joined", JSON.stringify(joined));
  assert.match(joined.data.key, new RegExp(`^tka_${server.id}\\.`));
  // Its key opens an MCP session on its one server, with no sign-in.
  const context = await x.mcp(joined.data.key, "get_context", {
    serverId: server.id,
    participant: { id: joined.data.participantId },
  });
  assert.equal(context.data.server.id, server.id);
});

test("Better Auth is refused outside a self-hosted copy, and beside Cloudflare Access", async (t) => {
  for (const options of [{ selfHosted: false }, { alsoAccess: true }]) {
    const x = await start(t, { betterAuth: true, selfHosted: true, ...options });
    for (const path of ["/v1/me", "/auth/sign-in", "/.well-known/oauth-authorization-server"]) {
      const response = await x.raw(path);
      assert.equal(response.status, 503, `${JSON.stringify(options)} ${path}`);
      assert.equal((await response.json()).error.code, "identity_unavailable");
    }
    const mcp = await x.raw("/mcp", rpc("tools/list"));
    assert.equal(mcp.status, 503);
  }
});

test("the minute cron removes registrations nobody used", async (t) => {
  const x = await harness(t);
  await x.owner();
  const used = await x.register("Used");
  await x.agentSignIn(used);
  const unused = await x.register("Unused");
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  await x.db.prepare("UPDATE ba_oauth_client SET createdAt=?").bind(old).run();
  await x.scheduled();
  const left = await x.db.prepare("SELECT clientId FROM ba_oauth_client ORDER BY clientId").all();
  assert.deepEqual(
    left.results.map((row) => row.clientId),
    [used],
    `${unused} should be gone`,
  );
});

test("a person can create their account in the middle of an agent's sign-in, or deny the app", async (t) => {
  const x = await harness(t);
  const clientId = await x.register("Cursor");
  // The owner has no account yet: the agent's sign-in page offers account creation, and the
  // signed request survives it.
  const flow = x.authorize(clientId);
  const login = await destination(
    await x.raw(flow.path, { headers: navigation, redirect: "manual" }),
  );
  const code = x.link("owner@example.com");
  const create = new URLSearchParams(login.search);
  create.set("claim", code);
  const page = await (await x.raw(`/auth/sign-in?${create}`)).text();
  assert.match(page, /Create your TalkTo account/);
  const oauthQuery = /name="oauth_query" value="([^"]+)"/.exec(page)[1].replaceAll("&amp;", "&");
  assert.doesNotMatch(oauthQuery, /claim=/, "the page's own parameter is not part of the request");
  const created = await x.post("/auth/sign-up", {
    name: "Owner",
    email: "owner@example.com",
    password,
    claim: code,
    oauth_query: oauthQuery,
  });
  assert.equal(created.status, 303, await created.text());
  const cookie = x.cookieOf(created);
  const consent = new URL(created.headers.get("location"), origin);
  assert.equal(consent.pathname, "/auth/consent");
  // TalkTo's records hold the person before any dashboard visit, so agents can name them.
  const person = await x.db
    .prepare("SELECT id FROM local_users WHERE email='owner@example.com'")
    .first();
  assert.match(person.id, /^user_[0-9a-f]{32}$/);
  // The consent page names the app as unverified and shows where the code goes.
  const shown = await (
    await x.raw(`${consent.pathname}${consent.search}`, { headers: { cookie } })
  ).text();
  assert.match(shown, /Allow Cursor\?/);
  assert.match(shown, /TalkTo has not checked it/);
  assert.match(shown, /127\.0\.0\.1:51234/);
  // A tampered request is refused before anything is shown.
  const tampered = new URLSearchParams(consent.search);
  tampered.set("redirect_uri", "https://evil.example/callback");
  assert.equal((await x.raw(`/auth/consent?${tampered}`, { headers: { cookie } })).status, 400);
  // Denying sends the app an access_denied error and no code.
  const query = /name="oauth_query" value="([^"]+)"/.exec(shown)[1].replaceAll("&amp;", "&");
  const denied = await x.post("/auth/consent", { accept: "no", oauth_query: query }, cookie);
  assert.equal(denied.status, 303);
  const back = new URL(denied.headers.get("location"));
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("code"), null);
  // Consent from another site is refused.
  const forged = await x.post("/auth/consent", { accept: "yes", oauth_query: query }, cookie, {
    origin: "https://evil.example",
  });
  assert.equal(forged.status, 403);
});

test("a server guest creates an account from the server invitation's join link", async (t) => {
  const x = await harness(t);
  const owner = await x.owner();
  const account = await x.json("/v1/accounts", owner, {
    method: "POST",
    body: { name: "Team", requestKey: randomUUID() },
  });
  const server = await x.json(`/v1/accounts/${account.id}/servers`, owner, {
    method: "POST",
    body: { name: "Development", requestKey: randomUUID() },
  });
  const sent = await x.json(`/v1/servers/${server.id}/invitations`, owner, {
    method: "POST",
    body: { email: "guest@example.com" },
  });
  const id = sent.invitation?.id ?? sent.id;
  assert.match(id, /^sinv_/, JSON.stringify(sent));
  // The join page's sign-in button lands on account creation with the code filled in.
  const login = await x.raw(`/auth/login?return_to=/app/join/${id}`, { redirect: "manual" });
  const page = await (
    await x.raw(
      new URL(login.headers.get("location")).pathname +
        new URL(login.headers.get("location")).search,
    )
  ).text();
  assert.match(page, /Create your TalkTo account/);
  assert.match(page, new RegExp(`name="invitation" value="${id}"`));
  const guest = await x.signUp("guest@example.com", {
    name: "Guest",
    invitation: id,
    return_to: `/app/join/${id}`,
  });
  // Signed in with the invited address, the guest accepts as on talkto.sh.
  await x.json(`/v1/invitations/${id}/accept`, guest, { method: "POST" });
  await x.scheduled();
  assert.deepEqual(
    (await x.json("/v1/servers", guest)).items.map((item) => item.id),
    [server.id],
  );
});

test("a forgotten password: only a new account link brings the person back, with their ID", async (t) => {
  const x = await harness(t);
  const before = await x.owner();
  const id = (await x.json("/v1/me", before)).user.id;
  const account = await x.json("/v1/accounts", before, {
    method: "POST",
    body: { name: "Team", requestKey: randomUUID() },
  });
  const member = await x.json(`/v1/accounts/${account.id}/invitations`, before, {
    method: "POST",
    body: { email: "bob@example.com" },
  });
  const bob = await x.signUp("bob@example.com", { name: "Bob", invitation: member.id });
  const bobId = (await x.json("/v1/me", bob)).user.id;
  // The documented reset (docs/self-host-better-auth.md): one D1 statement, which cascades.
  await x.db.prepare("DELETE FROM ba_user WHERE email='bob@example.com'").run();
  const sessions = await x.db
    .prepare("SELECT COUNT(*) AS n FROM ba_session WHERE userId=?")
    .bind(bobId)
    .first();
  assert.equal(sessions.n, 0, "the sessions go with the user");
  await x.json("/v1/me", bob, {}, 401);
  // Bob's address now has a TalkTo person and no account. No invitation brings anyone into that
  // person, not even a new one from the owner: only an account link does.
  const other = await x.json("/v1/accounts", before, {
    method: "POST",
    body: { name: "Other team", requestKey: randomUUID() },
  });
  const second = await x.json(`/v1/accounts/${other.id}/invitations`, before, {
    method: "POST",
    body: { email: "bob@example.com" },
  });
  for (const fields of [{}, { invitation: member.id }, { invitation: second.id }]) {
    const refused = await x.post("/auth/sign-up", {
      name: "Bob",
      email: "bob@example.com",
      password,
      ...fields,
    });
    assert.equal(refused.status, 403, JSON.stringify(fields));
  }
  // Links that are not this copy's, for another address, expired, or longer-lived than a week.
  const now = Math.floor(Date.now() / 1000);
  const good = x.link("bob@example.com");
  for (const [label, claim] of [
    ["another secret", mintedLink("x".repeat(40), "bob@example.com", now + 3600)],
    ["another address", x.link("carol@example.com")],
    ["expired", mintedLink(x.betterAuthSecret, "bob@example.com", now - 1)],
    ["too long-lived", mintedLink(x.betterAuthSecret, "bob@example.com", now + 30 * 86400)],
    ["tampered", `${good.slice(0, -2)}${good.endsWith("AA") ? "BB" : "AA"}`],
  ]) {
    const refused = await x.post("/auth/sign-up", {
      name: "Bob",
      email: "bob@example.com",
      password,
      claim,
    });
    assert.equal(refused.status, 403, label);
  }
  // The real link: the same TalkTo person, ID and organization.
  const back = await x.signUp("bob@example.com", { name: "Bob", claim: good });
  assert.equal((await x.json("/v1/me", back)).user.id, bobId);
  assert.equal((await x.json("/v1/accounts", back)).items.length, 1);
  assert.notEqual(bobId, id);
});

const team = async (x, cookie, name) => {
  const account = await x.json("/v1/accounts", cookie, {
    method: "POST",
    body: { name, requestKey: randomUUID() },
  });
  const server = await x.json(`/v1/accounts/${account.id}/servers`, cookie, {
    method: "POST",
    body: { name: "Development", requestKey: randomUUID() },
  });
  return { account, server };
};
const inviteMember = (x, cookie, accountId, email) =>
  x.json(`/v1/accounts/${accountId}/invitations`, cookie, { method: "POST", body: { email } });
const inviteGuest = async (x, cookie, serverId, email) => {
  const sent = await x.json(`/v1/servers/${serverId}/invitations`, cookie, {
    method: "POST",
    body: { email },
  });
  return sent.invitation?.id ?? sent.id;
};

test("review attack A: a member cannot squat an address and inherit its pending invitation", async (t) => {
  const x = await harness(t);
  const owner = await x.owner();
  const real = await team(x, owner, "Team");
  const asMember = await inviteMember(x, owner, real.account.id, "mallory@example.com");
  const mallory = await x.signUp("mallory@example.com", {
    name: "Mallory",
    invitation: asMember.id,
  });
  const forVictim = await inviteMember(x, owner, real.account.id, "victim@example.com");
  // Mallory makes her own organization and server, and invites the victim's address to both.
  const evil = await team(x, mallory, "Evil");
  const guestCode = await inviteGuest(x, mallory, evil.server.id, "victim@example.com");
  const memberCode = (await inviteMember(x, mallory, evil.account.id, "victim@example.com")).id;
  // Neither of her codes creates the victim's account: only an owner's invitation is proof.
  for (const invitation of [guestCode, memberCode]) {
    const squat = await x.post("/auth/sign-up", {
      name: "Victim",
      email: "victim@example.com",
      password,
      invitation,
    });
    assert.equal(squat.status, 403, invitation);
    assert.equal(x.cookieOf(squat), "");
  }
  assert.equal(
    (
      await x.db
        .prepare("SELECT COUNT(*) AS n FROM ba_user WHERE email='victim@example.com'")
        .first()
    ).n,
    0,
  );
  // The real person still gets in with the owner's link, and joins only that organization.
  const victim = await x.signUp("victim@example.com", {
    name: "Victim",
    invitation: forVictim.id,
  });
  assert.deepEqual(
    (await x.json("/v1/accounts", victim)).items.map((item) => item.name),
    ["Team"],
  );
  // Mallory's own invitation stays pending until the victim opens it.
  const evilInvitations = await x.json(`/v1/accounts/${evil.account.id}/invitations`, mallory);
  assert.equal(evilInvitations.items[0].state, "pending");
});

test("review attack B: after a password reset, nobody takes the person's TalkTo ID with an invitation", async (t) => {
  const x = await harness(t);
  const owner = await x.owner();
  const real = await team(x, owner, "Team");
  const forVictim = await inviteMember(x, owner, real.account.id, "victim@example.com");
  const victim = await x.signUp("victim@example.com", { name: "Victim", invitation: forVictim.id });
  const victimId = (await x.json("/v1/me", victim)).user.id;
  const forMallory = await inviteMember(x, owner, real.account.id, "mallory@example.com");
  const mallory = await x.signUp("mallory@example.com", {
    name: "Mallory",
    invitation: forMallory.id,
  });
  // The owner resets the victim's password as the guide says.
  await x.db.prepare("DELETE FROM ba_user WHERE email='victim@example.com'").run();
  const evil = await team(x, mallory, "Evil");
  const guestCode = await inviteGuest(x, mallory, evil.server.id, "victim@example.com");
  const squat = await x.post("/auth/sign-up", {
    name: "Victim",
    email: "victim@example.com",
    password,
    invitation: guestCode,
  });
  assert.equal(squat.status, 403);
  assert.equal(x.cookieOf(squat), "");
  // The victim's address is still the victim's person, waiting for an owner's account link.
  const back = await x.signUp("victim@example.com", {
    name: "Victim",
    claim: x.link("victim@example.com"),
  });
  assert.equal((await x.json("/v1/me", back)).user.id, victimId);
});

test("a sign-up joins only the invitation it presents; others wait for their own link", async (t) => {
  const x = await harness(t);
  const owner = await x.owner();
  const first = await team(x, owner, "First");
  const second = await team(x, owner, "Second");
  const one = await inviteMember(x, owner, first.account.id, "bob@example.com");
  const two = await inviteMember(x, owner, second.account.id, "bob@example.com");
  const bob = await x.signUp("bob@example.com", { name: "Bob", invitation: one.id });
  const names = async (cookie) =>
    (await x.json("/v1/accounts", cookie)).items.map((item) => item.name).sort();
  assert.deepEqual(await names(bob), ["First"]);
  // Using the dashboard accepts nothing more.
  await x.scheduled();
  assert.deepEqual(await names(bob), ["First"]);
  // Opening the second invitation's link while signed in only asks. Any site can make a browser
  // open that address with its cookie, so a GET never changes membership.
  const opened = await x.raw(`/auth/sign-in?invitation=${two.id}`, {
    headers: { cookie: bob, "sec-fetch-site": "cross-site" },
    redirect: "manual",
  });
  assert.equal(opened.status, 200);
  const asked = await opened.text();
  assert.match(asked, /Join Second\?/);
  assert.match(asked, /<form method="post" action="\/auth\/join">/);
  assert.deepEqual(await names(bob), ["First"]);
  // Pressing Join from another site is refused; from this site it joins.
  const forged = await x.post("/auth/join", { invitation: two.id }, bob, {
    origin: "https://evil.example",
  });
  assert.equal(forged.status, 403);
  assert.deepEqual(await names(bob), ["First"]);
  const joined = await x.post("/auth/join", { invitation: two.id, return_to: "/app" }, bob);
  assert.equal(joined.status, 303);
  assert.equal(joined.headers.get("location"), `${origin}/app`);
  assert.deepEqual(await names(bob), ["First", "Second"]);
  assert.equal((await x.raw("/auth/join", { headers: { cookie: bob } })).status, 405);

  // A member's invitation reaches someone with an account: Bob, a member, invites Carol, who has
  // one. She signs in from the link's sign-in form and joins; the link does not fit anyone else.
  const forCarol = await inviteMember(x, owner, first.account.id, "carol@example.com");
  const carol = await x.signUp("carol@example.com", { name: "Carol", invitation: forCarol.id });
  const bobs = await team(x, bob, "Bob's");
  const fromBob = await inviteMember(x, bob, bobs.account.id, "carol@example.com");
  const elsewhere = await x.raw(`/auth/sign-in?invitation=${fromBob.id}`, {
    headers: { cookie: owner },
  });
  assert.equal(elsewhere.status, 400);
  assert.match(await elsewhere.text(), /does not fit this account/);
  const misfit = await x.post("/auth/join", { invitation: fromBob.id }, owner);
  assert.equal(misfit.status, 400);
  const form = await (await x.raw(`/auth/sign-in?invitation=${fromBob.id}&account=1`)).text();
  assert.match(form, /Sign in to TalkTo/);
  assert.match(form, new RegExp(`name="invitation" value="${fromBob.id}"`));
  const signedIn = await x.post("/auth/sign-in", {
    email: "carol@example.com",
    password,
    invitation: fromBob.id,
    return_to: "/app",
  });
  assert.equal(signedIn.status, 303);
  assert.deepEqual(await names(carol), ["Bob's", "First"]);
  // But a member's invitation never creates an account.
  const fromBobToDan = await inviteMember(x, bob, bobs.account.id, "dan@example.com");
  const dan = await x.post("/auth/sign-up", {
    name: "Dan",
    email: "dan@example.com",
    password,
    invitation: fromBobToDan.id,
  });
  assert.equal(dan.status, 403);
});

test("registration is capped, and authorize shows errors instead of redirecting before sign-in", async (t) => {
  const x = await harness(t);
  const big = await x.raw("/auth/api/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Big",
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
      padding: "x".repeat(17 * 1024),
    }),
  });
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error, "invalid_client_metadata");
  // Anyone can register any address. An invalid request must not bounce a browser there.
  const registered = await x.raw("/auth/api/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Evil",
      redirect_uris: ["https://evil.example/callback"],
      token_endpoint_auth_method: "none",
    }),
  });
  const registration = await registered.text();
  assert.equal(registered.status, 201, registration);
  const evil = JSON.parse(registration).client_id;
  for (const extra of [
    { scope: "bogus" },
    { code_challenge_method: "plain" },
    { response_type: "token" },
  ]) {
    const flow = x.authorize(evil, { redirect_uri: "https://evil.example/callback", ...extra });
    const answered = await x.raw(flow.path, { headers: navigation, redirect: "manual" });
    const text = await answered.text();
    assert.equal(answered.status, 400, `${JSON.stringify(extra)} ${text}`);
    assert.equal(answered.headers.get("location"), null);
    assert.doesNotMatch(text, /evil\.example/);
    assert.match(text, /This sign-in cannot start/);
  }
  // An unknown client, or an address it never registered, gets the page too.
  for (const flow of [
    x.authorize("no-such-client"),
    x.authorize(evil, { redirect_uri: "https://other.example/callback" }),
  ]) {
    const answered = await x.raw(flow.path, { headers: navigation, redirect: "manual" });
    assert.equal(answered.headers.get("location"), null);
    assert.notEqual(answered.status, 200, await answered.text());
  }
});

test("the pages' referrer policy keeps Chrome's Origin header on their own form posts", async (t) => {
  const x = await harness(t);
  // Chrome sends `Origin: null` with a form post from a page whose policy is no-referrer, and
  // the origin check rightly refuses that. Node's fetch never shows it, so this test posts the
  // Origin Chrome derives from each page's policy (Fetch standard, "serializing a request origin").
  const chromeOrigin = (response) =>
    response.headers.get("referrer-policy") === "no-referrer" ? "null" : origin;
  for (const path of ["/auth/sign-in", "/auth/sign-in?create=1"]) {
    const page = await x.raw(path);
    assert.equal(page.headers.get("referrer-policy"), "same-origin", path);
  }
  const signUpPage = await x.raw(
    `/auth/sign-in?${new URLSearchParams({ claim: x.link("owner@example.com") })}`,
  );
  const code = /name="claim" value="([^"]+)"/.exec(await signUpPage.text())[1];
  const created = await x.post(
    "/auth/sign-up",
    { name: "Owner", email: "owner@example.com", password, claim: code, return_to: "/app" },
    undefined,
    { origin: chromeOrigin(signUpPage) },
  );
  assert.equal(created.status, 303, await created.text());
  // What Chrome sent before the fix is refused, so the policy is what makes the forms work.
  const refused = await x.post(
    "/auth/sign-in",
    { email: "owner@example.com", password },
    undefined,
    { origin: "null" },
  );
  assert.equal(refused.status, 403);
});

test("a first request that never reaches Better Auth does not stall the requests after it", async (t) => {
  // Better Auth starts up when built. Built during a request that answered without it, its
  // start-up once hung every later request in the isolate (hosted.ts awaits it now).
  for (const first of ["/v1/me", "/auth/api/nope", "/auth/api/oauth2/register"]) {
    const x = await harness(t);
    const answered = await x.raw(first, {
      method: first.endsWith("register") ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      body: first.endsWith("register") ? "x".repeat(17 * 1024) : undefined,
    });
    assert.ok([401, 404, 413].includes(answered.status), `${first} ${answered.status}`);
    const next = await x.raw("/.well-known/oauth-authorization-server");
    assert.equal(next.status, 200, first);
  }
});
