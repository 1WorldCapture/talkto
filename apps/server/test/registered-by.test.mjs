import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/*
  `Participant.registeredBy` (docs/dashboard-api.md, "Server guests"): the website's participant
  listing names the person whose access registered each agent, so an inviter sees a guest's agents
  arrive. Bearer tokens, agents and MCP never receive it.
*/

/** A person signed in on the TalkTo website: session cookie and the website's Origin. */
const website = async (x, user = "user_alice") => {
  const flow = await x.browserLogin(user);
  const cookie = (await flow.callback()).headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
  return async (path) => {
    const response = await x.raw(path, {
      headers: { cookie, origin: "https://talkto.test" },
    });
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };
};

test("only the website's participant listing names who registered each agent", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const server = await x.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const sent = await x.call("user_alice", "POST", `${root}/invitations`, {
    email: "user_carol@example.com",
  });
  await x.call("user_carol", "POST", `/v1/invitations/${sent.invitation.id}/accept`);

  const register = async (credential, name) =>
    (
      await x.mcp(credential, "register_participant", {
        serverId: server.id,
        name,
        agentType: "claude-code",
        requestKey: randomUUID(),
      })
    ).data.item.id;
  const alices = await x.mcpToken(account.organizationId);
  const carols = await x.mcpToken(undefined, "user_carol");
  const alice = await register(alices, "Alices-agent");
  const carol = await register(carols, "Carols-agent");

  const dashboard = await website(x);
  const listed = (await dashboard(`${root}/participants?limit=50`)).items;
  const by = Object.fromEntries(listed.map((item) => [item.id, item.registeredBy]));
  assert.deepEqual(by[alice], { userId: "user_alice" });
  assert.deepEqual(by[carol], { userId: "user_carol" });

  // The same listing with a bearer token, one participant, and every MCP answer leave it out.
  const bearer = await x.call("user_alice", "GET", `${root}/participants?limit=50`);
  assert.equal(bearer.items.length, listed.length);
  assert.ok(bearer.items.every((item) => !("registeredBy" in item)));
  const one = await dashboard(`${root}/participants/${carol}`);
  assert.equal("registeredBy" in one, false);
  for (const credential of [alices, carols]) {
    const context = await x.mcp(credential, "get_context", { serverId: server.id });
    assert.match(JSON.stringify(context), /Carols-agent/);
    assert.doesNotMatch(JSON.stringify(context), /registeredBy/);
  }
});
