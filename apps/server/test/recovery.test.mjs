import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

test("offline fixture restore retains history, revoked access and spent quota, and rebuilds derived search", async (t) => {
  const x = await start(t, { metering: true, manualAlarms: true });
  const account = await x.account();
  const server = await x.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const participant = (
    await x.call("user_alice", "POST", `${root}/participants`, {
      name: "Recovery",
      agentType: "codex",
      requestKey: randomUUID(),
    })
  ).item;
  const general = (await x.call("user_alice", "GET", root)).generalConversationId;
  const period = {
    accountId: account.id,
    start: new Date(Date.now() - 60000).toISOString(),
    end: new Date(Date.now() + 3600000).toISOString(),
    allowance: 2,
    overdraft: 0,
  };
  assert.equal((await x.control(`quota/publish?account=${account.id}`, period)).status, 200);
  await x.control("member", x.member(account.organizationId));
  await x.call("user_alice", "PUT", `${root}/access/user_bob`);
  await x.call("user_bob", "GET", root);
  const send = (key, status = 200) =>
    x.call(
      "user_alice",
      "POST",
      `${root}/conversations/${general}/messages`,
      {
        participantId: participant.id,
        requestKey: key,
        body: `Restore sentinel ${key}`,
      },
      status,
    );
  const keys = [randomUUID(), randomUUID()];
  const messages = [(await send(keys[0])).item, (await send(keys[1])).item];
  assert.equal((await x.control(`resources?server=${server.id}`, "flush")).status, 200);
  await x.call("user_alice", "DELETE", `${root}/access/user_bob`);
  await x.db
    .prepare(
      "INSERT INTO billing_trials(account_id,provider_scope,owner_id,email_key,claimed_at,status) VALUES(?,'test','user_alice','restore-email',?,'rejected')",
    )
    .bind(account.id, Date.now())
    .run();
  const restore = await x.persistenceCheckpoint();
  // Damage only the disposable copy, then recover the coherent offline snapshot.
  await x.db.prepare("DELETE FROM billing_trials").run();
  await x.db.prepare("UPDATE server_access SET revoked_at=NULL WHERE user_id='user_bob'").run();
  await restore();
  assert.equal(
    (
      await x.db
        .prepare("SELECT status FROM billing_trials WHERE account_id=?")
        .bind(account.id)
        .first()
    ).status,
    "rejected",
  );
  assert.ok(
    (await x.db.prepare("SELECT revoked_at FROM server_access WHERE user_id='user_bob'").first())
      .revoked_at,
  );
  await x.call("user_bob", "GET", root, undefined, 404);
  const history = await x.call("user_alice", "GET", `${root}/conversations/${general}/messages`);
  assert.deepEqual(history.items, messages);
  const quota = await (await x.control(`quota?account=${account.id}`)).json();
  assert.equal(quota.used, 2);
  assert.equal(quota.outstanding, 0);
  assert.equal((await send(randomUUID(), 402)).error.code, "message_allowance_exhausted");
  assert.equal((await send(keys[0])).created, false);
  // The dashboard's index of message references is disposable; source messages are authoritative.
  await x.db.batch([
    x.db.prepare("DELETE FROM activity_events"),
    x.db.prepare("DELETE FROM activity_progress"),
  ]);
  assert.equal((await x.control("resource-repair")).status, 200);
  const found = await x.db
    .prepare("SELECT message_id FROM activity_events ORDER BY sequence")
    .all();
  assert.deepEqual(
    found.results.map((row) => row.message_id),
    messages.map((message) => message.id),
  );
  assert.equal((await (await x.control(`quota?account=${account.id}`)).json()).used, 2);
});
