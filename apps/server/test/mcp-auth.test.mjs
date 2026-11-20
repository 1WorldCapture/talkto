import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT } from "jose";
import { load } from "./sources.mjs";

const McpAuth = await load("../src/mcp-auth.ts");
const WorkOS = await load("../src/platform/workos.ts");

const issuer = "https://auth.talkto.test";
const alias = "https://old-auth.talkto.test";
const resource = "https://talkto.test/mcp";

const keyPair = async (kid) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return { privateKey, set: { keys: [jwk] } };
};
const primary = await keyPair("primary");
const other = await keyPair("primary");
const stranger = await keyPair("stranger");

const sign = (key, kid, claims = {}, tokenIssuer = issuer) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: tokenIssuer,
    aud: resource,
    sub: "user_alice",
    iat: now,
    exp: now + 300,
    client_id: "client_agent",
    sid: "session_1",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .sign(key);
};
const request = (token) => new Request(resource, { headers: { authorization: `Bearer ${token}` } });

/** Capture `console.warn` while `run` runs, so a test can read what an outage logs. */
const warnings = async (run) => {
  const logged = [];
  const original = console.warn;
  console.warn = (...line) => logged.push(line);
  try {
    return { result: await run(), logged };
  } finally {
    console.warn = original;
  }
};
const failing = (error) => {
  const calls = { count: 0 };
  const keys = () => async () => {
    calls.count++;
    throw error;
  };
  return { calls, keys };
};
const fallback = (sets) => McpAuth.fallbackKeys(JSON.stringify(sets), [issuer, alias]);
const code = (effect) => Effect.runPromise(Effect.flip(effect)).then((failure) => failure.code);

for (const [name, error] of [
  ["a network error", new TypeError("Network connection lost.")],
  ["a key set timeout", new errors.JWKSTimeout()],
  ["a malformed key set", new errors.JWKSInvalid()],
]) {
  test(`MCP tokens verify with the issuer's fallback keys after ${name}`, async () => {
    const remote = failing(error);
    const verify = McpAuth.verifier(
      issuer,
      [alias],
      resource,
      fallback({ [issuer]: primary.set }),
      remote.keys,
    );
    const token = await sign(primary.privateKey, "primary");
    const { result, logged } = await warnings(() => Effect.runPromise(verify(request(token))));
    assert.equal(result.userId, "user_alice");
    assert.equal(result.mcpClient.clientId, "client_agent");
    assert.equal(remote.calls.count, 1);
    assert.equal(logged.length, 1);
    const [event, fields] = logged[0];
    assert.equal(event, "mcp-auth: key set unavailable");
    assert.equal(fields.issuer, issuer);
    assert.equal(fields.failure, error.name);
    assert.equal(fields.code, error.code ?? null);
    const serialized = JSON.stringify(logged);
    for (const forbidden of [token, token.split(".")[1], "user_alice", "client_agent", "session_1"])
      assert.ok(!serialized.includes(forbidden), "the log never carries the token or its claims");
    // For the next minute the fallback answers alone, so a broken route is not retried per request.
    const again = await warnings(() => Effect.runPromise(verify(request(token))));
    assert.equal(again.result.userId, "user_alice");
    assert.equal(remote.calls.count, 1);
    assert.equal(again.logged.length, 0);
  });
}

test("fallback keys still reject a token they do not verify", async () => {
  const remote = failing(new TypeError("fetch failed"));
  const verify = McpAuth.verifier(
    issuer,
    [alias],
    resource,
    fallback({ [issuer]: primary.set, [alias]: stranger.set }),
    remote.keys,
  );
  await warnings(async () => {
    // Same key ID, another key: a forged signature is unauthenticated, not an outage.
    assert.equal(
      await code(verify(request(await sign(other.privateKey, "primary")))),
      "unauthenticated",
    );
    // A valid signature with the wrong audience or an expired token is still unauthenticated.
    assert.equal(
      await code(
        verify(request(await sign(primary.privateKey, "primary", { aud: "https://x.test" }))),
      ),
      "unauthenticated",
    );
    assert.equal(
      await code(verify(request(await sign(primary.privateKey, "primary", { exp: 1 })))),
      "unauthenticated",
    );
    // The primary issuer's key never verifies a token claiming the alias issuer, even in fallback:
    // under the primary key ID the alias's own keys do not know it, under theirs it fails.
    assert.equal(
      await code(verify(request(await sign(primary.privateKey, "primary", {}, alias)))),
      "identity_unavailable",
    );
    assert.equal(
      await code(verify(request(await sign(primary.privateKey, "stranger", {}, alias)))),
      "unauthenticated",
    );
  });
});

test("a key ID the fallback does not know stays retryable, since the live set may hold it", async () => {
  const remote = failing(new TypeError("fetch failed"));
  const verify = McpAuth.verifier(
    issuer,
    [],
    resource,
    fallback({ [issuer]: primary.set }),
    remote.keys,
  );
  const token = await sign(stranger.privateKey, "stranger");
  const { result, logged } = await warnings(() => code(verify(request(token))));
  assert.equal(result, "identity_unavailable");
  assert.deepEqual(
    logged.map(([event, fields]) => [event, fields.failure]),
    [
      ["mcp-auth: key set unavailable", "TypeError"],
      ["mcp-auth: fallback keys unavailable", "JWKSNoMatchingKey"],
    ],
  );
});

