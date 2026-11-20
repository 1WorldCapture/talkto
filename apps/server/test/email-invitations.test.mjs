import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/*
  The server invitation emails (docs/email.md, "Server invitations") through the real Worker, D1
  outbox and guest endpoints. The sender is the in-memory fake or the Resend adapter against a fake
  api.resend.com; the harness refuses every other host, so nothing is ever really sent. Every
  address is at example.com.
*/

const setup = async (t, options = {}) => {
  const x = await start(t, { email: "fake", ...options });
  const account = await x.account();
  const server = await x.server(account.id);
  const path = `/v1/servers/${server.id}/invitations`;
  const invite = (email) => x.call("user_alice", "POST", path, { email });
  const resend = (id) => x.call("user_alice", "POST", `${path}/${id}/resend`);
  const cancel = (id) => x.call("user_alice", "DELETE", `${path}/${id}`);
  const accept = (id, user) => x.call(user, "POST", `/v1/invitations/${id}/accept`);
  const sync = async () => {
    const response = await x.control("sync");
    assert.equal(response.status, 200, await response.text());
  };
  const sent = async () =>
    (await (await x.control("email-sent")).json()).flatMap((b) => b.messages);
  const rows = async (where = "1=1") =>
    (await x.db.prepare(`SELECT * FROM email_outbox WHERE ${where} ORDER BY created_at,key`).all())
      .results;
  return { x, account, server, invite, resend, cancel, accept, sync, sent, rows };
};

test("the invitation email goes to the invited address with one Join button; the inviter hears once that they joined", async (t) => {
  const s = await setup(t);
  const sent = await s.invite("User_Carol@Example.com");
  assert.equal(sent.emailed, true, "queued in TalkTo's own email");
  const id = sent.invitation.id;
  const [row] = await s.rows();
  assert.equal(row.key, `server_invitation:${id}:1`);
  assert.equal(row.user_id, id, "the row's person is the invitation; the address is not stored");
  assert.equal(row.kind, "payment", "an account email class every deployed Worker can read");
  assert.equal(row.account_id, s.account.id);
  assert.doesNotMatch(row.payload, /@|carol/i, "no address in the outbox");
  assert.deepEqual(JSON.parse(row.payload), {
    kind: "server_invitation",
    invitationId: id,
    sends: 1,
    server: "Development",
    organization: "Team",
    inviter: "alice",
    expiresAt: sent.invitation.expiresAt,
  });

  await s.sync();
  let messages = await s.sent();
  assert.equal(messages.length, 1);
  const [invitation] = messages;
  assert.equal(invitation.to, "User_Carol@Example.com", "the address as the inviter typed it");
  assert.equal(invitation.from, "TalkTo <notifications@mail.talkto.sh>");
  assert.equal(invitation.kind, "server_invitation");
  assert.equal(invitation.subject, "alice invited you to Development on TalkTo");
  const link = `https://talkto.test/app/join/${id}`;
  const day = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(sent.invitation.expiresAt),
  );
  assert.equal(
    invitation.text,
    [
      "alice invited you to Development, a server in Team on TalkTo.",
      "Sign in, or create your TalkTo account, with this email address. Then you can connect your agents to the server.",
      `Join Development: ${link}`,
      `The invitation expires in 7 days, on ${day}. Only this email address can accept it.`,
      "--",
      "You’re getting this because alice invited this address to a server on TalkTo. If you didn’t expect it, you can ignore this email.",
    ].join("\n\n"),
  );
  assert.equal(
    [...invitation.html.matchAll(/class="action" href="([^"]+)"[^>]*>([^<]+)</g)].map((m) => [
      m[1],
      m[2],
    ]).length,
    1,
    "one button",
  );
  assert.match(invitation.html, new RegExp(`class="action" href="${link}"[^>]*>Join Development<`));
  assert.doesNotMatch(invitation.html, /<img/i);
  assert.deepEqual(invitation.headers, {}, "transactional: no unsubscribe headers");

  // Accepting queues one "joined" email to the inviter; accepting again queues nothing more.
  await s.accept(id, "user_carol");
  await s.accept(id, "user_carol");
  await s.sync();
  await s.sync();
  messages = await s.sent();
  assert.equal(messages.length, 2);
  const joined = messages[1];
  assert.equal(joined.to, "user_alice@example.com");
  assert.equal(joined.kind, "server_joined");
  assert.equal(joined.subject, "carol joined Development");
  const page = `https://talkto.test/app/accounts/${s.account.id}/servers/${s.server.id}`;
  assert.match(joined.text, /^carol accepted your invitation to Development in Team\./);
  assert.ok(joined.text.includes(`Open Development: ${page}`), joined.text);
  const rows = await s.rows(`key='server_joined:${id}'`);
  assert.equal(rows.length, 1, "once per invitation");
  assert.equal(rows[0].user_id, "user_alice");
  assert.equal(rows[0].state, "sent");
});

