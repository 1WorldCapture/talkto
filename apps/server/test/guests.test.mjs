import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";
import { provider } from "./billing-provider.mjs";

/*
  Server guests (docs/dashboard-api.md, "Server guests"): an organization's owner invites someone
  to one server; they accept with the same verified address and see only that server.
*/

/** Alice's organization with one server, and helpers for each guest endpoint. */
const setup = async (t, options = {}) => {
  const x = await start(t, options);
  const account = await x.account();
  const server = await x.server(account.id);
  const path = (serverId = server.id) => `/v1/servers/${serverId}/invitations`;
  const invite = (email, status = 200, serverId = server.id, user = "user_alice") =>
    x.call(user, "POST", path(serverId), { email }, status);
  const list = async (serverId = server.id, user = "user_alice", status = 200) =>
    (await x.call(user, "GET", path(serverId), undefined, status)).items;
  const preview = (id, user, status = 200) =>
    x.call(user, "GET", `/v1/invitations/${id}`, undefined, status);
  const accept = (id, user, status = 200) =>
    x.call(user, "POST", `/v1/invitations/${id}/accept`, undefined, status);
  const resend = (id, status = 200, serverId = server.id) =>
    x.call("user_alice", "POST", `${path(serverId)}/${id}/resend`, undefined, status);
  const cancel = (id, status = 200, serverId = server.id) =>
    x.call("user_alice", "DELETE", `${path(serverId)}/${id}`, undefined, status);
  const shared = (user) => x.call(user, "GET", "/v1/shared");
  const another = (name) => x.server(account.id, { name, requestKey: randomUUID() });
  const expire = (id) =>
    x.db
      .prepare("UPDATE server_invitations SET expires_at=? WHERE id=?")
      .bind(new Date(Date.now() - 1000).toISOString(), id)
      .run();
  return {
    x,
    account,
    server,
    invite,
    list,
    preview,
    accept,
    resend,
    cancel,
    shared,
    another,
    expire,
  };
};
const membersPath = (account) => `/v1/accounts/${account.id}/invitations`;

