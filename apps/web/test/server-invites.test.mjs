import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createVite } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { start } from "../../server/test/platform-harness.mjs";

/*
  Inviting someone to one server from its page (src/server-invites.tsx): the words the inviter
  reads, the people limit by plan, how arrivals are matched to invitations through
  `Participant.registeredBy`, when the page keeps asking, and the guest errors the client decodes.
*/

const load = async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  return {
    copy: await vite.ssrLoadModule("/src/invite-copy.ts"),
    invites: await vite.ssrLoadModule("/src/server-invites.tsx"),
    api: await vite.ssrLoadModule("/src/api.ts"),
    join: await vite.ssrLoadModule("/src/join.tsx"),
    agentTypes: await vite.ssrLoadModule("@talkto/api/agent-types"),
    session: await vite.ssrLoadModule("/src/session.tsx"),
  };
};

const at = (minutes) => new Date(Date.parse("2026-11-18T12:00:00.000Z") + minutes * 60_000);
const iso = (minutes) => at(minutes).toISOString();
const invitation = (id, state, extra = {}) => ({
  id: `sinv_${id.padEnd(26, "a")}`,
  serverId: "9a1f7c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b",
  email: `${id}@example.com`,
  state,
  createdAt: iso(-60),
  sentAt: iso(-60),
  sends: 1,
  expiresAt: iso(7 * 24 * 60),
  acceptedAt: null,
  canceledAt: null,
  guest: null,
  ...extra,
});
const accepted = (id, userId, minutes, name = "Alex Rivera", access = "active") =>
  invitation(id, "accepted", { acceptedAt: iso(minutes), guest: { userId, name, access } });
const agent = (id, userId, minutes, extra = {}) => {
  const item = {
    id,
    name: `${id}-laptop`,
    agentType: "claude-code",
    workingDirectory: null,
    joinedNote: null,
    createdAt: iso(minutes),
    messageCount: 0,
    lastMessageAt: null,
    ...extra,
  };
  if (userId !== null) item.registeredBy = { userId };
  return item;
};

/** Plain words: sentence case, no exclamation marks, no jargon. */
const plain = (text) => {
  assert.doesNotMatch(text, /!/);
  assert.doesNotMatch(text, /\b(guest grant|membership|token|principal|WorkOS|API)\b/i);
};

test("the inviter reads plainly whether an email went out, when links expire and what the limit is", async (t) => {
  const { copy, invites } = await load(t);
  assert.equal(copy.guestInvited("dana@example.com", true), "Invitation sent to dana@example.com.");
  assert.equal(
    copy.guestInvited("dana@example.com", false),
    "Invitation ready for dana@example.com. Copy the link and send it yourself.",
  );
  assert.doesNotMatch(copy.guestInvited("dana@example.com", false), /sent/);
  assert.equal(copy.guestLinkRule("dana@example.com"), "The link works only for dana@example.com.");

  const now = at(0);
  assert.equal(copy.guestExpiry(iso(7 * 24 * 60), now), "Expires in 7 days");
  assert.equal(copy.guestExpiry(iso(36 * 60), now), "Expires in 2 days");
  assert.equal(copy.guestExpiry(iso(25 * 60), now), "Expires in 1 day");
  assert.equal(copy.guestExpiry(iso(5 * 60 + 30), now), "Expires in 5 hours");
  assert.equal(copy.guestExpiry(iso(61), now), "Expires in 1 hour");
  assert.equal(copy.guestExpiry(iso(20), now), "Expires in less than an hour");
  assert.equal(copy.guestExpiry(iso(-1), now), "Expired. Resend to renew it.");

  assert.deepEqual(copy.guestPeopleLimit("Shop", 4), {
    text: "Shop includes 4 people.",
    action: "Move to Studio to invite more →",
  });
  assert.deepEqual(copy.guestPeopleLimit("Free", 4), {
    text: "Free includes only you.",
    action: "Choose a plan to invite people →",
  });
  assert.equal(invites.toolName("claude-code"), "Claude Code");
  assert.equal(invites.toolName("codex-desktop"), "Codex Desktop");
  assert.equal(
    invites.joinLink("https://talkto.test", "sinv_x"),
    "https://talkto.test/app/join/sinv_x",
  );
  for (const text of [
    copy.guestInviteScope,
    copy.serverAccessScope,
    copy.guestLinksRule,
    copy.guestInvited("a@example.com", true),
    copy.guestInvited("a@example.com", false),
    ...Object.values(copy.guestPeopleLimit("Shop", 4)),
    ...Object.values(copy.guestPeopleLimit("Free", 4)),
  ])
    plain(text);
});

test("giving someone a server says they can read all of it, history included", async (t) => {
  const { copy } = await load(t);
  assert.equal(
    copy.serverReadScope,
    "They can read every TalkTo channel and chat on this server, including earlier messages.",
  );
  for (const scope of [copy.guestInviteScope, copy.serverAccessScope]) {
    assert.ok(scope.includes(copy.serverReadScope), scope);
    assert.doesNotMatch(scope, /private/i);
  }
  // The guest's join page says the same to the guest.
  assert.equal(
    copy.joinedReadScope,
    "You can read every TalkTo channel and chat on this server, including earlier messages.",
  );
  // Organization invitations give no server, so they say nothing about reading one.
  for (const scope of [copy.inviteScope, copy.accessInviteScope])
    assert.doesNotMatch(scope, /read/i);
});

