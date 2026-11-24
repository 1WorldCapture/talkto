import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";
import { rpc } from "./mcp-wire.mjs";

/** The website's session: renaming is refused to every other credential. */
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
const workos = async (x, faults) => (await x.control("identity-deletions", faults)).json();
const rows = async (x, query, ...values) =>
  (
    await x.db
      .prepare(query)
      .bind(...values)
      .all()
  ).results;

/** Alice's organization and server, Bob a member who can read the server, and an agent of Alice's. */
const seeded = async (t) => {
  const x = await start(t);
  const account = await x.account();
  const server = await x.server(account.id);
  await x.control("member", x.member(account.organizationId, "user_bob"));
  await x.call("user_alice", "PUT", `/v1/servers/${server.id}/access/user_bob`);
  const credential = await x.mcpToken(account.organizationId);
  await x.mcp(credential, "register_participant", {
    serverId: server.id,
    name: "builder",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  return { x, account, server, credential, alice: await website(x) };
};

test("the owner renames the organization in TalkTo and WorkOS; retries are safe", async (t) => {
  const { x, account, alice } = await seeded(t);
  const path = `/v1/accounts/${account.id}/rename`;
  assert.equal(account.permissions.rename, true);

  const requestKey = randomUUID();
  const renamed = await alice("POST", path, { name: "  Acme Robotics  ", requestKey });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  assert.equal(renamed.json.data.changed, true);
  assert.equal(renamed.json.data.account.name, "Acme Robotics", "names are trimmed");
  assert.equal(renamed.json.data.account.id, account.id);
  assert.equal(renamed.json.data.account.organizationId, account.organizationId);
  assert.equal((await workos(x)).names[account.organizationId], "Acme Robotics");
  assert.equal(
    (await x.call("user_alice", "GET", `/v1/accounts/${account.id}`)).name,
    "Acme Robotics",
  );
  const listed = await x.call("user_alice", "GET", "/v1/accounts");
  assert.equal(listed.items.find((item) => item.id === account.id).name, "Acme Robotics");
  assert.equal(
    (await x.call("user_bob", "GET", `/v1/accounts/${account.id}`)).name,
    "Acme Robotics",
  );

  // The same key and name: the earlier outcome, unchanged.
  const again = await alice("POST", path, { name: "Acme Robotics", requestKey });
  assert.equal(again.status, 200);
  assert.equal(again.json.data.changed, false);
  // The same key with another name.
  const reused = await alice("POST", path, { name: "Other", requestKey });
  assert.equal(reused.status, 409);
  assert.equal(reused.json.error.code, "idempotency_conflict");
  // The exact current name changes nothing and records nothing.
  const same = await alice("POST", path, { name: "Acme Robotics", requestKey: randomUUID() });
  assert.equal(same.json.data.changed, false);
  // A case-only change is a change.
  const cased = await alice("POST", path, { name: "ACME Robotics", requestKey: randomUUID() });
  assert.equal(cased.json.data.changed, true);
  assert.deepEqual(
    (
      await rows(
        x,
        "SELECT previous_name AS p,name AS n,applied_at IS NOT NULL AS applied FROM directory_renames WHERE kind='organization' ORDER BY seq",
      )
    ).map((row) => [row.p, row.n, row.applied]),
    [
      ["Team", "Acme Robotics", 1],
      ["Acme Robotics", "ACME Robotics", 1],
    ],
  );

  // A retry of the original create request still finds the organization after the rename.
  const original = (
    await rows(x, "SELECT request_key AS k FROM accounts WHERE id=?", account.id)
  )[0].k;
  const recreate = await x.call("user_alice", "POST", "/v1/accounts", {
    name: "Team",
    requestKey: original,
  });
  assert.equal(recreate.id, account.id);
  assert.equal(recreate.name, "ACME Robotics");
  const renamedKey = await x.call(
    "user_alice",
    "POST",
    "/v1/accounts",
    { name: "ACME Robotics", requestKey: original },
    409,
  );
  assert.equal(renamedKey.error.code, "idempotency_conflict");
});

test("organization and server names follow creation's rules", async (t) => {
  const { account, server, alice } = await seeded(t);
  for (const path of [
    `/v1/accounts/${account.id}/rename`,
    `/v1/accounts/${account.id}/servers/${server.id}/rename`,
  ]) {
    for (const name of ["", "   ", "x".repeat(101), "é".repeat(51), "a\u0000b"]) {
      const refused = await alice("POST", path, { name, requestKey: randomUUID() });
      assert.equal(refused.status, 400, `${JSON.stringify(name)}: ${JSON.stringify(refused.json)}`);
      assert.equal(refused.json.error.code, "invalid_input");
    }
    const extra = await alice("POST", path, { name: "Fine", requestKey: randomUUID(), other: 1 });
    assert.equal(extra.status, 400);
    const longest = await alice("POST", path, { name: "é".repeat(50), requestKey: randomUUID() });
    assert.equal(longest.status, 200, "100 UTF-8 bytes fit");
  }
});

test("only the owner on the website renames; tokens, agents, members and outsiders cannot", async (t) => {
  const { x, account, server, credential } = await seeded(t);
  const organization = `/v1/accounts/${account.id}/rename`;
  const serverPath = `/v1/accounts/${account.id}/servers/${server.id}/rename`;
  const input = () => ({ name: "Renamed", requestKey: randomUUID() });
  // An API token, even the owner's.
  for (const path of [organization, serverPath]) {
    const refused = await x.call("user_alice", "POST", path, input(), 403);
    assert.equal(refused.error.code, "forbidden");
    assert.match(refused.error.message, /on the TalkTo website/);
  }
  // A member who can read the server sees the organization and server but is not their manager.
  const bob = await website(x, "user_bob");
  assert.equal(
    (await x.call("user_bob", "GET", `/v1/accounts/${account.id}`)).permissions.rename,
    false,
  );
  const member = await bob("POST", organization, input());
  assert.equal(member.status, 403);
  assert.match(member.json.error.message, /owner/);
  const reader = await bob("POST", serverPath, input());
  assert.equal(reader.status, 403);
  assert.match(reader.json.error.message, /manages this server/);
  // Someone outside the organization learns nothing about it.
  const carol = await website(x, "user_carol");
  assert.equal((await carol("POST", organization, input())).status, 404);
  assert.equal((await carol("POST", serverPath, input())).status, 404);
  // Agents have no tool for it.
  const tools = await (await x.raw("/mcp", rpc("tools/list", {}, credential))).json();
  const names = tools.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("rename_participant"));
  assert.ok(!names.some((name) => /rename_(server|organization|account)/.test(name)));
  // Nothing changed.
  assert.equal((await x.call("user_alice", "GET", `/v1/accounts/${account.id}`)).name, "Team");
  assert.equal((await rows(x, "SELECT id FROM directory_renames")).length, 0);
});

test("a WorkOS failure keeps TalkTo's new name and is retried by a retry or the minute sync", async (t) => {
  const { x, account, alice } = await seeded(t);
  const path = `/v1/accounts/${account.id}/rename`;
  await workos(x, { renameOrganization: 1 });
  const requestKey = randomUUID();
  const failed = await alice("POST", path, { name: "Acme", requestKey });
  assert.equal(failed.status, 503, JSON.stringify(failed.json));
  assert.equal(failed.json.error.code, "identity_unavailable");
  assert.match(failed.json.error.message, /renamed in TalkTo/);
  assert.equal((await x.call("user_alice", "GET", `/v1/accounts/${account.id}`)).name, "Acme");
  assert.equal((await workos(x)).names[account.organizationId], undefined);
  // Retrying the same request delivers it.
  const retried = await alice("POST", path, { name: "Acme", requestKey });
  assert.equal(retried.status, 200);
  assert.equal(retried.json.data.changed, false);
  assert.equal((await workos(x)).names[account.organizationId], "Acme");

  // Without a retry, the minute sync delivers the latest name.
  await workos(x, { renameOrganization: 2 });
  assert.equal(
    (await alice("POST", path, { name: "Acme 2", requestKey: randomUUID() })).status,
    503,
  );
  assert.equal(
    (await alice("POST", path, { name: "Acme 3", requestKey: randomUUID() })).status,
    503,
  );
  assert.equal((await workos(x)).names[account.organizationId], "Acme");
  assert.equal((await x.control("sync")).status, 200);
  assert.equal((await workos(x)).names[account.organizationId], "Acme 3");
  assert.equal(
    (await rows(x, "SELECT id FROM directory_renames WHERE applied_at IS NULL")).length,
    0,
  );
});

test("a server rename reaches agents, listings and Activity at once", async (t) => {
  const { x, account, server, credential, alice } = await seeded(t);
  const path = `/v1/accounts/${account.id}/servers/${server.id}/rename`;
  const other = await x.server(account.id, { name: "Research" });
  const requestKey = randomUUID();
  // Names need not be unique in an organization, as at creation.
  const renamed = await alice("POST", path, { name: "Research", requestKey });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  assert.equal(renamed.json.data.changed, true);
  assert.equal(renamed.json.data.server.name, "Research");
  assert.equal(renamed.json.data.server.permissions.manageAccess, true);
  const final = await alice("POST", path, { name: "Launch room", requestKey: randomUUID() });
  assert.equal(final.json.data.server.name, "Launch room");

  // Agents: get_context with and without a server, and the server summary.
  const context = await x.mcp(credential, "get_context", { serverId: server.id });
  assert.equal(context.data.server.name, "Launch room");
  const directory = await x.mcp(credential, "get_context", {});
  assert.equal(directory.data.items.find((item) => item.id === server.id).name, "Launch room");
  assert.equal(directory.data.items.find((item) => item.id === other.id).name, "Research");
  const summary = await x.call("user_alice", "GET", `/v1/servers/${server.id}/summary`);
  assert.equal(summary.server.name, "Launch room");
  // People: management listings, the server page, and Home.
  assert.equal(
    (await x.call("user_alice", "GET", `/v1/accounts/${account.id}/servers/${server.id}`)).name,
    "Launch room",
  );
  const managed = await x.call("user_alice", "GET", `/v1/accounts/${account.id}/servers`);
  assert.equal(managed.items.find((item) => item.id === server.id).name, "Launch room");
  const home = await x.call("user_bob", "GET", `/v1/accounts/${account.id}/dashboard`);
  assert.equal(
    home.servers.find((entry) => entry.summary.server.id === server.id).summary.server.name,
    "Launch room",
  );

  // Activity: newest first, with who renamed it, for anyone who can open the server.
  const renames = await x.call(
    "user_bob",
    "GET",
    `/v1/accounts/${account.id}/servers/${server.id}/renames`,
  );
  assert.deepEqual(
    renames.items.map((item) => [item.previousName, item.name, item.renamedBy]),
    [
      ["Research", "Launch room", "alice"],
      ["Development", "Research", "alice"],
    ],
  );
  await x.call(
    "user_carol",
    "GET",
    `/v1/accounts/${account.id}/servers/${server.id}/renames`,
    undefined,
    404,
  );

  // Retries: the same key returns the current name, never the older one.
  const late = await alice("POST", path, { name: "Research", requestKey });
  assert.equal(late.json.data.changed, false);
  assert.equal(late.json.data.server.name, "Launch room");
  // A retry of the original create request still finds the server under its new name.
  const recreated = await x.call("user_alice", "POST", `/v1/accounts/${account.id}/servers`, {
    name: "Development",
    requestKey: (await rows(x, "SELECT request_key AS k FROM servers WHERE id=?", server.id))[0].k,
  });
  assert.equal(recreated.id, server.id);
  assert.equal(recreated.name, "Launch room");

  // Deleting the server removes its earlier names with it.
  await x.call("user_alice", "POST", `/v1/accounts/${account.id}/servers/${server.id}/delete`, {
    confirmation: "Launch room",
  });
  assert.equal(
    (await rows(x, "SELECT id FROM directory_renames WHERE target_id=?", server.id)).length,
    0,
  );
});

test("an older name delivered late never replaces the server's newer one", async (t) => {
  const { x, account, server, credential, alice } = await seeded(t);
  const path = `/v1/accounts/${account.id}/servers/${server.id}/rename`;
  await alice("POST", path, { name: "First", requestKey: randomUUID() });
  await alice("POST", path, { name: "Second", requestKey: randomUUID() });
  // Mark both renames unconfirmed and roll the minute sync: it delivers the latest name only.
  await x.db.prepare("UPDATE directory_renames SET applied_at=NULL").run();
  assert.equal((await x.control("sync")).status, 200);
  assert.equal(
    (await x.mcp(credential, "get_context", { serverId: server.id })).data.server.name,
    "Second",
  );
  assert.equal(
    (await rows(x, "SELECT id FROM directory_renames WHERE applied_at IS NULL")).length,
    0,
  );
});
