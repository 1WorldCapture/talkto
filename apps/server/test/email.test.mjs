import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/*
  TalkTo's own email (docs/email.md) through the real Worker, D1 outbox and quota object. The
  sender is the in-memory fake (`TALKTO_EMAIL="fake"`) or the real Resend adapter talking to a fake
  api.resend.com. The harness refuses every other host, so nothing is ever really sent.
*/

const setup = async (t, options = {}) => {
  const x = await start(t, { metering: true, ...options });
  const account = await x.account();
  const server = randomUUID();
  const sync = async () => {
    const response = await x.control("sync");
    assert.equal(response.status, 200, await response.text());
  };
  const sent = async () =>
    (await (await x.control("email-sent")).json()).flatMap((b) => b.messages);
  const rows = (where = "1=1") =>
    x.db.prepare(`SELECT * FROM email_outbox WHERE ${where} ORDER BY key,user_id`).all();
  /** A paid month with `allowance` messages and no cushion, so 100% is reachable. */
  const month = async (allowance) => {
    const response = await x.control(`quota/publish?account=${account.id}`, {
      accountId: account.id,
      start: new Date(Date.now() - 60_000).toISOString(),
      end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      allowance,
      overdraft: 0,
    });
    assert.equal(response.status, 200);
  };
  const spend = async (count) => {
    const response = await x.control(`quota/history?account=${account.id}`, {
      serverId: server,
      count,
    });
    assert.equal(response.status, 200, await response.text());
  };
  const member = (userId) =>
    x.db
      .prepare(
        "INSERT INTO memberships(id,organization_id,user_id,status,role,updated_at) VALUES(?,?,?,'active','member',?)",
      )
      .bind(`om_${randomUUID()}`, account.organizationId, userId, new Date().toISOString())
      .run();
  /** What `pnpm email:announce` writes. */
  const announce = (subject = "New in TalkTo", body = "Agents can rename themselves now.") =>
    x.db
      .prepare(
        "INSERT INTO email_announcements(id,subject,body,state,created_at) VALUES(?,?,?,'queuing',?)",
      )
      .bind(randomUUID(), subject, body, new Date().toISOString())
      .run();
  /** Wait for the quota object's alarm to hand its warnings to the outbox. */
  const queued = async (count) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await rows("kind='allowance'")).results.length >= count) return;
      await sleep(50);
    }
    assert.fail(`expected ${count} queued usage warnings`);
  };
  return { x, account, sync, sent, rows, month, spend, member, announce, queued };
};

test("with TALKTO_EMAIL off nothing is queued or sent, and settings still work", async (t) => {
  const { x, sync, sent, rows, month, spend, announce } = await setup(t);
  await month(100);
  await spend(100);
  await announce();
  await sleep(300);
  await sync();
  await sync();
  assert.equal((await rows()).results.length, 0, "no outbox rows");
  assert.deepEqual(await sent(), []);
  assert.deepEqual(await x.call("user_alice", "GET", "/v1/me/email"), {
    productUpdates: true,
    accountEmails: "always",
  });
});

test("usage warnings fire once at 80% and once at 100% of the allowance", async (t) => {
  const { account, sync, sent, rows, month, spend, queued } = await setup(t, { email: "fake" });
  await month(100);
  await spend(79);
  await sleep(300);
  await sync();
  assert.equal((await rows()).results.length, 0, "79% warns nobody");
  await spend(1);
  await queued(1);
  await spend(5);
  await sync();
  await sync();
  let messages = await sent();
  assert.equal(messages.length, 1, "one 80% email");
  assert.equal(messages[0].to, "user_alice@example.com", "to the organization's owner");
  assert.equal(messages[0].from, "TalkTo <notifications@mail.talkto.sh>");
  assert.match(messages[0].subject, /used 80% of its messages/);
  assert.match(messages[0].text, /has used 80 of its 100 messages this month/);
  assert.match(messages[0].text, new RegExp(`/app/accounts/${account.id}/billing`));
  assert.ok(!("List-Unsubscribe" in messages[0].headers), "account emails have no unsubscribe");
  assert.doesNotMatch(messages[0].html, /<img/i, "no images or tracking pixels");
  await spend(15);
  await queued(2);
  await sync();
  await sync();
  messages = await sent();
  assert.equal(messages.length, 2, "one more email, at 100%");
  assert.match(messages[1].subject, /used all its messages/);
  const states = (await rows()).results.map((row) => [row.key.split(":").at(-1), row.state]);
  assert.deepEqual(states, [
    ["100", "sent"],
    ["80", "sent"],
  ]);
});