test("the people limit names Free only with no paid period or trial where the Free plan exists", async (t) => {
  const { invites } = await load(t);
  const usage = { asOf: iso(0), periodStart: iso(-60) };
  const unpaid = { paidPeriod: null, trial: null, usage };
  const paid = { ...unpaid, paidPeriod: { plan: "shop", start: iso(-60), end: iso(60) } };
  const trial = {
    ...unpaid,
    trial: { status: "active", start: iso(-60), end: iso(60), allowance: 500 },
  };
  const free = { free: { messages: 2000, servers: 1, historyDays: 30 } };
  assert.equal(invites.limitPlan(unpaid, free), "Free");
  assert.equal(invites.limitPlan(paid, free), "Shop");
  assert.equal(invites.limitPlan(trial, free), "Shop");
  assert.equal(invites.limitPlan(unpaid, {}), "Shop");
  assert.equal(invites.limitPlan(undefined, free), "Shop", "until billing loads, the Shop line");
});

test("arrivals match accepted invitations to agents their guest registered after accepting", async (t) => {
  const { invites } = await load(t);
  const alex = accepted("alex", "user_alex", 0);
  const gone = accepted("gone", "user_gone", 5, "Sam", "removed");
  const nameless = accepted("pat", "user_pat", 1, null);
  const lines = invites.arrivals(
    [invitation("dana", "pending"), alex, gone, nameless],
    [
      agent("a1", "user_alex", 10),
      agent("a2", "user_alex", 20, { agentType: "codex-cli", name: "build-box" }),
      // Registered before this invitation was accepted (an earlier stay): not a new arrival.
      agent("a0", "user_alex", -30),
      // Someone else's agent, Alex's own person participant, and a removed agent.
      agent("b1", "user_bob", 15),
      agent("p1", "user_alex", 25, { kind: "person" }),
      agent("r1", "user_alex", 30, { removedAt: iso(31) }),
      // Registered over local access: no person to match.
      agent("l1", null, 12),
      agent("s1", "user_gone", 40),
    ],
  );
  assert.deepEqual(
    lines.map((line) => [line.text, line.detail]),
    [
      ["Alex Rivera’s Codex CLI joined", "build-box"],
      ["Alex Rivera’s Claude Code joined", "a1-laptop"],
      ["pat@example.com joined", null],
      ["Alex Rivera joined", null],
    ],
  );
  for (const line of lines) plain(line.text);
});

test("the server page names an arrival in the same words as the Invite dialog, without a ·", async (t) => {
  const { invites } = await load(t);
  const carol = accepted("carol", "user_carol", 0, "carol");
  const [latest] = invites.arrivals([carol], [agent("c1", "user_carol", 10)]);
  assert.equal(latest.text, "carol’s Claude Code joined");
  const text = (html) =>
    html
      .replace(/<[^>]+>/g, "\n")
      .split("\n")
      .filter(Boolean);
  const header = text(
    renderToStaticMarkup(createElement(invites.LatestArrival, { arrival: latest, open: () => {} })),
  );
  const dialog = text(
    renderToStaticMarkup(createElement(invites.JoinedList, { arrived: [latest] })),
  );
  assert.deepEqual(header, ["carol’s Claude Code joined"]);
  assert.equal(dialog[1], header[0], "the dialog's Joined line reads like the header");
});

test("every agent type reads as a plain tool name in an arrival", async (t) => {
  const { invites, agentTypes } = await load(t);
  for (const entry of agentTypes.agentTypes) {
    const name = invites.toolName(entry.type);
    assert.doesNotMatch(name, /·/, entry.type);
    assert.doesNotMatch(name, /\s{2}|^\s|\s$/, entry.type);
  }
  assert.equal(invites.toolName("continue"), "Continue");
  assert.equal(invites.toolName("github-copilot-cli"), "GitHub Copilot CLI");
});

test("the join page lists only the agents the signed-in person connected since it opened", async (t) => {
  const { join } = await load(t);
  const before = new Set(["old"]);
  const listed = join.newAgents(
    [
      agent("old", "user_carol", -10),
      agent("mine", "user_carol", 10),
      // Another person's agent, one registered over local access, carol's own person
      // participant and an agent removed since: none is hers to see arrive.
      agent("theirs", "user_alice", 11),
      agent("local", null, 12),
      agent("self", "user_carol", 13, { kind: "person" }),
      agent("gone", "user_carol", 14, { removedAt: iso(15) }),
    ],
    before,
    "user_carol",
  );
  assert.deepEqual(
    listed.map((item) => item.id),
    ["mine"],
  );
  assert.deepEqual(join.newAgents([agent("theirs", "user_alice", 11)], before, "user_carol"), []);
});

