import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/** Invitation email budgets on the real Worker/D1 path, in front of a recording identity fake. */
const setup = async (t, invitations = "defaults") => {
  const x = await start(t, { invitations });
  const send = (accountId, email, status = 200, user = "user_alice") =>
    x.call(user, "POST", `/v1/accounts/${accountId}/invitations`, { email }, status);
  const resend = (accountId, id, status = 200) =>
    x.call(
      "user_alice",
      "POST",
      `/v1/accounts/${accountId}/invitations/${id}/resend`,
      undefined,
      status,
    );
  /** Send, then cancel so Shop's people limit never interferes with the budget under test. */
  const sendAndCancel = async (accountId, email) => {
    const sent = await send(accountId, email);
    await x.call("user_alice", "DELETE", `/v1/accounts/${accountId}/invitations/${sent.id}`);
  };
  const deliveries = async () => (await x.control("invitation-deliveries")).json();
  /** Move every recorded attempt back in time, as if minutes had passed. */
  const age = (minutes) =>
    x.db
      .prepare(
        "UPDATE invitation_attempts SET attempted_at=strftime('%Y-%m-%dT%H:%M:%fZ',attempted_at,?)",
      )
      .bind(`-${minutes} minutes`)
      .run();
  const nextMidnight = () => {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    ).toISOString();
  };
  const paid = async (accountId, end = "2099-01-01T00:00:00.000Z") => {
    await x.db
      .prepare(
        "INSERT INTO workspace_billing(account_id,provider_scope) VALUES(?,'test') ON CONFLICT DO NOTHING",
      )
      .bind(accountId)
      .run();
    await x.db
      .prepare(
        "INSERT INTO billing_periods(account_id,subscription_id,invoice_id,line_id,plan,plan_version,start,end,allowance) VALUES(?,?,?,'line','studio','test','2020-01-01T00:00:00.000Z',?,250000)",
      )
      .bind(accountId, randomUUID(), randomUUID(), end)
      .run();
  };
  return { x, send, sendAndCancel, resend, deliveries, age, nextMidnight, paid };
};

test("one address gets one invitation email per cooldown and three per day, scoped to the organization", async (t) => {
  const { x, send, resend, deliveries, age, nextMidnight } = await setup(t);
  const account = await x.account();
  const invitation = await send(account.id, "invitee@example.com");
  const before = Date.now();
  const response = await x.raw(`/v1/accounts/${account.id}/invitations/${invitation.id}/resend`, {
    method: "POST",
    headers: { authorization: `Bearer ${await x.token("user_alice")}` },
  });
  const refused = await response.json();
  assert.equal(response.status, 429, JSON.stringify(refused));
  assert.equal(refused.error.code, "invitation_limited");
  assert.equal(refused.error.scope, "recipient");
  assert.equal(refused.error.action, "retry_after");
  assert.doesNotMatch(refused.error.message, /fraud|abuse|suspicious|spam/i);
  const wait = Date.parse(refused.error.retryAt) - before;
  assert.ok(wait > 9 * 60_000 && wait <= 10 * 60_000, refused.error.retryAt);
  assert.equal(response.headers.get("retry-after"), String(refused.error.retryAfterSeconds));
  assert.ok(refused.error.retryAfterSeconds > 540 && refused.error.retryAfterSeconds <= 600);
  assert.deepEqual(await deliveries(), { sent: 1, resent: 0 }, "Refusal sends nothing");
  // Sending the same address again is held by the same cooldown, case-insensitively.
  assert.equal((await send(account.id, "Invitee@Example.com", 429)).error.scope, "recipient");
  // Another organization's attempts never limit this one.
  const other = await x.account();
  await send(other.id, "invitee@example.com");
  await age(11);
  await resend(account.id, invitation.id);
  await age(11);
  await resend(account.id, invitation.id);
  assert.deepEqual(await deliveries(), { sent: 2, resent: 2 });
  await age(11);
  const daily = await resend(account.id, invitation.id, 429);
  assert.equal(daily.error.scope, "recipient");
  assert.equal(daily.error.retryAt, nextMidnight());
  // Raw addresses never reach the budget table.
  const keys = await x.db.prepare("SELECT recipient_key AS key FROM invitation_attempts").all();
  assert.ok(keys.results.every((row) => /^[0-9a-f]{64}$/.test(row.key)));
});

test("an unpaid organization sends ten invitation emails per owner each UTC day", async (t) => {
  const { x, send, sendAndCancel, deliveries, nextMidnight } = await setup(t);
  const account = await x.account();
  for (let i = 0; i < 10; i++) await sendAndCancel(account.id, `person${i}@example.com`);
  const refused = await send(account.id, "eleventh@example.com", 429);
  assert.equal(refused.error.scope, "organization");
  assert.equal(refused.error.retryAt, nextMidnight());
  assert.match(refused.error.message, /paid plan can send more/);
  assert.deepEqual(await deliveries(), { sent: 10, resent: 0 });
});