test("a jump straight past 100% sends only the 100% email", async (t) => {
  const { sync, sent, month, spend, queued, rows } = await setup(t, { email: "fake" });
  await month(64);
  await spend(64);
  await queued(1);
  await sleep(200);
  await sync();
  const messages = await sent();
  assert.equal(messages.length, 1);
  assert.match(messages[0].subject, /used all its messages/);
  assert.equal((await rows()).results.length, 1);
});

test("a failed renewal emails once, however often it is seen; a later failed renewal emails again", async (t) => {
  const { x, account, sync, sent, rows } = await setup(t, { email: "fake" });
  const subscription = (status) =>
    x.db
      .prepare(
        `INSERT INTO workspace_billing(account_id,provider_scope,customer_id,subscription_id,subscription_json)
         VALUES(?,'test','cus_1','sub_1',?) ON CONFLICT(account_id) DO UPDATE SET subscription_json=excluded.subscription_json`,
      )
      .bind(
        account.id,
        JSON.stringify({ plan: "studio", status, cancelAtPeriodEnd: false, payment: "unpaid" }),
      )
      .run();
  const paidMonth = (start, end) =>
    x.db
      .prepare(
        "INSERT INTO billing_periods(account_id,subscription_id,invoice_id,line_id,plan,plan_version,start,end,allowance) VALUES(?,'sub_1',?,'il_1','studio','2026-11-11',?,?,250000)",
      )
      .bind(account.id, `in_${start}`, start, end)
      .run();
  await subscription("active");
  await paidMonth("2026-10-15T00:00:00.000Z", "2026-11-15T00:00:00.000Z");
  await sync();
  assert.equal((await sent()).length, 0, "an active subscription emails nobody");
  await subscription("past_due");
  await sync();
  await sync();
  await sync();
  let messages = await sent();
  assert.equal(messages.length, 1, "one email for this failed renewal, not one per run or retry");
  assert.match(messages[0].subject, /payment for Team didn’t go through/);
  assert.match(messages[0].text, /Studio plan/);
  assert.match(messages[0].text, /agents can’t send new messages/);
  // Paid again, then the next renewal fails: a new episode, a new email.
  await subscription("active");
  await paidMonth("2026-11-15T00:00:00.000Z", "2026-12-15T00:00:00.000Z");
  await sync();
  await subscription("unpaid");
  await sync();
  await sync();
  messages = await sent();
  assert.equal(messages.length, 2);
  assert.equal((await rows("kind='payment'")).results.length, 2);
});

