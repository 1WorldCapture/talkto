import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";
import { provider } from "./billing-provider.mjs";
import { rpc } from "./mcp-wire.mjs";

/*
  Deleting one organization while keeping the person's account (docs/account-deletion.md,
  "Deleting one organization"), through the real Worker, D1, server objects, the WorkOS fixture and
  the fake Stripe. Nothing reaches a real provider.
*/

/** The website's session: deletion is refused to every other credential. */
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
    return { status: response.status, headers: response.headers, json: await response.json() };
  };
};
const rows = async (x, query, ...values) =>
  (
    await x.db
      .prepare(query)
      .bind(...values)
      .all()
  ).results;
const workos = async (x, faults) => (await x.control("identity-deletions", faults)).json();
/** Pay for Shop through the fake Stripe checkout, confirmed by the scheduled sync. */
const subscribe = async (x, stripe, account) => {
  await x.call("user_alice", "POST", `/v1/accounts/${account.id}/billing/checkout`, {
    plan: "shop",
    requestKey: randomUUID(),
  });
  const payment = stripe.complete([...stripe.sessions.keys()].at(-1));
  assert.equal((await x.control("sync")).status, 200);
  return payment.subscription;
};

/** Alice's paid organization with two servers, Bob a member, and an agent of Alice's. */
const seeded = async (t, options = {}) => {
  const stripe = provider();
  const x = await start(t, { stripeHandler: stripe.handler, email: "fake", ...options });
  const account = await x.account();
  const server = await x.server(account.id);
  const second = await x.server(account.id, { name: "Launch room" });
  await x.control("member", x.member(account.organizationId, "user_bob"));
  await x.call("user_alice", "PUT", `/v1/servers/${server.id}/access/user_bob`);
  const credential = await x.mcpToken(account.organizationId);
  await x.mcp(credential, "register_participant", {
    serverId: server.id,
    name: "builder",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  const subscription = await subscribe(x, stripe, account);
  return { x, stripe, account, server, second, credential, subscription };
};

test("the owner deletes an organization with members and servers and keeps their account", async (t) => {
  const s = await seeded(t);
  const { x, account } = s;
  // Alice's other organization, which stays.
  const other = await x.call("user_alice", "POST", "/v1/accounts", {
    name: "Side project",
    requestKey: randomUUID(),
  });
  const alice = await website(x);
  const deletion = `/v1/accounts/${account.id}/deletion`;

  const preview = await alice("GET", deletion);
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const plan = preview.json.data;
  assert.equal(plan.status, "ready");
  assert.equal(plan.name, "Team");
  assert.deepEqual(
    plan.servers.map((server) => [server.name, server.agents]),
    [
      ["Development", 1],
      ["Launch room", 0],
    ],
  );
  assert.equal(plan.otherMembers, 1);
  assert.equal(plan.guests, 0);
  assert.equal(plan.pendingInvitations, 0);
  assert.equal(plan.plan, "shop");
  assert.ok(plan.paidThrough > new Date().toISOString(), "paid through a date still ahead");
  assert.equal(plan.lastOrganization, false, "Alice still has Side project");
  assert.equal(plan.website, true);

  const deleted = await alice("POST", `/v1/accounts/${account.id}/delete`, {
    confirmation: "  Team ",
  });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  assert.deepEqual(deleted.json.data, { accountId: account.id, status: "deleted" });
  assert.ok(
    !deleted.headers.getSetCookie().some((value) => value.startsWith("__Host-talkto-session=;")),
    "deleting an organization keeps the person signed in",
  );

  // Stripe: canceled at once through billing's own path, once.
  assert.equal(s.stripe.subscriptions.get(s.subscription.id).status, "canceled");
  assert.deepEqual(
    s.stripe.requests.filter((r) => r.method === "DELETE").map((r) => r.path),
    [`/v1/subscriptions/${s.subscription.id}`],
  );
  // WorkOS: the organization is deleted; Alice's own sign-in is not.
  const provided = await workos(x);
  assert.deepEqual(provided.organizations, [account.organizationId]);
  assert.deepEqual(provided.users, []);
  // Both servers are erased to tombstones; the organization keeps one too.
  for (const id of [s.server.id, s.second.id]) {
    const state = await (await x.control(`deletion?server=${id}`)).json();
    assert.deepEqual(state.keys, []);
  }
  const servers = await rows(
    x,
    "SELECT name,deletion_completed_at AS done FROM servers WHERE account_id=?",
    account.id,
  );
  assert.ok(servers.every((server) => server.name === "Deleted server" && server.done !== null));
  const [tombstone] = await rows(x, "SELECT * FROM accounts WHERE id=?", account.id);
  assert.equal(tombstone.name, "Deleted organization");
  assert.equal(tombstone.deletion_requested_by, "user_alice");
  assert.ok(tombstone.deletion_completed_at);
  assert.equal(
    (await rows(x, "SELECT user_id FROM account_deletions")).length,
    0,
    "no account deletion",
  );

  // Alice keeps her account and her other organization; the deleted one is gone everywhere.
  const accounts = await x.call("user_alice", "GET", "/v1/accounts");
  assert.deepEqual(
    accounts.items.map((item) => item.id),
    [other.id],
  );
  await x.call("user_alice", "GET", `/v1/accounts/${account.id}`, undefined, 404);
  await x.call("user_bob", "GET", `/v1/accounts/${account.id}`, undefined, 404);
  // The agent's next call finds no server.
  const context = await x.mcp(s.credential, "get_context", {});
  assert.ok(!JSON.stringify(context).includes(s.server.id));

  // Bob is told, once, by name; Alice is not.
  const queued = await rows(x, "SELECT user_id,key,payload FROM email_outbox ORDER BY key");
  const notices = queued.filter((row) => row.key.startsWith("organization_deleted:"));
  assert.deepEqual(
    notices.map((row) => row.user_id),
    ["user_bob"],
  );
  assert.deepEqual(JSON.parse(notices[0].payload), {
    kind: "organization_deleted",
    accountId: account.id,
    organization: "Team",
    by: "alice",
  });
  assert.equal((await x.control("sync")).status, 200);
  const sent = (await (await x.control("email-sent")).json()).flatMap((batch) => batch.messages);
  const email = sent.find((message) => message.kind === "organization_deleted");
  assert.equal(email.to, "user_bob@example.com");
  assert.equal(email.subject, "alice deleted Team on TalkTo");
  assert.match(email.text, /Your TalkTo account and your other organizations are not affected/);

  // Repeating the request is the same answer and does nothing more.
  const again = await alice("POST", `/v1/accounts/${account.id}/delete`, { confirmation: "x" });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.deepEqual(again.json.data, { accountId: account.id, status: "deleted" });
  assert.equal(s.stripe.requests.filter((r) => r.method === "DELETE").length, 1);
  assert.equal(
    (await rows(x, "SELECT key FROM email_outbox WHERE key LIKE 'organization_deleted:%'")).length,
    1,
  );
});

test("only the owner, on the website, with the exact name, can delete an organization", async (t) => {
  const { x, account, credential, stripe, subscription } = await seeded(t);
  const path = `/v1/accounts/${account.id}/delete`;
  const preview = `/v1/accounts/${account.id}/deletion`;
  // An API token: forbidden, even for the owner; its preview says the website is needed.
  const token = await x.call("user_alice", "POST", path, { confirmation: "Team" }, 403);
  assert.match(token.error.message, /website/);
  assert.equal((await x.call("user_alice", "GET", preview)).website, false);
  // A member cannot, and cannot read the preview.
  const bob = await website(x, "user_bob");
  const member = await bob("POST", path, { confirmation: "Team" });
  assert.equal(member.status, 403);
  assert.match(member.json.error.message, /owner/);
  assert.equal((await bob("GET", preview)).status, 403);
  // Someone outside it learns nothing.
  const carol = await website(x, "user_carol");
  assert.equal((await carol("POST", path, { confirmation: "Team" })).status, 404);
  assert.equal((await carol("GET", preview)).status, 404);
  // The owner must type the current name exactly.
  const alice = await website(x);
  for (const confirmation of ["", "team", "Team!", "Development"]) {
    const wrong = await alice("POST", path, { confirmation });
    assert.equal(wrong.status, 400, confirmation);
    assert.equal(wrong.json.error.code, "invalid_input");
  }
  assert.equal((await alice("POST", path, { confirmation: "Team", extra: 1 })).status, 400);
  // After a rename, only the new name confirms.
  await alice("POST", `/v1/accounts/${account.id}/rename`, {
    name: "Acme",
    requestKey: randomUUID(),
  });
  assert.equal((await alice("POST", path, { confirmation: "Team" })).status, 400);
  // Agents have no tool for it.
  const tools = await (await x.raw("/mcp", rpc("tools/list", {}, credential))).json();
  assert.ok(!tools.result.tools.some((tool) => /delete_(organization|account)/.test(tool.name)));
  // Nothing changed.
  assert.equal((await x.call("user_alice", "GET", `/v1/accounts/${account.id}`)).name, "Acme");
  const [row] = await rows(x, "SELECT * FROM accounts WHERE id=?", account.id);
  assert.equal(row.deletion_requested_at, null);
  assert.equal(row.deletion_requested_by, null);
  assert.equal(stripe.subscriptions.get(subscription.id).status, "active");
  assert.deepEqual((await workos(x)).organizations, []);
});

test("a WorkOS or billing failure leaves the organization hidden and the minute sync finishes it", async (t) => {
  const { x, account, server, stripe, subscription } = await seeded(t, { manualAlarms: true });
  const alice = await website(x);
  const path = `/v1/accounts/${account.id}/delete`;

  // Billing is down: the organization is already out of every view; deletion is finishing.
  stripe.control.down = true;
  const first = await alice("POST", path, { confirmation: "Team" });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.deepEqual(first.json.data, { accountId: account.id, status: "finishing" });
  await x.call("user_alice", "GET", `/v1/accounts/${account.id}`, undefined, 404);
  assert.equal(
    (await alice("GET", `/v1/accounts/${account.id}/deletion`)).json.data.status,
    "in_progress",
  );
  assert.equal(stripe.subscriptions.get(subscription.id).status, "active");
  assert.equal((await x.control("sync")).status, 500);

  // Billing recovers, then deleting the WorkOS organization fails once.
  stripe.control.down = false;
  await workos(x, { deleteOrganization: 1 });
  assert.equal((await x.control("sync")).status, 500);
  assert.equal(stripe.subscriptions.get(subscription.id).status, "canceled");
  assert.deepEqual((await (await x.control(`deletion?server=${server.id}`)).json()).keys, []);
  const [pending] = await rows(x, "SELECT * FROM accounts WHERE id=?", account.id);
  assert.equal(pending.deletion_completed_at, null);
  assert.deepEqual((await workos(x)).organizations, []);

  // The next minute finishes it; Bob was told once across every attempt.
  assert.equal((await x.control("sync")).status, 200);
  assert.deepEqual((await workos(x)).organizations, [account.organizationId]);
  const [done] = await rows(x, "SELECT * FROM accounts WHERE id=?", account.id);
  assert.ok(done.deletion_completed_at);
  assert.equal(stripe.requests.filter((r) => r.method === "DELETE").length, 1);
  assert.deepEqual(
    (await rows(x, "SELECT user_id FROM email_outbox WHERE key LIKE 'organization_deleted:%'")).map(
      (row) => row.user_id,
    ),
    ["user_bob"],
  );
  const retried = await alice("POST", path, { confirmation: "Team" });
  assert.deepEqual(retried.json.data, { accountId: account.id, status: "deleted" });
});

test("deleting the person's last organization keeps their account and offers a new one", async (t) => {
  const x = await start(t);
  const account = await x.account();
  // The organization holds the free start, which deleting it never gives back.
  const at = new Date().toISOString();
  await x.db.batch([
    x.db
      .prepare(
        "INSERT INTO starter_grants(id,namespace,cohort,offer_version,account_id,organization_id,owner_id,request_key,server_name,allowance,status,reserved_at,reserved_day) VALUES('grant_1','test','c','v',?,?,'user_alice','k','Development',500,'active',?,?)",
      )
      .bind(account.id, account.organizationId, at, at.slice(0, 10)),
    x.db
      .prepare(
        "INSERT INTO starter_claims(namespace,kind,key,grant_id,created_at) VALUES('test','owner','user_alice','grant_1',?)",
      )
      .bind(at),
  ]);
  const alice = await website(x);
  const preview = await alice("GET", `/v1/accounts/${account.id}/deletion`);
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.data.lastOrganization, true);
  assert.equal(preview.json.data.freeStart, true);
  assert.equal(preview.json.data.plan, null);
  assert.equal(preview.json.data.paidThrough, null);
  assert.deepEqual(preview.json.data.servers, []);
  const deleted = await alice("POST", `/v1/accounts/${account.id}/delete`, {
    confirmation: "Team",
  });
  assert.deepEqual(deleted.json.data, { accountId: account.id, status: "deleted" });
  assert.deepEqual((await x.call("user_alice", "GET", "/v1/accounts")).items, []);
  const me = await x.call("user_alice", "GET", "/v1/me");
  assert.equal(me.permissions.createAccount, true);
  assert.deepEqual((await workos(x)).users, [], "the person's sign-in stays");
  // The claim stays spent, so a new organization does not start free again.
  assert.equal((await rows(x, "SELECT grant_id FROM starter_claims")).length, 1);
  assert.equal((await rows(x, "SELECT id FROM starter_grants")).length, 1);
});
