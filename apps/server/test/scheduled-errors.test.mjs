import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

test("scheduled failures retain stage evidence once and recover without advancing failed work", async (t) => {
  const events = [];
  const envelopes = [];
  const transactions = [];
  const checkIns = [];
  const x = await start(t, {
    traceRate: 0,
    manualAlarms: true,
    telemetry: async (request) => {
      const body = await request.text();
      envelopes.push(body);
      const lines = body.trim().split("\n");
      for (let i = 1; i + 1 < lines.length; i += 2) {
        if (JSON.parse(lines[i]).type === "event") events.push(JSON.parse(lines[i + 1]));
        if (JSON.parse(lines[i]).type === "transaction")
          transactions.push(JSON.parse(lines[i + 1]));
        if (JSON.parse(lines[i]).type === "check_in")
          checkIns.push({ ...JSON.parse(lines[i + 1]), sentAt: JSON.parse(lines[0]).sent_at });
      }
      return Response.json({});
    },
  });
  /**
   * Check-ins in the order the Worker sent them. Each is its own envelope and request, so two
   * from one short run can arrive in either order; a run's start and finish sent in the same
   * millisecond are told apart by the finish's duration.
   */
  const sent = () =>
    [...checkIns].sort(
      (a, b) =>
        a.sentAt.localeCompare(b.sentAt) ||
        Number(a.duration !== undefined) - Number(b.duration !== undefined),
    );
  const account = await x.account();
  const server = await x.server(account.id);
  const participant = await x.call("user_alice", "POST", `/v1/servers/${server.id}/participants`, {
    name: "PRIVATE_SCHEDULED_AGENT",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  const message = await x.call(
    "user_alice",
    "POST",
    `/v1/servers/${server.id}/conversations/${participant.generalConversationId}/messages`,
    {
      participantId: participant.item.id,
      requestKey: randomUUID(),
      body: "PRIVATE_SCHEDULED_MESSAGE",
    },
  );
  await x.control("authentication-down?value=true");
  const failed = await x.scheduled();
  assert.equal(failed.outcome, "exception");
  assert.equal(events.length, 1, "one stage failure must not also create a generic cron error");
  assert.equal(events[0].tags["talkto.code"], "identity_unavailable");
  assert.equal(events[0].tags["talkto.stage"], "access");
  assert.match(events[0].tags["talkto.request_id"], /^[a-f0-9-]{36}$/);
  assert.doesNotMatch(envelopes.join("\n"), /Injected authentication|PRIVATE_|Bearer /);
  // The failed run checks in to the cron monitor as started, then as an error.
  const failedRun = sent();
  assert.deepEqual(
    failedRun.map((checkIn) => [checkIn.monitor_slug, checkIn.status]),
    [
      ["talkto-cron", "in_progress"],
      ["talkto-cron", "error"],
    ],
  );
  assert.equal(failedRun[0].check_in_id, failedRun[1].check_in_id);
  assert.equal(failedRun[0].duration, undefined);
  assert.equal(failedRun[0].environment, "test");
  assert.deepEqual(failedRun[0].monitor_config, {
    schedule: { type: "crontab", value: "* * * * *" },
    checkin_margin: 3,
    max_runtime: 10,
    timezone: "Etc/UTC",
    failure_issue_threshold: 3,
    recovery_threshold: 2,
  });
  assert.ok(failedRun[1].duration >= 0);

  const before = await x.db.prepare("SELECT * FROM activity_progress ORDER BY server_id").all();
  await x.db.exec("ALTER TABLE activity_progress RENAME TO unavailable_activity_progress");
  const bothFailed = await x.scheduled();
  assert.equal(bothFailed.outcome, "exception");
  assert.equal(events.length, 3, "independent failures each report once");
  const independent = events.slice(1);
  assert.deepEqual(independent.map((event) => event.tags["talkto.stage"]).sort(), [
    "access",
    "activity",
  ]);
  assert.equal(new Set(independent.map((event) => event.tags["talkto.request_id"])).size, 1);
  const retained = await x.db
    .prepare("SELECT * FROM unavailable_activity_progress ORDER BY server_id")
    .all();
  assert.deepEqual(retained.results, before.results, "failed repair must retain its checkpoint");
  await x.db.exec("ALTER TABLE unavailable_activity_progress RENAME TO activity_progress");
  await x.db
    .prepare("UPDATE activity_progress SET caught_up=0 WHERE server_id=?")
    .bind(server.id)
    .run();
  await x.control("authentication-down?value=false");
  const recovered = await x.scheduled();
  assert.equal(recovered.outcome, "ok");
  assert.equal(events.length, 3, "successful recovery must not report another failure");
  const recoveredRun = sent().slice(-2);
  assert.deepEqual(
    recoveredRun.map((checkIn) => checkIn.status),
    ["in_progress", "ok"],
  );
  assert.equal(recoveredRun[0].check_in_id, recoveredRun[1].check_in_id);
  assert.equal(checkIns.length, 6, "each run checks in twice");
  const progress = await x.db
    .prepare("SELECT caught_up FROM activity_progress WHERE server_id=?")
    .bind(server.id)
    .first();
  assert.equal(progress.caught_up, 1);
  const indexed = await x.db
    .prepare("SELECT message_id FROM activity_events WHERE server_id=?")
    .bind(server.id)
    .all();
  assert.deepEqual(indexed.results, [{ message_id: message.item.id }]);
  assert.equal(transactions.length, 0, "scheduled errors must survive unsampled roots");
  assert.doesNotMatch(envelopes.join("\n"), /PRIVATE_|Injected authentication|Bearer /);
});
