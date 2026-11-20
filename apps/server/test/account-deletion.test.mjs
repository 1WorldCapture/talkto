import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";
import { provider } from "./billing-provider.mjs";

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
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: JSON.parse(text) };
  };
};
const rows = async (x, query, ...values) =>
  (
    await x.db
      .prepare(query)
      .bind(...values)
      .all()
  ).results;
const count = async (x, query, ...values) => (await rows(x, query, ...values))[0].n;
const identity = async (x, faults) => (await x.control("identity-deletions", faults)).json();
const empty = async (x, serverId) => {
  const state = await (await x.control(`deletion?server=${serverId}`)).json();
  assert.deepEqual(state.keys, []);
  assert.deepEqual(
    state.tables.filter((table) => table.name !== "_cf_KV"),
    [],
  );
};
const agent = async (x, organizationId, serverId, user = "user_alice", name = "Proof") => {
  const credential = await x.mcpToken(organizationId, user);
  const registered = await x.mcp(credential, "register_participant", {
    serverId,
    name,
    agentType: "codex",
    requestKey: randomUUID(),
  });
  const participantId = registered.data.item.id;
  const general = registered.data.generalConversationId;
  return {
    credential,
    participantId,
    general,
    send: (body, error = false) =>
      x.mcp(
        credential,
        "send_message",
        {
          serverId,
          participantId,
          requestKey: randomUUID(),
          target: { kind: "conversation", conversationId: general },
          body,
        },
        error,
      ),
  };
};
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