test("a guest accepts with the invited address and sees only that server", async (t) => {
  const s = await setup(t);
  const { x, account, server } = s;
  const hidden = await s.another("Hidden");

  const sent = await s.invite("  User_Carol@Example.com ");
  assert.match(sent.invitation.id, /^sinv_[a-z2-7]{26}$/);
  assert.equal(sent.link, `https://talkto.test/app/join/${sent.invitation.id}`);
  assert.equal(sent.emailed, false, "no email until TalkTo's own email sends invitations");
  assert.deepEqual(
    {
      email: sent.invitation.email,
      state: sent.invitation.state,
      sends: sent.invitation.sends,
      guest: sent.invitation.guest,
    },
    { email: "User_Carol@Example.com", state: "pending", sends: 1, guest: null },
  );
  const week = Date.parse(sent.invitation.expiresAt) - Date.parse(sent.invitation.createdAt);
  assert.equal(week, 7 * 86400000);
  // A repeat, in any capitals, answers the same invitation and sends nothing.
  const again = await s.invite("user_carol@example.com");
  assert.equal(again.invitation.id, sent.invitation.id);
  assert.equal(again.emailed, false);
  assert.equal(again.invitation.sends, 1);
  assert.deepEqual(
    (await s.list()).map((item) => item.id),
    [sent.invitation.id],
  );
  const id = sent.invitation.id;

  // Someone else holding the link learns only the masked address, never the server's name.
  const wrong = await s.preview(id, "user_bob", 403);
  assert.equal(wrong.error.code, "invitation_email_mismatch");
  assert.equal(wrong.error.sentTo, "U***@E***.com");
  assert.ok(!JSON.stringify(wrong).includes("Development"));
  assert.equal((await s.accept(id, "user_bob", 403)).error.code, "invitation_email_mismatch");
  assert.equal((await s.preview(id, "user_unverified", 403)).error.code, "email_unverified");
  assert.equal((await s.accept(id, "user_unverified", 403)).error.code, "email_unverified");
  const unknown = `sinv_${"a".repeat(26)}`;
  assert.equal((await s.preview(unknown, "user_carol", 404)).error.code, "not_found");

  // Carol sees who invited her, before and after accepting, and nothing yet in her servers.
  const shown = await s.preview(id, "user_carol");
  assert.deepEqual(
    { ...shown, expiresAt: undefined },
    {
      id,
      serverId: server.id,
      serverName: "Development",
      organizationName: "Team",
      inviterName: "alice",
      state: "pending",
      expiresAt: undefined,
    },
  );
  const before = await s.shared("user_carol");
  assert.deepEqual(before.servers, []);
  assert.deepEqual(
    before.invitations.map((item) => item.id),
    [id],
  );
  await x.call("user_carol", "GET", `/v1/servers/${server.id}`, undefined, 404);

  const joined = await s.accept(id, "user_carol");
  assert.equal(joined.server.id, server.id);
  assert.equal(joined.server.name, "Development");
  assert.deepEqual(joined.server.permissions, {
    readMessages: true,
    manageAccess: false,
    resume: false,
  });
  assert.equal(joined.organizationName, "Team");
  assert.equal(joined.inviterName, "alice");
  // Accepting again answers the same.
  assert.deepEqual(await s.accept(id, "user_carol"), joined);
  assert.equal((await s.preview(id, "user_carol")).state, "accepted");

  // Carol reads the server through the same paths as everyone else, and only that server.
  await x.call("user_carol", "GET", `/v1/servers/${server.id}`);
  await x.call("user_carol", "GET", `/v1/servers/${hidden.id}`, undefined, 404);
  assert.deepEqual(
    (await x.call("user_carol", "GET", "/v1/servers")).items.map((item) => item.id),
    [server.id],
  );
  const after = await s.shared("user_carol");
  assert.deepEqual(after.invitations, []);
  assert.deepEqual(
    after.servers.map(({ id, organizationName, permissions }) => ({
      id,
      organizationName,
      permissions,
    })),
    [
      {
        id: server.id,
        organizationName: "Team",
        permissions: { readMessages: true, manageAccess: false, resume: false },
      },
    ],
  );

  // Every organization page stays closed: Carol is not a member of Alice's organization.
  const root = `/v1/accounts/${account.id}`;
  assert.deepEqual((await x.call("user_carol", "GET", "/v1/accounts")).items, []);
  for (const [method, route, value] of [
    ["GET", root],
    ["GET", `${root}/members`],
    ["GET", `${root}/servers`],
    ["GET", `${root}/servers/${server.id}`],
    ["GET", `${root}/dashboard`],
    ["GET", `${root}/invitations`],
    ["POST", `${root}/servers`, { name: "Mine", requestKey: randomUUID() }],
    ["GET", `/v1/servers/${server.id}/access`],
    ["GET", `/v1/servers/${server.id}/invitations`],
  ])
    assert.equal(
      (await x.call("user_carol", method, route, value, 404)).error.code,
      "not_found",
      `${method} ${route}`,
    );

  // Alice sees the arrival; the grant rests on a TalkTo guest membership, not a WorkOS one.
  const [listed] = await s.list();
  assert.equal(listed.state, "accepted");
  assert.ok(listed.acceptedAt);
  assert.deepEqual(listed.guest, { userId: "user_carol", name: "carol", access: "active" });
  const members = await x.call("user_alice", "GET", `${root}/members`);
  assert.ok(members.items.every((member) => member.userId !== "user_carol"));
  const grants = await x.call("user_alice", "GET", `/v1/servers/${server.id}/access`);
  const grant = grants.items.find((item) => item.userId === "user_carol");
  assert.match(grant.membershipId, /^om_guest[0-9a-f]{32}$/);
  const membership = await x.db
    .prepare("SELECT organization_id,status,role FROM memberships WHERE id=?")
    .bind(grant.membershipId)
    .first();
  assert.deepEqual(membership, {
    organization_id: account.organizationId,
    status: "active",
    role: "guest",
  });
  // Someone with access already cannot be invited again.
  assert.equal((await s.invite("user_carol@example.com", 400)).error.code, "invalid_input");
});

