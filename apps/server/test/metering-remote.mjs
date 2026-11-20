import { readFile, appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import assert from "node:assert/strict";
import { rpc } from "./mcp-wire.mjs";

/** Reuse the metering journeys against an isolated, secret-gated Cloudflare deployment. */
export async function startRemote(file) {
  const config = JSON.parse(await readFile(file, "utf8"));
  const key = await importPKCS8(config.privateKey, "RS256");
  const token = (
    user = "user_alice",
    issuer = "https://api.workos.com/user_management/client_test",
    claims = {},
  ) =>
    new SignJWT({ sid: "session_test", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setSubject(user)
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(key);
  const raw = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("x-verification-key", config.secret);
    const response = await fetch(config.origin + path, {
      ...init,
      headers,
      signal: AbortSignal.timeout(30000),
    });
    await appendFile(
      config.evidence,
      JSON.stringify({
        at: new Date().toISOString(),
        path,
        status: response.status,
        cfRay: response.headers.get("cf-ray"),
      }) + "\n",
    );
    return response;
  };
  const control = (path, body) =>
    raw(`/__control/${path}`, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const call = async (user, method, path, body, status = 200) => {
    const response = await raw(path, {
      method,
      headers: { authorization: `Bearer ${await token(user)}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result.data ?? result;
  };
  const account = () =>
    call("user_alice", "POST", "/v1/accounts", {
      name: "Metering fault verification",
      requestKey: randomUUID(),
    });
  const server = (accountId, input = {}) =>
    call("user_alice", "POST", `/v1/accounts/${accountId}/servers`, {
      name: "Verification",
      requestKey: randomUUID(),
      ...input,
    });
  const mcpToken = (org) =>
    token("user_alice", "https://auth.talkto.test", {
      org_id: org,
      aud: "https://talkto.test/mcp",
    });
  const mcp = async (credential, name, args, error = false) => {
    const response = await raw("/mcp", rpc("tools/call", { name, arguments: args }, credential));
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.ok(result.result, JSON.stringify(result));
    assert.equal(result.result.isError ?? false, error, JSON.stringify(result));
    const content = result.result.structuredContent;
    assert.deepEqual(
      JSON.parse(result.result.content.find((c) => c.type === "text").text),
      content,
    );
    return content;
  };
  return { raw, control, call, account, server, token, mcpToken, mcp };
}