// The suite's largest scenario: two organizations, three servers, a plan, files and about a hundred
// requests before and after the deletion. Under a release run's load it took 45-52 s on boat and
// twice reached the suite's 60 s, so it gets twice that.
const largestScenario = { timeout: 120_000 };
test(
  "a sole owner's deletion removes their organization, servers, files, access and sign-in, cancels the plan, and keeps only the documented records",
  largestScenario,
  async (t) => {
    const stripe = provider();
    const x = await start(t, {
      stripeHandler: stripe.handler,
      transfers: true,
      manualAlarms: true,
    });
    const account = await x.account();
    const server = await x.server(account.id);
    const own = await agent(x, account.organizationId, server.id);
    await own.send("Alice's own history");
    // The server shared through Git before hosted TalkTo retired it: it still records a repository,
    // and with no Git store configured the deletion must not wait for one.
    const recorded = await x.control(`files?server=${server.id}`, {
      recordedRemote: `https://acct.artifacts.cloudflare.net/git/talkto-production/srv-${server.id}.git`,
    });
    assert.equal(recorded.status, 200);
    assert.equal((await recorded.json()).repository.length, 1);
    const transfer = await x.mcp(own.credential, "prepare_transfer", {
      serverId: server.id,
      participantId: own.participantId,
      requestKey: randomUUID(),
      name: "notes.txt",
      kind: "file",
      bytes: 16,
      sha256: "a".repeat(64),
    });
    const key = `r30/${server.id}/${transfer.data.transferId}/payload`;
    await x.control(`transfer-object?key=${encodeURIComponent(key)}&bytes=16`);
    await x.call("user_alice", "POST", `/v1/accounts/${account.id}/invitations`, {
      email: "carol@example.com",
    });
    const subscription = await subscribe(x, stripe, account);
    await x.db
      .prepare(
        "INSERT INTO user_onboarding(user_id,revision,state,updated_at) VALUES('user_alice',1,'{}',?)",
      )
      .bind(new Date().toISOString())
      .run();

    // Bob's organization: Alice is a member with access, an agent, a signal link and a server.
    const bobs = await x.call("user_bob", "POST", "/v1/accounts", {
      name: "Bob's team",
      requestKey: randomUUID(),
    });
    await x.control("member", x.member(bobs.organizationId, "user_alice"));
    const shared = await x.call("user_bob", "POST", `/v1/accounts/${bobs.id}/servers`, {
      name: "Shared",
      requestKey: randomUUID(),
    });
    await x.call("user_bob", "PUT", `/v1/servers/${shared.id}/access/user_alice`);
    const guest = await agent(x, bobs.organizationId, shared.id, "user_alice", "Guest");
    await guest.send("Written by Alice's agent for Bob's team");
    // Alice also writes herself, as a person, on her own server and on Bob's.
    const personally = async (serverId, agentId, body) => {
      const root = `/v1/servers/${serverId}/people/me`;
      const chat = await x.call("user_alice", "POST", `${root}/direct-chats`, {
        agentId,
        requestKey: randomUUID(),
      });
      await x.call("user_alice", "POST", `${root}/messages`, {
        conversationId: chat.item.id,
        requestKey: randomUUID(),
        body,
      });
      return chat.item.id;
    };
    await personally(server.id, own.participantId, "Alice herself, on her own server");
    const personChat = await personally(shared.id, guest.participantId, "Alice herself, for Bob");
    // Bob shared another server with Alice and took it back before she deleted her account. An
    // agent there already uses the first neutral name.
    const earlier = await x.call("user_bob", "POST", `/v1/accounts/${bobs.id}/servers`, {
      name: "Earlier",
      requestKey: randomUUID(),
    });
    await x.call("user_bob", "PUT", `/v1/servers/${earlier.id}/access/user_alice`);
    const helper = await agent(x, bobs.organizationId, earlier.id, "user_bob", "former-person");
    await personally(earlier.id, helper.participantId, "Alice herself, earlier");
    await x.call("user_bob", "DELETE", `/v1/servers/${earlier.id}/access/user_alice`);
    const signal = (
      await x.mcp(guest.credential, "create_signal", {
        serverId: shared.id,
        participantId: guest.participantId,
        channelIds: [guest.general],
        directChats: "own",
      })
    ).data.url;
    const checkSignal = async () => {
      const target = new URL(signal);
      const dot = target.pathname.lastIndexOf(".");
      return (
        await x.raw(target.pathname.slice(0, dot), {
          headers: { authorization: `Bearer ${target.pathname.slice(dot + 1)}` },
        })
      ).status;
    };
    assert.equal(await checkSignal(), 200);
    const aliceServer = await x.call("user_alice", "POST", `/v1/accounts/${bobs.id}/servers`, {
      name: "Alice in Bob's team",
      requestKey: randomUUID(),
    });

    const browser = await website(x);
    const plan = await browser("GET", "/v1/me/deletion");
    assert.equal(plan.status, 200, JSON.stringify(plan.json));
    assert.deepEqual(
      {
        ...plan.json.data,
        deleted: plan.json.data.deleted.map(({ name, servers, otherMembers, plan }) => ({
          name,
          servers,
          otherMembers,
          plan,
        })),
      },
      {
        email: "user_alice@example.com",
        status: "ready",
        deleted: [{ name: "Team", servers: 1, otherMembers: 0, plan: "shop" }],
        blocked: [],
        memberships: 1,
        servers: [
          {
            serverId: aliceServer.id,
            name: "Alice in Bob's team",
            accountId: bobs.id,
            organization: "Bob's team",
          },
        ],
        website: true,
      },
    );
    // Agents and API tokens can never delete a human's account.
    const token = await x.call("user_alice", "GET", "/v1/me/deletion");
    assert.equal(token.website, false);
    await x.call(
      "user_alice",
      "POST",
      "/v1/me/delete",
      { confirmation: "user_alice@example.com" },
      403,
    );
    const wrong = await browser("POST", "/v1/me/delete", { confirmation: "alice@example.com" });
    assert.equal(wrong.status, 400);
    assert.equal(await count(x, "SELECT COUNT(*) AS n FROM account_deletions"), 0);

    const deleted = await browser("POST", "/v1/me/delete", {
      confirmation: "  USER_ALICE@example.com ",
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
    assert.deepEqual(deleted.json.data, { status: "deleted" });
    assert.ok(
      deleted.headers
        .getSetCookie()
        .some((value) => /^__Host-talkto-session=;/.test(value) && /Max-Age=0/i.test(value)),
      "the website session ends",
    );

    // Providers: sign-in and the organization are gone; the paid plan ended at once.
    const provided = await identity(x);
    assert.deepEqual(provided.users, ["user_alice"]);
    assert.deepEqual(provided.organizations, [account.organizationId]);
    assert.equal(
      provided.invitations.filter((invite) => invite.organizationId === account.organizationId)
        .length,
      0,
    );
    assert.ok(provided.members.every((member) => member.userId !== "user_alice"));
    assert.equal(stripe.subscriptions.get(subscription.id).status, "canceled");
    assert.deepEqual(
      stripe.requests.filter((r) => r.method === "DELETE").map((r) => r.path),
      [`/v1/subscriptions/${subscription.id}`],
    );

    // Alice's organization and server content are erased; only tombstones remain.
    await empty(x, server.id);
    assert.deepEqual(
      (await (await x.control("transfer-objects")).json()).keys.filter((k) =>
        k.includes(server.id),
      ),
      [],
    );
    const [tombstone] = await rows(x, "SELECT * FROM accounts WHERE id=?", account.id);
    assert.equal(tombstone.name, "Deleted organization");
    assert.ok(tombstone.deletion_completed_at);
    assert.equal(
      (await rows(x, "SELECT name FROM servers WHERE id=?", server.id))[0].name,
      "Deleted server",
    );
    for (const [query, ...values] of [
      ["SELECT COUNT(*) AS n FROM memberships WHERE user_id=?", "user_alice"],
      ["SELECT COUNT(*) AS n FROM memberships WHERE organization_id=?", account.organizationId],
      ["SELECT COUNT(*) AS n FROM server_access WHERE user_id=?", "user_alice"],
      ["SELECT COUNT(*) AS n FROM user_onboarding WHERE user_id=?", "user_alice"],
      ["SELECT COUNT(*) AS n FROM activity_events WHERE account_id=?", account.id],
    ])
      assert.equal(await count(x, query, ...values), 0, query);
    // Kept on purpose: the deletion record, billing records and the hashed invitation budget.
    const [record] = await rows(x, "SELECT * FROM account_deletions");
    assert.equal(record.user_id, "user_alice");
    assert.ok(record.user_deleted_at && record.completed_at);
    assert.equal(
      await count(x, "SELECT COUNT(*) AS n FROM workspace_billing WHERE account_id=?", account.id),
      1,
    );
    assert.equal(
      await count(x, "SELECT COUNT(*) AS n FROM billing_periods WHERE account_id=?", account.id),
      1,
    );
    assert.equal(
      await count(
        x,
        "SELECT COUNT(*) AS n FROM invitation_attempts WHERE account_id=?",
        account.id,
      ),
      1,
    );

    // Bob's organization keeps its history; Alice's agent, link and access there have ended.
    assert.ok(
      JSON.stringify(await x.call("user_bob", "GET", `/v1/servers/${shared.id}/messages`)).includes(
        "Written by Alice's agent for Bob's team",
      ),
    );
    assert.equal((await guest.send("After deletion", true)).error.code, "server_unavailable");
    // What Alice wrote herself stays too, like her agent's messages; she can no longer send there.
    assert.ok(
      JSON.stringify(await x.call("user_bob", "GET", `/v1/servers/${shared.id}/messages`)).includes(
        "Alice herself, for Bob",
      ),
    );
    const late = await x.raw(`/v1/servers/${shared.id}/people/me/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await x.token("user_alice")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ conversationId: personChat, requestKey: randomUUID(), body: "Late" }),
    });
    assert.ok(late.status >= 400, `a deleted person cannot send (${late.status})`);
    // Her person participant stays with its messages under a neutral name, also where her access
    // had already ended; her first name is gone from Bob's servers.
    const people = async (serverId) =>
      (await x.call("user_bob", "GET", `/v1/servers/${serverId}/participants`)).items
        .filter((participant) => participant.kind === "person")
        .map((participant) => participant.name);
    assert.deepEqual(await people(shared.id), ["former-person"]);
    assert.deepEqual(await people(earlier.id), ["former-person-2"]);
    assert.ok(
      JSON.stringify(
        await x.call("user_bob", "GET", `/v1/servers/${earlier.id}/messages`),
      ).includes("Alice herself, earlier"),
    );
    assert.equal(await checkSignal(), 404);
    assert.equal(
      (await rows(x, "SELECT created_by FROM servers WHERE id=?", aliceServer.id))[0].created_by,
      "user_bob",
      "the organization's owner now manages the server Alice created there",
    );
    await x.call("user_bob", "GET", `/v1/servers/${aliceServer.id}/access`);

    // Late provider events and repeated requests change nothing.
    assert.equal((await x.control("sync")).status, 200);
    assert.equal(
      await count(
        x,
        "SELECT COUNT(*) AS n FROM memberships WHERE user_id='user_alice' OR organization_id=?",
        account.organizationId,
      ),
      0,
    );
    assert.deepEqual(
      (await browser("POST", "/v1/me/delete", { confirmation: "anything" })).json.data,
      {
        status: "deleted",
      },
    );
    // A token issued before deletion cannot recreate an organization for the deleted person.
    await x.call(
      "user_alice",
      "POST",
      "/v1/accounts",
      { name: "Again", requestKey: randomUUID() },
      403,
    );
  },
);

test("the preview lists exactly the live servers the person created in organizations other people own", async (t) => {
  const x = await start(t);
  const account = await x.account();
  await x.server(account.id);
  const team = async (owner, name) => {
    const value = await x.call(owner, "POST", "/v1/accounts", { name, requestKey: randomUUID() });
    await x.control("member", x.member(value.organizationId, "user_alice"));
    return value;
  };
  const create = (user, accountId, name) =>
    x.call(user, "POST", `/v1/accounts/${accountId}/servers`, { name, requestKey: randomUUID() });
  const bobs = await team("user_bob", "Bob's team");
  const kept = await create("user_alice", bobs.id, "Research");
  const gone = await create("user_alice", bobs.id, "Old drafts");
  await create("user_bob", bobs.id, "Bob's own");
  await x.call("user_alice", "POST", `/v1/accounts/${bobs.id}/servers/${gone.id}/delete`, {
    confirmation: "Old drafts",
  });
  // A server in an organization Alice has left is no longer hers to delete, so it is not listed.
  const carols = await team("user_carol", "Carol's team");
  await create("user_alice", carols.id, "Left behind");
  await x.control("member", x.member(carols.organizationId, "user_alice", "inactive"));

  const plan = (await (await website(x))("GET", "/v1/me/deletion")).json.data;
  assert.deepEqual(plan.servers, [
    { serverId: kept.id, name: "Research", accountId: bobs.id, organization: "Bob's team" },
  ]);
  assert.equal(plan.memberships, 1);
});

test("an owner whose organization has other members cannot delete their account until they leave it alone", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const server = await x.server(account.id);
  await x.control("member", x.member(account.organizationId));
  const browser = await website(x);
  const plan = (await browser("GET", "/v1/me/deletion")).json.data;
  assert.equal(plan.status, "blocked");
  assert.deepEqual(
    plan.blocked.map(({ accountId, otherMembers }) => ({ accountId, otherMembers })),
    [{ accountId: account.id, otherMembers: 1 }],
  );
  assert.deepEqual(plan.deleted, []);
  const refused = await browser("POST", "/v1/me/delete", {
    confirmation: "user_alice@example.com",
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.code, "account_deletion_blocked");
  assert.match(refused.json.error.message, /Team has other members/);
  // Nothing changed: no intent, no provider call, the server and its access still work.
  assert.equal(await count(x, "SELECT COUNT(*) AS n FROM account_deletions"), 0);
  assert.deepEqual((await identity(x)).users, []);
  assert.equal(
    (await x.call("user_alice", "GET", `/v1/accounts/${account.id}/servers/${server.id}`)).id,
    server.id,
  );

  await x.call("user_alice", "DELETE", `/v1/accounts/${account.id}/members/user_bob`);
  assert.equal((await browser("GET", "/v1/me/deletion")).json.data.status, "ready");
});

test("a deletion interrupted at any step resumes to completion and never leaves an erased account that still signs in", async (t) => {
  const stripe = provider();
  const x = await start(t, { stripeHandler: stripe.handler, manualAlarms: true });
  const account = await x.account();
  const server = await x.server(account.id);
  await (await agent(x, account.organizationId, server.id)).send("Before deletion");
  const subscription = await subscribe(x, stripe, account);
  const browser = await website(x);
  const confirm = () =>
    browser("POST", "/v1/me/delete", { confirmation: "user_alice@example.com" });

  // The identity provider fails: the intent is recorded but nothing is erased, and the person,
  // still signed in, sees an error and can retry.
  await identity(x, { deleteUser: 1 });
  const first = await confirm();
  assert.equal(first.status, 503, JSON.stringify(first.json));
  assert.equal(first.json.error.code, "identity_unavailable");
  const [intent] = await rows(x, "SELECT * FROM account_deletions");
  assert.equal(intent.user_deleted_at, null);
  assert.deepEqual((await identity(x)).users, []);
  assert.equal(stripe.subscriptions.get(subscription.id).status, "active");
  assert.ok((await (await x.control(`deletion?server=${server.id}`)).json()).tables.length > 0);
  assert.equal((await browser("GET", "/v1/me/deletion")).json.data.status, "in_progress");
  // Out of discovery already: the organization cannot be used while deletion is pending.
  await x.call("user_alice", "GET", `/v1/accounts/${account.id}`, undefined, 404);

  // Billing is down after sign-in ends: the person is told it is finishing, not asked to retry.
  stripe.control.down = true;
  const second = await confirm();
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.deepEqual(second.json.data, { status: "finishing" });
  assert.deepEqual((await identity(x)).users, ["user_alice"]);
  assert.equal((await x.control("sync")).status, 500);
  assert.equal((await rows(x, "SELECT completed_at FROM account_deletions"))[0].completed_at, null);

  // Billing recovers, then deleting the WorkOS organization fails once.
  stripe.control.down = false;
  await identity(x, { deleteOrganization: 1 });
  assert.equal((await x.control("sync")).status, 500);
  assert.equal(stripe.subscriptions.get(subscription.id).status, "canceled");
  await empty(x, server.id);
  assert.equal((await rows(x, "SELECT completed_at FROM account_deletions"))[0].completed_at, null);
  assert.equal(
    (await rows(x, "SELECT deletion_completed_at AS done FROM accounts WHERE id=?", account.id))[0]
      .done,
    null,
  );

  assert.equal((await x.control("sync")).status, 200);
  assert.ok((await rows(x, "SELECT completed_at FROM account_deletions"))[0].completed_at);
  assert.deepEqual((await identity(x)).organizations, [account.organizationId]);
  assert.equal(
    stripe.requests.filter((r) => r.method === "DELETE").length,
    1,
    "the subscription is canceled once",
  );
  assert.equal(await count(x, "SELECT COUNT(*) AS n FROM memberships"), 0);
});

test("a guest's deletion removes their guest membership, access and the invitations they accepted; an owner's removes those they sent", async (t) => {
  // With email on, so the invitation and "joined" emails are queued and must go too.
  const x = await start(t, { email: "fake" });
  const account = await x.account();
  const server = await x.server(account.id);
  const invitations = `/v1/servers/${server.id}/invitations`;
  const accepted = await x.call("user_alice", "POST", invitations, {
    email: "user_carol@example.com",
  });
  await x.call("user_carol", "POST", `/v1/invitations/${accepted.invitation.id}/accept`);
  await x.call("user_alice", "POST", invitations, { email: "user_dave@example.com" });
  const guestRows = () =>
    count(x, "SELECT COUNT(*) AS n FROM memberships WHERE user_id='user_carol'");
  assert.equal(await guestRows(), 1);
  const emails = async () =>
    (await rows(x, "SELECT key FROM email_outbox ORDER BY key")).map(
      (row) => row.key.split(":")[0],
    );
  assert.deepEqual(await emails(), ["server_invitation", "server_invitation", "server_joined"]);

  // Carol, a guest with no organization of her own, deletes her account.
  const carol = await website(x, "user_carol");
  const deleted = await carol("POST", "/v1/me/delete", { confirmation: "user_carol@example.com" });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  assert.equal(await guestRows(), 0);
  assert.equal(
    await count(x, "SELECT COUNT(*) AS n FROM server_access WHERE user_id='user_carol'"),
    0,
  );
  assert.deepEqual(
    (await rows(x, "SELECT email_key FROM server_invitations")).map((row) => row.email_key),
    ["user_dave@example.com"],
  );
  // Carol's invitation email and the "joined" email naming her go; Dave's waits.
  assert.deepEqual(await emails(), ["server_invitation"]);
  // Alice's organization and server stay.
  await x.call("user_alice", "GET", `/v1/servers/${server.id}`);

  // Alice deletes hers: the invitations she sent go with it.
  const alice = await website(x);
  const gone = await alice("POST", "/v1/me/delete", { confirmation: "user_alice@example.com" });
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  assert.equal(await count(x, "SELECT COUNT(*) AS n FROM server_invitations"), 0);
  assert.deepEqual(await emails(), []);
});