test("only the organization's owner invites, to servers they created, after verifying their email", async (t) => {
  const s = await setup(t);
  const { x, account, server } = s;
  await x.control("member", x.member(account.organizationId, "user_bob"));
  // A member who did not create the server sees nothing of its invitations.
  await s.invite("carol@example.com", 404, server.id, "user_bob");
  await s.list(server.id, "user_bob", 404);
  // A member's own server: they manage its access, but only the owner invites guests.
  const bobs = await x.call("user_bob", "POST", `/v1/accounts/${account.id}/servers`, {
    name: "Bob's",
    requestKey: randomUUID(),
  });
  const refused = await s.invite("carol@example.com", 403, bobs.id, "user_bob");
  assert.equal(refused.error.code, "forbidden");
  // Strangers, and the owner on a server they did not create, see nothing.
  await s.invite("carol@example.com", 404, server.id, "user_dave");
  await s.invite("carol@example.com", 404, bobs.id);
  // Never your own address.
  assert.match((await s.invite("USER_ALICE@example.com", 400)).error.message, /own address/);

  // An owner whose email is unverified cannot send invitations.
  const unverified = await x.call("user_unverified", "POST", "/v1/accounts", {
    name: "Unverified",
    requestKey: randomUUID(),
  });
  const theirs = await x.call("user_unverified", "POST", `/v1/accounts/${unverified.id}/servers`, {
    name: "Theirs",
    requestKey: randomUUID(),
  });
  const blocked = await s.invite("carol@example.com", 403, theirs.id, "user_unverified");
  assert.equal(blocked.error.code, "forbidden");
  assert.match(blocked.error.message, /Verify your email/);
  assert.equal((await x.db.prepare("SELECT COUNT(*) AS n FROM server_invitations").first()).n, 0);
});

test("invitations share the Members page's email budgets", async (t) => {
  const s = await setup(t, {
    invitations: { TALKTO_INVITATION_RECIPIENT_COOLDOWN_MINUTES: "10" },
  });
  const sent = await s.invite("carol@example.com");
  // A repeat sends nothing, so it spends no budget.
  await s.invite("carol@example.com");
  const limited = await s.resend(sent.invitation.id, 429);
  assert.equal(limited.error.code, "invitation_limited");
  assert.equal(limited.error.scope, "recipient");
  // The Members page shares the same per-address budget in this organization.
  const members = await s.x.call(
    "user_alice",
    "POST",
    membersPath(s.account),
    { email: "carol@example.com" },
    429,
  );
  assert.equal(members.error.code, "invitation_limited");
  assert.equal(
    (
      await s.x.db
        .prepare("SELECT COUNT(*) AS n FROM invitation_attempts WHERE account_id=?")
        .bind(s.account.id)
        .first()
    ).n,
    1,
  );
});

test("accepting needs the invited address, before expiry, on an open invitation", async (t) => {
  const s = await setup(t);
  const { x, account, server } = s;

  // Different capitals are the same address.
  const carol = await s.invite("USER_CAROL@EXAMPLE.COM");
  assert.equal((await s.accept(carol.invitation.id, "user_carol")).server.id, server.id);

  // Expired: refused, listed as expired, and inviting again renews the same invitation.
  const dave = await s.invite("user_dave@example.com");
  await s.expire(dave.invitation.id);
  assert.equal(
    (await s.accept(dave.invitation.id, "user_dave", 409)).error.code,
    "invitation_unavailable",
  );
  assert.equal(
    (await s.preview(dave.invitation.id, "user_dave", 409)).error.code,
    "invitation_unavailable",
  );
  assert.equal((await s.list()).find((item) => item.id === dave.invitation.id).state, "expired");
  const renewed = await s.invite("user_dave@example.com");
  assert.equal(renewed.invitation.id, dave.invitation.id);
  assert.equal(renewed.invitation.sends, 2);
  assert.equal(renewed.invitation.state, "pending");
  assert.ok(renewed.invitation.expiresAt > dave.invitation.expiresAt);
  await s.accept(dave.invitation.id, "user_dave");

  // Canceled: refused; canceling again answers the same; it can no longer be resent.
  const erin = await s.invite("user_erin@example.com");
  const canceled = await s.cancel(erin.invitation.id);
  assert.equal(canceled.state, "canceled");
  assert.ok(canceled.canceledAt);
  assert.deepEqual(await s.cancel(erin.invitation.id), canceled);
  await s.resend(erin.invitation.id, 400);
  assert.equal(
    (await s.accept(erin.invitation.id, "user_erin", 409)).error.code,
    "invitation_unavailable",
  );
  assert.ok((await s.list()).every((item) => item.id !== erin.invitation.id));
  // Accepted invitations are not canceled.
  await s.cancel(carol.invitation.id, 400);
  // Another server's invitation is not found through this one.
  const other = await s.another("Other");
  await s.cancel(dave.invitation.id, 404, other.id);

  // A server being deleted takes its invitations with it.
  const frank = await s.invite("user_frank@example.com", 200, other.id);
  await x.call("user_alice", "POST", `/v1/accounts/${account.id}/servers/${other.id}/delete`, {
    confirmation: "Other",
  });
  assert.equal(
    (await s.accept(frank.invitation.id, "user_frank", 409)).error.code,
    "invitation_unavailable",
  );
  assert.deepEqual((await s.shared("user_frank")).invitations, []);

  // A member who accepts keeps their own membership for the grant. Alice, Carol, Dave and Bob
  // fill Shop's 4 places; Bob's invitation takes no second one.
  await x.control("member", x.member(account.organizationId, "user_bob"));
  const bob = await s.invite("user_bob@example.com");
  await s.accept(bob.invitation.id, "user_bob");
  const grants = await x.call("user_alice", "GET", `/v1/servers/${server.id}/access`);
  assert.equal(
    grants.items.find((item) => item.userId === "user_bob").membershipId,
    x.member(account.organizationId, "user_bob").id,
  );
  // Bob is a member, so this server is not "shared with" him; it is in his organization.
  assert.deepEqual((await s.shared("user_bob")).servers, []);
  // With his access, inviting him again is refused.
  assert.match((await s.invite("user_bob@example.com", 400)).error.message, /already has access/);
});