test("the page keeps asking every 10 seconds only while someone has yet to arrive", async (t) => {
  const { invites } = await load(t);
  const now = Date.parse(iso(30));
  assert.equal(invites.pollMs, 10_000);
  assert.equal(invites.awaiting([invitation("dana", "pending")], [], now), true);
  assert.equal(invites.awaiting([invitation("eve", "expired")], [], now), false);
  assert.equal(invites.awaiting([], [], now), false);
  const alex = accepted("alex", "user_alex", 0);
  assert.equal(invites.awaiting([alex], [], now), true, "accepted, no agent yet");
  assert.equal(invites.awaiting([alex], undefined, now), true, "agents not read yet");
  assert.equal(invites.awaiting([alex], [agent("a1", "user_alex", 10)], now), false);
  assert.equal(invites.awaiting([alex], [], Date.parse(iso(120))), false, "after an hour");
  const removed = accepted("sam", "user_sam", 0, "Sam", "removed");
  assert.equal(invites.awaiting([removed], [], now), false);
});

test("through the website, a guest's agent arrives and guest refusals keep their own codes", async (t) => {
  const app = await start(t);
  const { invites, api: client, session } = await load(t);
  const account = await app.account();
  const server = await app.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const sent = await app.call("user_alice", "POST", `${root}/invitations`, {
    email: "user_carol@example.com",
  });

  // The dashboard's client, as a given person; Bob is not the invited address.
  let as = "user_bob";
  const proxy = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await app.raw(req.url, {
      method: req.method,
      headers: {
        authorization: `Bearer ${await app.token(as)}`,
        "content-type": "application/json",
      },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    proxy.closeAllConnections();
    proxy.close();
  });
  const api = client.createApi(`http://127.0.0.1:${proxy.address().port}`);
  const accept = () =>
    client.request(api.guests.acceptInvitation({ params: { invitationId: sent.invitation.id } }));
  const mismatch = await accept().then(
    () => assert.fail("Bob is not the invited address"),
    (error) => error,
  );
  assert.ok(mismatch instanceof client.ApiError);
  assert.equal(mismatch.code, "invitation_email_mismatch");
  assert.match(mismatch.sentTo, /^u\*+@e\*+\.com$/);
  as = "user_carol";
  await accept();

  // Carol's view of the shared server never asks for the organization: a refused account read
  // clears every query under that organization, her shared view's included.
  const shared = await app.call("user_carol", "GET", "/v1/shared");
  const guestServer = shared.servers.find((item) => item.id === server.id);
  assert.equal(guestServer.permissions.manageAccess, false);
  const carol = session.createServices(`http://127.0.0.1:${proxy.address().port}`);
  t.after(() => carol.queries.clear());
  const read = invites.inviterAccountQuery(carol.api, "user_carol", account.id, guestServer);
  assert.equal(read.enabled, false);
  assert.equal(
    invites.inviterAccountQuery(carol.api, "user_alice", account.id, {
      permissions: { ...guestServer.permissions, manageAccess: true },
    }).enabled,
    true,
    "the owner who manages access reads it",
  );
  const feed = ["human", "user_carol", account.id, server.id, "feed"];
  carol.queries.setQueryData(feed, { kept: true });
  // Why it must stay off: forced anyway, the refusal empties the shared view's feed.
  await carol.queries.fetchQuery({ ...read, retry: false }).then(
    () => assert.fail("a guest cannot read the organization"),
    (error) => assert.equal(error.code, "not_found"),
  );
  assert.equal(carol.queries.getQueryData(feed), undefined);
  // Dave's invitation was canceled before he opened it.
  const dave = await app.call("user_alice", "POST", `${root}/invitations`, {
    email: "user_dave@example.com",
  });
  await app.call("user_alice", "DELETE", `${root}/invitations/${dave.invitation.id}`);
  as = "user_dave";
  const unavailable = await client
    .request(api.guests.acceptInvitation({ params: { invitationId: dave.invitation.id } }))
    .then(
      () => assert.fail("a canceled invitation"),
      (error) => error,
    );
  assert.equal(unavailable.code, "invitation_unavailable");

  // Carol's agent, read back as the website reads it.
  const carols = await app.mcpToken(undefined, "user_carol");
  await app.mcp(carols, "register_participant", {
    serverId: server.id,
    name: "carol-laptop",
    agentType: "claude-code",
    requestKey: randomUUID(),
  });
  const flow = await app.browserLogin("user_alice");
  const cookie = (await flow.callback()).headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
  const website = async (path) =>
    (await (await app.raw(path, { headers: { cookie, origin: "https://talkto.test" } })).json())
      .data;
  const listed = await website(`${root}/invitations`);
  const participants = await website(`${root}/participants?limit=100`);
  const lines = invites.arrivals(listed.items, participants.items).map((line) => line.text);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^.+’s Claude Code joined$/);
  assert.match(lines[1], /^.+ joined$/);
  assert.equal(invites.awaiting(listed.items, participants.items), false);
});