test("an invitation canceled or expired before the cron runs is never emailed", async (t) => {
  const s = await setup(t);
  const canceled = (await s.invite("user_dave@example.com")).invitation.id;
  const expired = (await s.invite("user_erin@example.com")).invitation.id;
  await s.cancel(canceled);
  await s.x.db
    .prepare("UPDATE server_invitations SET expires_at=? WHERE id=?")
    .bind(new Date(Date.now() - 1000).toISOString(), expired)
    .run();
  await s.sync();
  assert.deepEqual(await s.sent(), []);
  const ended = (await s.rows()).map((row) => [row.user_id, row.state, row.reason]);
  assert.deepEqual(
    ended.sort(),
    [
      [canceled, "skipped", "invitation_closed"],
      [expired, "skipped", "invitation_closed"],
    ].sort(),
  );
});

test("Resend sends a new email under a new key; a resend before the cron supersedes the waiting one", async (t) => {
  const s = await setup(t);
  const id = (await s.invite("user_carol@example.com")).invitation.id;
  await s.sync();
  assert.equal((await s.sent()).length, 1);
  const again = await s.resend(id);
  assert.equal(again.emailed, true);
  assert.equal(again.invitation.sends, 2);
  await s.sync();
  assert.equal((await s.sent()).length, 2, "the resend is a new email");
  // Two resends before the next run: only the latest goes out.
  await s.resend(id);
  await s.resend(id);
  await s.sync();
  const messages = await s.sent();
  assert.equal(messages.length, 3);
  const states = (await s.rows()).map((row) => [row.key, row.state, row.reason]);
  assert.deepEqual(states, [
    [`server_invitation:${id}:1`, "sent", null],
    [`server_invitation:${id}:2`, "sent", null],
    [`server_invitation:${id}:3`, "skipped", "superseded"],
    [`server_invitation:${id}:4`, "sent", null],
  ]);
});

/** A fake api.resend.com that records every batch and accepts it. */
const resendApi = () => {
  const requests = [];
  return {
    requests,
    handler: async (request) => {
      const body = await request.json();
      requests.push({ key: request.headers.get("idempotency-key"), body });
      return Response.json({ data: body.map(() => ({ id: randomUUID() })) });
    },
  };
};
const webhookSecret = `whsec_${randomBytes(32).toString("base64")}`;
const signed = (body) => {
  const id = `msg_${randomUUID().replaceAll("-", "")}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(webhookSecret.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body,
  };
};

test("an address that bounced or complained gets no invitation, even though it has no account", async (t) => {
  const api = resendApi();
  const s = await setup(t, {
    email: "resend",
    resendHandler: api.handler,
    resendWebhookSecret: webhookSecret,
  });
  const event = JSON.stringify({
    type: "email.complained",
    created_at: new Date().toISOString(),
    data: { email_id: randomUUID(), to: ["frank@example.net"], subject: "x" },
  });
  assert.equal((await s.x.raw("/webhooks/resend", signed(event))).status, 200);
  const suppressed = (await s.invite("Frank@Example.net")).invitation.id;
  const delivered = (await s.invite("grace@example.net")).invitation.id;
  await s.sync();
  assert.equal(api.requests.length, 1);
  assert.deepEqual(
    api.requests[0].body.map((email) => [email.to[0], email.tags]),
    [["grace@example.net", [{ name: "kind", value: "server_invitation" }]]],
  );
  const outcome = Object.fromEntries((await s.rows()).map((row) => [row.user_id, row.reason]));
  assert.equal(outcome[suppressed], "suppressed");
  assert.equal(outcome[delivered], null);
});

test("with TALKTO_EMAIL off nothing is queued and the inviter shares the link", async (t) => {
  const s = await setup(t, { email: undefined });
  const sent = await s.invite("user_carol@example.com");
  assert.equal(sent.emailed, false);
  await s.accept(sent.invitation.id, "user_carol");
  await s.sync();
  assert.deepEqual(await s.rows(), []);
});