test("guests take places in the people limit, once each, and free them when removed or expired", async (t) => {
  // Without a paid plan an organization has Shop's 4 people.
  const s = await setup(t);
  const { x, account, server } = s;
  const second = await s.another("Second");
  const remove = (serverId, user) =>
    x.call("user_alice", "DELETE", `/v1/servers/${serverId}/access/${user}`);
  const full = async (email = "user_zed@example.com") => {
    const refused = await s.invite(email, 409);
    assert.equal(refused.error.code, "people_limit_reached");
    assert.match(refused.error.message, /Shop includes up to 4 people/);
  };
  await x.control("member", x.member(account.organizationId, "user_bob"));
  // Alice and Bob, and Carol invited to two servers: three people.
  const carol = await s.invite("user_carol@example.com");
  const carolSecond = await s.invite("user_carol@example.com", 200, second.id);
  const dave = await s.invite("user_dave@example.com");
  await full();
  // The Members page counts guests too.
  const members = await x.call(
    "user_alice",
    "POST",
    membersPath(account),
    { email: "zed@example.com" },
    409,
  );
  assert.equal(members.error.code, "people_limit_reached");
  // A place freed by canceling is taken again; Carol on a second server never takes another.
  await s.cancel(dave.invitation.id);
  await s.accept(carol.invitation.id, "user_carol");
  await s.accept(carolSecond.invitation.id, "user_carol");
  const erin = await s.invite("user_erin@example.com");
  await full();
  // Removing Carol from one server keeps her place; from her last server frees it.
  await remove(server.id, "user_carol");
  await full();
  await remove(second.id, "user_carol");
  const frank = await s.invite("user_frank@example.com");
  await full();
  // An expired invitation frees its place; renewing it needs one again.
  await s.expire(frank.invitation.id);
  await s.expire(erin.invitation.id);
  await s.invite("user_george@example.com");
  await s.invite("user_frank@example.com");
  const blocked = await s.resend(erin.invitation.id, 409);
  assert.equal(blocked.error.code, "people_limit_reached");
});

test("the Free plan includes only its owner, so it cannot invite guests", async (t) => {
  const s = await setup(t, { metering: true, starter: true, free: true, unpaidServers: 2 });
  const flow = await s.x.browserLogin("user_alice");
  const cookie = (await flow.callback()).headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
  const claim = await s.x.raw(`/v1/accounts/${s.account.id}/starter`, {
    method: "POST",
    headers: { cookie, origin: "https://talkto.test", "content-type": "application/json" },
    body: JSON.stringify({ name: "First", requestKey: randomUUID() }),
  });
  assert.equal(claim.status, 200, await claim.clone().text());
  const refused = await s.invite("user_carol@example.com", 409);
  assert.equal(refused.error.code, "people_limit_reached");
  assert.match(refused.error.message, /^Free includes 1 person/);
});