test("racing invitations cannot pass the daily budget together", async (t) => {
  const { x, deliveries, paid } = await setup(t, { TALKTO_INVITATION_PAID_DAILY_LIMIT: "10" });
  // Studio has no people limit, so only the email budget decides.
  const account = await x.account();
  await paid(account.id);
  const token = await x.token("user_alice");
  const statuses = await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      x
        .raw(`/v1/accounts/${account.id}/invitations`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ email: `racer${i}@example.com` }),
        })
        .then((response) => response.status),
    ),
  );
  assert.equal(statuses.filter((status) => status === 200).length, 10, statuses.join());
  assert.equal(statuses.filter((status) => status === 429).length, 6, statuses.join());
  assert.equal((await deliveries()).sent, 10);
});

test("unpaid organizations share a daily total; confirmed paid organizations have their own budget", async (t) => {
  const { x, send, paid } = await setup(t, {
    TALKTO_INVITATION_UNPAID_DAILY_LIMIT: "2",
    TALKTO_INVITATION_UNPAID_TOTAL_DAILY_LIMIT: "3",
    TALKTO_INVITATION_PAID_DAILY_LIMIT: "4",
    TALKTO_INVITATION_RECIPIENT_COOLDOWN_MINUTES: "10",
  });
  const first = await x.account();
  const second = await x.account();
  await send(first.id, "a@example.com");
  await send(first.id, "b@example.com");
  await send(second.id, "c@example.com");
  const shared = await send(second.id, "d@example.com", 429);
  assert.equal(shared.error.scope, "unpaid_total");
  assert.doesNotMatch(shared.error.message, /fraud|abuse|suspicious|spam/i);
  // A period that has ended is not confirmed paid access now.
  const lapsed = await x.account();
  await paid(lapsed.id, "2021-01-01T00:00:00.000Z");
  assert.equal((await send(lapsed.id, "e@example.com", 429)).error.scope, "unpaid_total");
  const studio = await x.account();
  await paid(studio.id);
  await send(studio.id, "f@example.com");
  // Recipient cooldowns apply to paid organizations too.
  assert.equal((await send(studio.id, "f@example.com", 429)).error.scope, "recipient");
  for (const email of ["g@example.com", "h@example.com", "i@example.com"])
    await send(studio.id, email);
  const full = await send(studio.id, "j@example.com", 429);
  assert.equal(full.error.scope, "organization");
  assert.doesNotMatch(full.error.message, /paid plan/);
});

test("an attempt the provider rejects still spends the budget", async (t) => {
  const { x, send, deliveries } = await setup(t, { TALKTO_INVITATION_UNPAID_DAILY_LIMIT: "2" });
  const account = await x.account();
  await send(account.id, "first@example.com");
  // The provider rejects a duplicate pending invitation; the attempt still counted.
  await send(account.id, "first@example.com", 400);
  assert.equal((await send(account.id, "second@example.com", 429)).error.scope, "organization");
  assert.equal((await deliveries()).sent, 1);
  const rows = await x.db.prepare("SELECT COUNT(*) AS n FROM invitation_attempts").first();
  assert.equal(rows.n, 2);
});

test("only an owner with a verified email can send invitations", async (t) => {
  const { x, send, deliveries } = await setup(t);
  const owned = await x.call("user_unverified", "POST", "/v1/accounts", {
    name: "Team",
    requestKey: randomUUID(),
  });
  const refused = await send(owned.id, "someone@example.com", 403, "user_unverified");
  assert.match(refused.error.message, /Verify your email/);
  assert.equal((await deliveries()).sent, 0);
  const rows = await x.db.prepare("SELECT COUNT(*) AS n FROM invitation_attempts").first();
  assert.equal(rows.n, 0);
});

test("misconfigured invitation budgets pause invitations instead of removing limits", async (t) => {
  const { x, send, deliveries } = await setup(t, {
    TALKTO_INVITATION_UNPAID_DAILY_LIMIT: "50",
    TALKTO_INVITATION_UNPAID_TOTAL_DAILY_LIMIT: "10",
  });
  const account = await x.account();
  assert.equal(
    (await send(account.id, "someone@example.com", 503)).error.code,
    "storage_unavailable",
  );
  assert.equal((await deliveries()).sent, 0);
});

test("onboarding's invitation uses the same budget and releases its request when refused", async (t) => {
  const { x, send } = await setup(t);
  const account = await x.account();
  const server = await x.server(account.id);
  await send(account.id, "teammate@example.com");
  const path = "/v1/onboarding";
  let state = await x.call("user_alice", "GET", path);
  const command = (value, status = 200) =>
    x.call("user_alice", "POST", path, { command: { ...value, revision: state.revision } }, status);
  state = await command({ kind: "use_server", accountId: account.id, serverId: server.id });
  state = await command({ kind: "step", step: "share" });
  const refused = await command({ kind: "invite", email: "teammate@example.com" }, 429);
  assert.equal(refused.error.code, "invitation_limited");
  assert.equal(refused.error.scope, "recipient");
  state = await x.call("user_alice", "GET", path);
  assert.equal(state.run.invitation, null, "Nothing was sent, so the person can try again later");
});
