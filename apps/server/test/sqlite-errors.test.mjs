import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

test("unexpected SQLite transaction defects retain operation once without changing rollback or failures", async (t) => {
  const events = [];
  const transactions = [];
  const envelopes = [];
  const received = Promise.withResolvers();
  const x = await start(t, {
    traceRate: 0,
    manualAlarms: true,
    telemetry: async (request) => {
      const body = await request.text();
      envelopes.push(body);
      const lines = body.trim().split("\n");
      for (let i = 1; i + 1 < lines.length; i += 2) {
        const type = JSON.parse(lines[i]).type;
        if (type === "event") {
          events.push(JSON.parse(lines[i + 1]));
          received.resolve();
        }
        if (type === "transaction") transactions.push(JSON.parse(lines[i + 1]));
      }
      return Response.json({});
    },
  });
  const account = await x.account();
  const server = await x.server(account.id);
  const failed = await x.raw(`/__telemetry/sqlite-error?server=${server.id}`);
  assert.equal(failed.status, 500);
  const defect = await (await x.raw(`/__telemetry/sqlite-result?server=${server.id}`)).json();
  assert.equal(defect.sameDefect, true);
  assert.equal(defect.rows, 0);
  await received.promise;
  assert.equal(
    events.length,
    1,
    "manual capture and real DO wrapper must deduplicate the same error",
  );
  assert.equal(events[0].tags["talkto.operation"], "fixtureTransaction");
  assert.equal(events[0].tags["talkto.code"], "internal_error");
  for (const mode of ["busy", "retryable", "domain"]) {
    assert.equal(
      (await x.raw(`/__telemetry/sqlite-error?server=${server.id}&mode=${mode}`)).status,
      200,
    );
    const result = await (await x.raw(`/__telemetry/sqlite-result?server=${server.id}`)).json();
    assert.equal(result.rows, 0);
    assert.equal(result.failure._tag, "StorageUnavailable");
    assert.equal(
      result.failure.operation,
      mode === "domain" ? "fixtureDomain" : "fixtureTransaction",
    );
    if (mode === "domain") assert.equal(result.sameDomainFailure, true);
    assert.equal(events.length, 1, "expected failures must retain their existing reporting owner");
  }
  for (const mode of ["callback", "constraint"]) {
    const before = events.length;
    assert.equal(
      (await x.raw(`/__telemetry/sqlite-error?server=${server.id}&mode=${mode}`)).status,
      500,
    );
    const result = await (await x.raw(`/__telemetry/sqlite-result?server=${server.id}`)).json();
    assert.equal(result.rows, 0, `${mode} must roll back the provisional write`);
    if (mode === "callback") assert.equal(result.sameDefect, true);
    assert.equal(events.length, before + 1, `${mode} must be reported exactly once`);
    const event = events.at(-1);
    assert.equal(event.tags["talkto.operation"], "fixtureTransaction");
    assert.equal(event.tags["talkto.code"], "internal_error");
    assert.ok(event.exception.values.some((value) => value.type === "Error"));
    assert.ok(event.exception.values.some((value) => value.stacktrace?.frames.length > 0));
  }
  assert.equal(
    (await x.raw(`/__telemetry/sqlite-error?server=${server.id}&mode=success`)).status,
    200,
  );
  const recovered = await (await x.raw(`/__telemetry/sqlite-result?server=${server.id}`)).json();
  assert.equal(recovered.rows, 1, "a successful retry commits once");
  assert.equal(recovered.failure, null);
  assert.equal(events.length, 3);
  assert.equal(transactions.length, 0);
  assert.doesNotMatch(envelopes.join("\n"), /PRIVATE_|telemetry_rollback|INSERT INTO|SELECT \*/);
});
