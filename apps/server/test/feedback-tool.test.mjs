import assert from "node:assert/strict";
import { test } from "node:test";
import { clean, format, listQuery, markReadQuery, pageSize, parse } from "../tools/feedback.mjs";

/** `pnpm feedback` (tools/feedback.mjs) without wrangler: arguments, SQL and printing. */
const R = String.fromCodePoint(0xfffd);
const id = "11111111-1111-4111-8111-111111111111";

test("the feedback reader lists production by default and writes only with --mark-read", () => {
  assert.deepEqual(parse([]), {
    env: "production",
    database: "talkto-platform-production",
    config: "wrangler.production.jsonc",
    ids: null,
  });
  assert.equal(parse(["--env", "staging"]).database, "talkto-platform-staging");
  assert.deepEqual(parse(["--mark-read", id, id]).ids, [id]);
  assert.throws(() => parse(["--env", "local"]), /production or staging/);
  assert.throws(() => parse(["--mark-read"]), /at least one/);
  assert.throws(() => parse(["--mark-read", "x' OR '1'='1"]), /Not feedback IDs/);
  assert.throws(() => parse([id]), /Unexpected arguments/);
  assert.match(listQuery, /^SELECT .* WHERE read_at IS NULL ORDER BY created_at DESC/);
  assert.match(listQuery, new RegExp(`LIMIT ${pageSize}$`));
  assert.doesNotMatch(listQuery, /email|UPDATE|DELETE|INSERT/i);
  assert.equal(
    markReadQuery([id]),
    `UPDATE feedback SET read_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE read_at IS NULL AND id IN ('${id}') RETURNING id`,
  );
  assert.throws(() => markReadQuery(["1'); DROP TABLE feedback; --"]));
});

test("printed feedback cannot rewrite the terminal", () => {
  assert.equal(
    clean("\u001b[2J" + String.fromCodePoint(0x202e) + "ok\tfine"),
    `${R}[2J${R}ok\tfine`,
  );
  const text = format(
    [
      {
        id,
        created_at: "2026-11-17T10:00:00.000Z",
        kind: "bug",
        source: "dashboard",
        user_id: "user_alice",
        account_id: null,
        server_id: null,
        participant_id: null,
        page: "/app",
        app_version: "talkto@e99e466",
        user_agent: "Mozilla/5.0",
        message: "First line\n\u001b]0;owned\u0007second",
        unread: 101,
      },
    ],
    "staging",
  );
  assert.match(text, /^101 unread in staging, newest 1 shown:/);
  assert.match(text, /BUG {6}2026-11-17T10:00:00.000Z {2}11111111\S+ {2}from dashboard/);
  assert.match(text, /user user_alice {2}account -/);
  assert.match(text, / {2}page \/app\n {2}version talkto@e99e466 {2}browser Mozilla\/5\.0/);
  assert.doesNotMatch(text, /participant/);
  const agent = format(
    [
      {
        id,
        created_at: "2026-11-17T10:00:00.000Z",
        kind: "feedback",
        source: "agent",
        user_id: "user_alice",
        account_id: "6f0c3e1b-9a52-4c1e-8f0d-2b6c7a1e4d90",
        server_id: "srv",
        participant_id: null,
        page: null,
        app_version: null,
        user_agent: "claude-code/2.1",
        message: "Search missed a message.",
        unread: 1,
      },
    ],
    "production",
  );
  assert.match(agent, /FEEDBACK 2026-11-17T10:00:00.000Z {2}\S+ {2}from agent/);
  assert.match(
    agent,
    / {2}server srv {2}participant -\n {2}version - {2}browser claude-code\/2\.1/,
  );
  assert.doesNotMatch(agent, /page/);
  assert.ok(text.includes(`  | First line\n  | ${R}]0;owned${R}second`));
  assert.match(text, /pnpm feedback --env staging --mark-read/);
  assert.ok(!text.includes("\u001b"));
  assert.equal(format([], "production"), "No unread feedback in production.");
});
