import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/*
  HTTP routes for what only MCP tools did before: file transfers (pack command, prepare, complete,
  fetch, read) and signal links (create, revoke). Each runs the same operation as its tool, with the
  server and the transfer or participant in the path.
*/

const sha = "a".repeat(64);
const setup = async (t) => {
  const x = await start(t, { transfers: true });
  const account = await x.account();
  const server = await x.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const register = async (name) =>
    x.call("user_alice", "POST", `${root}/participants`, {
      name,
      agentType: "codex",
      requestKey: randomUUID(),
    });
  const sender = await register("sender");
  const receiver = await register("receiver");
  return {
    x,
    server,
    root,
    general: sender.generalConversationId,
    senderId: sender.item.id,
    receiverId: receiver.item.id,
    call: (method, path, value, status) =>
      x.call("user_alice", method, `${root}${path}`, value, status),
  };
};

test("a file goes from prepare to complete to fetch over HTTP, like the tools", async (t) => {
  const s = await setup(t);
  const pack = await s.call("GET", "/files/pack-command");
  assert.match(pack.command, /tar/);

  const prepared = await s.call("POST", "/files/transfers", {
    participantId: s.senderId,
    requestKey: randomUUID(),
    name: "report.pdf",
    kind: "file",
    bytes: 16,
    sha256: sha,
  });
  assert.ok(prepared.transferId);
  assert.match(prepared.uploadUrl, /\/payload\?/);

  // Not uploaded yet: completing is refused, as with complete_transfer.
  const offer = {
    participantId: s.senderId,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: s.general },
    body: "The report you asked for.",
  };
  await s.call("POST", `/files/transfers/${prepared.transferId}/complete`, offer, 409);

  const key = `r30/${s.server.id}/${prepared.transferId}/payload`;
  const uploaded = await s.x.control(`transfer-object?key=${encodeURIComponent(key)}&bytes=16`);
  assert.equal(uploaded.status, 200);
  const completed = await s.call("POST", `/files/transfers/${prepared.transferId}/complete`, {
    ...offer,
    requestKey: randomUUID(),
  });
  assert.equal(completed.item.transfer.id, prepared.transferId);
  assert.equal(completed.item.conversationId, s.general);

  const status = await s.call("GET", `/files/transfers/${prepared.transferId}`);
  assert.equal(status.transfer.id, prepared.transferId);
  assert.equal(status.senderId, s.senderId);

  const fetched = await s.call("POST", `/files/transfers/${prepared.transferId}/fetch`, {
    participantId: s.receiverId,
  });
  assert.match(fetched.url, /\/payload\?/);
  // Extra fields are refused, as with every strict payload.
  await s.call(
    "POST",
    `/files/transfers/${prepared.transferId}/fetch`,
    { participantId: s.receiverId, serverId: s.server.id },
    400,
  );
});

test("a participant's signal link is created and revoked over HTTP", async (t) => {
  const s = await setup(t);
  const path = `/participants/${s.senderId}/signals`;
  const link = await s.call("POST", path, { channelIds: [], directChats: "own" });
  assert.ok(link.url.startsWith(`https://talkto.test/v1/signals/${s.server.id}/`));
  assert.equal(link.minIntervalSeconds, 10);
  assert.ok(link.procedure.length > 0);

  // The link answers with its secret in the Authorization header, until revoked.
  const [id, secret] = link.url.slice(link.url.lastIndexOf("/") + 1).split(".");
  assert.equal(id, link.signalId);
  const check = () =>
    s.x.raw(`/v1/signals/${s.server.id}/${id}`, { headers: { authorization: `Bearer ${secret}` } });
  assert.equal((await check()).status, 200);

  const one = await s.call("DELETE", `${path}/${link.signalId}`);
  assert.equal(one.revoked, 1);
  assert.notEqual((await check()).status, 200);
  const again = await s.call("POST", path, { channelIds: [], directChats: "own" });
  const all = await s.call("DELETE", path);
  assert.equal(all.revoked, 1);
  assert.notEqual(again.signalId, link.signalId);
});

test("the OpenAPI document lists the new routes", async (t) => {
  const x = await start(t, { transfers: true });
  const spec = await (await x.raw("/openapi.json")).json();
  for (const [path, method] of [
    ["/v1/servers/{serverId}/files/pack-command", "get"],
    ["/v1/servers/{serverId}/files/transfers", "post"],
    ["/v1/servers/{serverId}/files/transfers/{transferId}", "get"],
    ["/v1/servers/{serverId}/files/transfers/{transferId}/complete", "post"],
    ["/v1/servers/{serverId}/files/transfers/{transferId}/fetch", "post"],
    ["/v1/servers/{serverId}/participants/{participantId}/signals", "post"],
    ["/v1/servers/{serverId}/participants/{participantId}/signals", "delete"],
    ["/v1/servers/{serverId}/participants/{participantId}/signals/{signalId}", "delete"],
  ])
    assert.ok(spec.paths[path]?.[method], `${method} ${path}`);
});