test("without fallback keys for the issuer, a key set outage is still identity_unavailable", async () => {
  for (const fallbacks of [
    new Map(),
    McpAuth.fallbackKeys(undefined, [issuer]),
    // Fallback keys for another issuer never stand in for this one.
    fallback({ [alias]: primary.set }),
  ]) {
    const remote = failing(new errors.JWKSTimeout());
    const verify = McpAuth.verifier(issuer, [alias], resource, fallbacks, remote.keys);
    const token = await sign(primary.privateKey, "primary");
    const first = await warnings(() => code(verify(request(token))));
    assert.equal(first.result, "identity_unavailable");
    assert.equal(first.logged.length, 1);
    assert.equal(first.logged[0][1].code, "ERR_JWKS_TIMEOUT");
    assert.ok(!JSON.stringify(first.logged).includes(token));
    // Without a fallback nothing is skipped: the next request tries the live key set again.
    const second = await warnings(() => code(verify(request(token))));
    assert.equal(second.result, "identity_unavailable");
    assert.equal(remote.calls.count, 2);
  }
});

test("a reachable key set is used as before, and its answer is final", async () => {
  let calls = 0;
  const live = createLocalJWKSet(primary.set);
  const keys = () => (header, token) => {
    calls++;
    return live(header, token);
  };
  const verify = McpAuth.verifier(
    issuer,
    [],
    resource,
    // A stale fallback holding another key must not matter while the live set answers.
    fallback({ [issuer]: other.set }),
    keys,
  );
  const { logged } = await warnings(async () => {
    const actor = await Effect.runPromise(
      verify(request(await sign(primary.privateKey, "primary"))),
    );
    assert.equal(actor.userId, "user_alice");
    assert.equal(
      await code(verify(request(await sign(other.privateKey, "primary")))),
      "unauthenticated",
    );
  });
  assert.equal(calls, 2);
  assert.equal(logged.length, 0);
});

test("the live key set's HTTP status is named in the log", async () => {
  const original = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response("blocked", { status: 403 });
  };
  try {
    const verify = McpAuth.verifier(issuer, [], resource, fallback({ [issuer]: primary.set }));
    const { result, logged } = await warnings(async () =>
      Effect.runPromise(verify(request(await sign(primary.privateKey, "primary")))),
    );
    assert.equal(result.userId, "user_alice");
    assert.deepEqual(fetched, [`${issuer}/oauth2/jwks`]);
    assert.equal(logged[0][1].failure, "KeySetResponse");
    assert.equal(logged[0][1].code, "HTTP_403");
  } finally {
    globalThis.fetch = original;
  }
});

test("WORKOS_MCP_JWKS accepts only RS256 public key sets for listed issuers", async () => {
  const { logged } = await warnings(async () => {
    for (const invalid of [
      "not json",
      JSON.stringify([primary.set]),
      JSON.stringify({ [issuer]: { keys: [] } }),
      JSON.stringify({ [issuer]: { keys: [{ ...primary.set.keys[0], alg: "HS256" }] } }),
      JSON.stringify({ [issuer]: { keys: [{ ...primary.set.keys[0], kty: "oct", k: "secret" }] } }),
      JSON.stringify({ [issuer]: { keys: [{ ...primary.set.keys[0], n: "not base64url!" }] } }),
    ])
      assert.equal(McpAuth.fallbackKeys(invalid, [issuer]).size, 0, invalid);
  });
  assert.equal(logged.length, 6);
  assert.match(logged[0][0], /ignored an invalid WORKOS_MCP_JWKS/);
  const configured = McpAuth.fallbackKeys(
    JSON.stringify({ [issuer]: primary.set, "https://unlisted.test": primary.set }),
    [issuer, alias],
  );
  assert.deepEqual([...configured.keys()], [issuer]);
});

test("a browser session key set outage logs its cause, never the token", async () => {
  const config = {
    clientId: "client_test",
    issuer: "https://api.workos.com/user_management/client_test",
  };
  for (const error of [new TypeError("Network connection lost."), new errors.JWKSTimeout()]) {
    const verify = WorkOS.verifier(config, async () => {
      throw error;
    });
    const token = await new SignJWT({ sid: "session_1" })
      .setProtectedHeader({ alg: "RS256", kid: "primary" })
      .setIssuer(config.issuer)
      .setSubject("user_alice")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(primary.privateKey);
    const { result, logged } = await warnings(() => code(verify(request(token))));
    assert.equal(result, "identity_unavailable");
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], "workos: session key set unavailable");
    assert.equal(logged[0][1].failure, error.name);
    const serialized = JSON.stringify(logged);
    for (const forbidden of [token, "user_alice", "session_1"])
      assert.ok(!serialized.includes(forbidden));
  }
});