test("product updates carry a signed one-click unsubscribe that works without signing in", async (t) => {
  const { x, sync, sent, rows, member, announce } = await setup(t, { email: "fake" });
  await member("user_bob");
  await announce("TalkTo 1.2", "## What’s new\n\n- Renames\n- [Read more](https://talkto.sh/docs)");
  await sync();
  await sync();
  let messages = await sent();
  assert.deepEqual(messages.map((m) => m.to).sort(), [
    "user_alice@example.com",
    "user_bob@example.com",
  ]);
  const alice = messages.find((m) => m.to === "user_alice@example.com");
  assert.equal(alice.subject, "TalkTo 1.2");
  assert.match(alice.html, /<a href="https:\/\/talkto.sh\/docs"/);
  assert.equal(alice.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  const link = /^<(https:\/\/talkto\.test\/email\/unsubscribe\?t=([A-Za-z0-9_-]+))>$/.exec(
    alice.headers["List-Unsubscribe"],
  );
  assert.ok(link, alice.headers["List-Unsubscribe"]);
  assert.ok(!link[2].includes("alice"), "the token is opaque");
  assert.ok(alice.text.includes(link[1]), "the visible link is the same one");
  // Visiting asks first; mail scanners that open links change nothing.
  const page = await x.raw(`/email/unsubscribe?t=${link[2]}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Unsubscribe from TalkTo product updates\?/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await x.db.prepare("SELECT * FROM email_preferences").all()).results.length, 0);
  // A tampered token is refused and changes nothing.
  const forged = `${link[2].slice(0, -2)}${link[2].endsWith("AA") ? "BB" : "AA"}`;
  for (const method of ["GET", "POST"]) {
    const refused = await x.raw(`/email/unsubscribe?t=${forged}`, {
      method,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: method === "POST" ? "List-Unsubscribe=One-Click" : undefined,
    });
    assert.equal(refused.status, 400, method);
  }
  // RFC 8058: the mail app POSTs List-Unsubscribe=One-Click, with no cookie or token header.
  const done = await x.raw(`/email/unsubscribe?t=${link[2]}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /You’re unsubscribed/);
  const preference = await x.db.prepare("SELECT * FROM email_preferences").first();
  assert.equal(preference.user_id, "user_alice");
  assert.equal(preference.product_updates, 0);
  assert.equal(preference.source, "one_click");
  assert.equal((await x.call("user_alice", "GET", "/v1/me/email")).productUpdates, false);
  // The next update skips Alice and still reaches Bob.
  await announce("TalkTo 1.3", "More things.");
  await sync();
  await sync();
  messages = (await sent()).filter((m) => m.subject === "TalkTo 1.3");
  assert.deepEqual(
    messages.map((m) => m.to),
    ["user_bob@example.com"],
  );
  assert.equal(
    (await rows("key LIKE 'product_update:%' AND user_id='user_alice'")).results.length,
    1,
    "Alice is not even queued for the second update",
  );
});

test("account settings turn product updates off and on; an unsubscribed person is skipped even if already queued", async (t) => {
  const { x, sync, sent, rows, announce } = await setup(t, { email: "fake" });
  assert.equal((await x.call("user_alice", "GET", "/v1/me/email")).productUpdates, true);
  assert.deepEqual(await x.call("user_alice", "PUT", "/v1/me/email", { productUpdates: false }), {
    productUpdates: false,
    accountEmails: "always",
  });
  await announce();
  await sync();
  assert.deepEqual(await sent(), []);
  assert.deepEqual(await x.call("user_alice", "PUT", "/v1/me/email", { productUpdates: true }), {
    productUpdates: true,
    accountEmails: "always",
  });
  await announce("Second");
  await sync();
  assert.deepEqual(
    (await sent()).map((m) => m.subject),
    ["Second"],
  );
  // Queued, then unsubscribed before the send: the send checks again.
  await x.call("user_alice", "PUT", "/v1/me/email", { productUpdates: true });
  await x.db
    .prepare(
      "INSERT INTO email_announcements(id,subject,body,state,created_at,cursor) VALUES('third','Third','Body','queued',?,'')",
    )
    .bind(new Date().toISOString())
    .run();
  await x.db
    .prepare(
      `INSERT INTO email_outbox(key,user_id,kind,payload,state,created_at) VALUES('product_update:third','user_alice','product_update','{"kind":"product_update","announcementId":"third"}','pending',?)`,
    )
    .bind(new Date().toISOString())
    .run();
  await x.call("user_alice", "PUT", "/v1/me/email", { productUpdates: false });
  await sync();
  assert.equal((await sent()).length, 1);
  assert.equal((await rows("key='product_update:third'")).results[0].state, "skipped");
  assert.equal((await rows("key='product_update:third'")).results[0].reason, "unsubscribed");
});

/** A fake api.resend.com: records every request, answers from `answers` in turn, then succeeds. */
const resend = (answers = []) => {
  const requests = [];
  return {
    requests,
    handler: async (request) => {
      const body = await request.json();
      requests.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        key: request.headers.get("idempotency-key"),
        body,
      });
      const next = answers.shift();
      if (next !== undefined) return next();
      return Response.json({ data: body.map(() => ({ id: randomUUID() })) });
    },
  };
};