test("removing a guest ends their agents and signal links; inviting again restores access", async (t) => {
  const s = await setup(t);
  const { x, server } = s;
  const sent = await s.invite("user_carol@example.com");
  await s.accept(sent.invitation.id, "user_carol");
  // Carol's own agent connection, signed in without any organization.
  const credential = await x.mcpToken(undefined, "user_carol");
  const registered = await x.mcp(credential, "register_participant", {
    serverId: server.id,
    name: "Carols-agent",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  const participantId = registered.data.item.id;
  const link = (
    await x.mcp(credential, "create_signal", {
      serverId: server.id,
      participantId,
      channelIds: [registered.data.generalConversationId],
      directChats: "own",
    })
  ).data.url;
  const check = async () => {
    const target = new URL(link);
    const dot = target.pathname.lastIndexOf(".");
    return (
      await x.raw(target.pathname.slice(0, dot), {
        headers: { authorization: `Bearer ${target.pathname.slice(dot + 1)}` },
      })
    ).status;
  };
  assert.equal(await check(), 200);
  await x.mcp(credential, "get_context", { serverId: server.id });

  await x.call("user_alice", "DELETE", `/v1/servers/${server.id}/access/user_carol`);
  const denied = await x.mcp(credential, "get_context", { serverId: server.id }, true);
  assert.equal(denied.error.code, "server_unavailable");
  assert.equal(await check(), 404);
  assert.deepEqual((await s.shared("user_carol")).servers, []);
  assert.equal((await s.list())[0].guest.access, "removed");
  // The old link no longer admits her; the Access dialog cannot grant a non-member either.
  assert.equal(
    (await s.accept(sent.invitation.id, "user_carol", 409)).error.code,
    "invitation_unavailable",
  );
  await x.call("user_alice", "PUT", `/v1/servers/${server.id}/access/user_carol`, undefined, 404);

  // A new invitation brings her back, with the same agent registration.
  const again = await s.invite("user_carol@example.com");
  assert.notEqual(again.invitation.id, sent.invitation.id);
  await s.accept(again.invitation.id, "user_carol");
  const back = await x.mcp(credential, "get_context", { serverId: server.id });
  assert.ok(JSON.stringify(back).includes(participantId), "the same agent registration");
});

test("the guest's own organization never touches the grant; their messages count against the inviter's", async (t) => {
  const s = await setup(t, { metering: true });
  const { x, account, server } = s;
  // Carol has her own organization.
  const hers = await x.call("user_carol", "POST", "/v1/accounts", {
    name: "Carol's",
    requestKey: randomUUID(),
  });
  const sent = await s.invite("user_carol@example.com");
  await s.accept(sent.invitation.id, "user_carol");
  // Changes in Carol's organization reach the event consumer and leave her guest grant alone.
  const own = (
    await x.db
      .prepare("SELECT id FROM memberships WHERE organization_id=? AND user_id='user_carol'")
      .bind(hers.organizationId)
      .first()
  ).id;
  await x.control("member", {
    ...x.member(hers.organizationId, "user_carol", "inactive"),
    id: own,
  });
  assert.equal((await x.control("sync")).status, 200);
  await x.call("user_carol", "GET", `/v1/servers/${server.id}`);
  // Bob's departure from Alice's organization does not touch Carol either.
  await x.control("member", x.member(account.organizationId, "user_bob", "inactive"));
  assert.equal((await x.control("sync")).status, 200);
  await x.call("user_carol", "GET", `/v1/servers/${server.id}`);

  // Carol's agent's message counts against Alice's organization, the server's owner.
  const period = {
    accountId: account.id,
    start: new Date(Date.now() - 60000).toISOString(),
    end: new Date(Date.now() + 3600000).toISOString(),
    allowance: 10,
    overdraft: 0,
  };
  assert.equal((await x.control(`quota/publish?account=${account.id}`, period)).status, 200);
  const root = `/v1/servers/${server.id}`;
  const agent = await x.call("user_carol", "POST", `${root}/participants`, {
    name: "Carols-agent",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  const general = (await x.call("user_carol", "GET", root)).generalConversationId;
  await x.call("user_carol", "POST", `${root}/conversations/${general}/messages`, {
    participantId: agent.item.id,
    requestKey: randomUUID(),
    body: "From Carol's agent",
  });
  assert.equal((await x.control(`resources?server=${server.id}`, "flush")).status, 200);
  assert.equal((await (await x.control(`quota?account=${account.id}`)).json()).used, 1);
  assert.equal((await (await x.control(`quota?account=${hers.id}`)).json()).used ?? 0, 0);
});

test("the minute cron deletes invitations 30 days after they were accepted, canceled or expired", async (t) => {
  const s = await setup(t);
  const { x } = s;
  const old = new Date(Date.now() - 31 * 86400000).toISOString();
  const recent = new Date(Date.now() - 29 * 86400000).toISOString();
  const accepted = await s.invite("user_carol@example.com");
  await s.accept(accepted.invitation.id, "user_carol");
  const canceled = await s.invite("user_dave@example.com");
  await s.cancel(canceled.invitation.id);
  const expired = await s.invite("user_erin@example.com");
  const kept = await s.invite("user_frank@example.com");
  await x.db.batch([
    x.db
      .prepare("UPDATE server_invitations SET accepted_at=? WHERE id=?")
      .bind(old, accepted.invitation.id),
    x.db
      .prepare("UPDATE server_invitations SET canceled_at=? WHERE id=?")
      .bind(old, canceled.invitation.id),
    x.db
      .prepare("UPDATE server_invitations SET expires_at=? WHERE id=?")
      .bind(old, expired.invitation.id),
    x.db
      .prepare("UPDATE server_invitations SET expires_at=? WHERE id=?")
      .bind(recent, kept.invitation.id),
  ]);
  assert.equal((await x.control("sync")).status, 200);
  const left = await x.db.prepare("SELECT id FROM server_invitations ORDER BY id").all();
  assert.deepEqual(
    left.results.map((row) => row.id),
    [kept.invitation.id],
  );
  // The guest keeps her access; only the invitation record is gone.
  await x.call("user_carol", "GET", `/v1/servers/${s.server.id}`);
});

test("a move to Shop counts guests and pending guest invitations", async (t) => {
  const stripe = provider();
  const s = await setup(t, { stripeHandler: stripe.handler, metering: true });
  const { x, account } = s;
  for (const user of ["user_bob", "user_carol"])
    await x.control("member", x.member(account.organizationId, user));
  const billing = `/v1/accounts/${account.id}/billing`;
  const input = { plan: "studio", requestKey: "buy-studio" };
  await x.call("user_alice", "POST", `${billing}/checkout`, input);
  const payment = stripe.complete([...stripe.sessions.keys()][0]);
  // The Studio month ends in 30 minutes, so the scheduled move is checked every minute.
  const shift = 30 * 86400 - 1800;
  payment.invoice.lines.data[0].period.start -= shift;
  payment.invoice.lines.data[0].period.end -= shift;
  payment.subscription.items.data[0].current_period_start -= shift;
  payment.subscription.items.data[0].current_period_end -= shift;
  await x.call("user_alice", "POST", `${billing}/checkout`, input);
  assert.equal((await x.control("sync")).status, 200);
  const move = (requestKey, status = 200) =>
    x.call("user_alice", "POST", `${billing}/plan`, { plan: "shop", requestKey }, status);
  // Three members and one guest fit Shop.
  const dave = await s.invite("user_dave@example.com");
  await s.accept(dave.invitation.id, "user_dave");
  await move("to-shop");
  const { subscription } = await x.call("user_alice", "GET", billing);
  assert.equal(subscription.change.plan, "shop");
  // A pending guest invitation makes five: the move is held, and choosing Shop is refused.
  await s.invite("user_erin@example.com");
  assert.equal((await x.control("sync")).status, 200);
  const kept = await x.call("user_alice", "GET", billing);
  assert.equal(kept.subscription.change, undefined);
  assert.equal(kept.downgradeKept.people, 5);
  assert.equal((await move("again", 409)).error.code, "people_limit_reached");
  // The guest never sees Billing.
  await x.call("user_dave", "GET", billing, undefined, 404);
});