test("Resend gets one batch per run with our headers and an idempotency key; an unclear failure is retried under the same key, so nothing is sent twice", async (t) => {
  const api = resend([() => new Response("upstream timeout", { status: 503 })]);
  const { x, sync, rows, member, announce } = await setup(t, {
    email: "resend",
    resendHandler: api.handler,
  });
  await member("user_bob");
  await announce();
  await sync();
  assert.equal(api.requests.length, 1);
  const [first] = api.requests;
  assert.equal(first.url, "https://api.resend.com/emails/batch");
  assert.equal(first.authorization, "Bearer re_test_only_key");
  assert.equal(first.body.length, 2);
  assert.equal(first.body[0].from, "TalkTo <updates@updates.talkto.sh>");
  assert.deepEqual(first.body[0].tags, [{ name: "kind", value: "product_update" }]);
  assert.match(first.body[0].headers["List-Unsubscribe"], /^<https:\/\/talkto\.test\/email\//);
  assert.equal(first.body[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  // A 503 may have sent the batch: the rows stay claimed and are not offered again yet.
  assert.deepEqual(
    (await rows()).results.map((row) => row.state),
    ["sending", "sending"],
  );
  await sync();
  assert.equal(api.requests.length, 1, "no new batch while the outcome is unknown");
  // Ten minutes later the same batch is retried with the same key and the same body.
  await x.db.prepare("UPDATE email_outbox SET claimed_at=claimed_at-660000").run();
  await sync();
  assert.equal(api.requests.length, 2);
  assert.equal(api.requests[1].key, first.key);
  assert.deepEqual(api.requests[1].body, first.body);
  assert.deepEqual(
    (await rows()).results.map((row) => row.state),
    ["sent", "sent"],
  );
  await sync();
  assert.equal(api.requests.length, 2, "nothing more to send");
});

test("a rate limit puts the batch back; a refusal ends it without retrying", async (t) => {
  const api = resend([
    () => Response.json({ name: "rate_limit_exceeded" }, { status: 429 }),
    () => Response.json({ name: "validation_error" }, { status: 422 }),
  ]);
  const { x, sync, rows, announce } = await setup(t, {
    email: "resend",
    resendHandler: api.handler,
  });
  await announce();
  await sync();
  let [row] = (await rows()).results;
  assert.equal(row.state, "pending");
  assert.ok(row.next_attempt_at > Date.now(), "waits before the next try");
  await x.db.prepare("UPDATE email_outbox SET next_attempt_at=0").run();
  await sync();
  [row] = (await rows()).results;
  assert.equal(row.state, "failed");
  assert.equal(row.reason, "refused");
  assert.notEqual(api.requests[0].key, api.requests[1].key, "a released batch gets a new key");
  await sync();
  assert.equal(api.requests.length, 2);
});

test("the daily limit holds sends back until the next day", async (t) => {
  const { sync, sent, rows, announce } = await setup(t, { email: "fake", emailDailyLimit: 0 });
  await announce();
  await sync();
  assert.deepEqual(await sent(), []);
  assert.equal((await rows()).results[0].state, "pending");
});

const webhookSecret = `whsec_${randomBytes(32).toString("base64")}`;
const signed = (
  body,
  { secret = webhookSecret, id = `msg_${randomUUID().replaceAll("-", "")}`, at } = {},
) => {
  const timestamp = String(at ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
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

test("a signed Resend bounce or complaint stops every later email to that address", async (t) => {
  const api = resend();
  const { x, sync, rows, member, announce } = await setup(t, {
    email: "resend",
    resendHandler: api.handler,
    resendWebhookSecret: webhookSecret,
  });
  await member("user_bob");
  const event = (type, to) =>
    JSON.stringify({
      type,
      created_at: new Date().toISOString(),
      data: { email_id: randomUUID(), to: [to], subject: "x" },
    });
  // Unsigned, wrongly signed and stale deliveries change nothing.
  const body = event("email.bounced", "user_alice@example.com");
  for (const init of [
    { method: "POST", headers: { "content-type": "application/json" }, body },
    signed(body, { secret: `whsec_${randomBytes(32).toString("base64")}` }),
    signed(body, { at: Math.floor(Date.now() / 1000) - 3600 }),
  ])
    assert.equal((await x.raw("/webhooks/resend", init)).status, 400);
  assert.equal((await x.db.prepare("SELECT * FROM email_suppressions").all()).results.length, 0);
  const accepted = await x.raw("/webhooks/resend", signed(body));
  assert.equal(accepted.status, 200);
  const replay = await x.raw("/webhooks/resend", signed(body));
  assert.equal(replay.status, 200);
  const delivered = await x.raw(
    "/webhooks/resend",
    signed(event("email.delivered", "user_bob@example.com")),
  );
  assert.equal(delivered.status, 200, "other events are acknowledged and ignored");
  const suppressions = (await x.db.prepare("SELECT * FROM email_suppressions").all()).results;
  assert.equal(suppressions.length, 1);
  assert.equal(suppressions[0].reason, "bounced");
  assert.doesNotMatch(suppressions[0].address_key, /@|alice/, "only a keyed hash is stored");
  await announce();
  await sync();
  assert.deepEqual(
    api.requests.flatMap((request) => request.body.map((email) => email.to[0])),
    ["user_bob@example.com"],
  );
  const alice = (await rows("user_id='user_alice'")).results[0];
  assert.equal(alice.state, "skipped");
  assert.equal(alice.reason, "suppressed");
});

test("pnpm email:announce writes exactly the Markdown it was given, counts the right people and can cancel", async (t) => {
  const { parse, announceSql, recipientsSql, cancelSql, optOut } =
    await import("../tools/email-announce.mjs");
  assert.equal(optOut(), true, "product updates are opt-out (productUpdatesByDefault)");
  assert.deepEqual(parse("No heading\n\nBody").problems, [
    "The first line must be the subject, as `# Subject`.",
  ]);
  assert.match(parse("# Hi\n\n![x](https://a/b.png)").problems.join(), /Images/);
  const file = parse('# It’s here; finally\n\nLine one\'s "quoted";\n\n- a\n- b\n');
  assert.deepEqual(file.problems, []);
  const { x, sync, sent, member } = await setup(t, { email: "fake" });
  await member("user_bob");
  await x.call("user_bob", "PUT", "/v1/me/email", { productUpdates: false });
  assert.equal((await x.db.prepare(recipientsSql(true)).first()).recipients, 1);
  const id = randomUUID();
  await x.db.prepare(announceSql(id, file.subject, file.body, new Date().toISOString())).run();
  // A second one waits until the first has been queued.
  await x.db.prepare(announceSql(randomUUID(), "Other", "Body", new Date().toISOString())).run();
  const stored = (await x.db.prepare("SELECT * FROM email_announcements").all()).results;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].subject, "It’s here; finally");
  assert.equal(stored[0].body, 'Line one\'s "quoted";\n\n- a\n- b');
  await sync();
  const [message] = await sent();
  assert.equal(message.subject, "It’s here; finally");
  assert.match(message.html, /<li style="margin:0 0 6px">a<\/li>/);
  for (const statement of cancelSql(id)) await x.db.prepare(statement).run();
  assert.equal(
    (await x.db.prepare("SELECT state FROM email_announcements WHERE id=?").bind(id).first()).state,
    "canceled",
  );
  assert.throws(() => cancelSql("x'; DROP TABLE accounts; --"), /announcement ID/);
});
