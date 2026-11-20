import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Check the canonical migration independently of the HTTP integration suite.
const directory = mkdtempSync(join(tmpdir(), "talkto-core-schema-"));
const path = join(directory, "server.sqlite");
const schema = readFileSync(
  new URL("../apps/server/src/migrations/0001.sql", import.meta.url),
  "utf8",
);
let database = new DatabaseSync(path);
let checks = 0;

function check(label, run) {
  run();
  checks += 1;
  console.log(`ok ${checks} - ${label}`);
}

function execute(sql, ...bindings) {
  return database.prepare(sql).run(...bindings);
}

function rows(sql, ...bindings) {
  return database.prepare(sql).all(...bindings);
}

function scalar(sql, ...bindings) {
  return database.prepare(sql).get(...bindings)?.value;
}

const grantId = randomUUID();
const serverId = randomUUID();
const generalId = randomUUID();
const channelId = randomUUID();
const directId = randomUUID();
const [aliceId, bobId, carolId] = [randomUUID(), randomUUID(), randomUUID()].sort();
const epoch = 1_789_000_000_000;

function register(id, name, key) {
  execute(
    "INSERT INTO participants (id, name, agent_type, created_at, created_by_grant_id, request_key) VALUES (?, ?, 'codex', ?, ?, ?)",
    id,
    name,
    epoch,
    grantId,
    key,
  );
}

function openDirect(id, lowId, highId, creatorId = lowId) {
  execute(
    "INSERT INTO conversations (id, kind, participant_low_id, participant_high_id, created_by_participant_id, created_by_grant_id, created_at) VALUES (?, 'direct', ?, ?, ?, ?, ?)",
    id,
    lowId,
    highId,
    creatorId,
    grantId,
    epoch,
  );
}

function send(id, conversationId, senderId, key, body, time = epoch + 1) {
  execute(
    "INSERT INTO messages (id, conversation_id, sender_id, created_by_grant_id, request_key, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id,
    conversationId,
    senderId,
    grantId,
    key,
    body,
    time,
  );
}

try {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("BEGIN");
  database.exec(schema);
  execute("INSERT INTO server VALUES (1, ?, 'TalkTo test', ?)", serverId, epoch);
  execute("INSERT INTO server_grants VALUES (?, 'test-principal', ?, NULL)", grantId, epoch);
  execute(
    "INSERT INTO conversations (id, kind, name, is_general, created_at) VALUES (?, 'channel', 'General', 1, ?)",
    generalId,
    epoch,
  );
  execute("INSERT INTO schema_migrations VALUES (1, ?)", epoch);
  database.exec("COMMIT");

  register(aliceId, "Product", "register-product");
  register(bobId, "Engineering", "register-engineering");
  register(carolId, "Research", "register-research");
  execute(
    "INSERT INTO conversations (id, kind, name, created_by_participant_id, created_by_grant_id, request_key, created_at) VALUES (?, 'channel', 'Planning', ?, ?, 'create-planning', ?)",
    channelId,
    aliceId,
    grantId,
    epoch,
  );
  openDirect(directId, aliceId, bobId);

  check("one server and one General after transactional bootstrap", () => {
    assert.equal(scalar("SELECT COUNT(*) AS value FROM server"), 1);
    assert.equal(scalar("SELECT COUNT(*) AS value FROM conversations WHERE is_general = 1"), 1);
    assert.throws(
      () => execute("INSERT INTO server VALUES (2, ?, 'Other', ?)", randomUUID(), epoch),
      /CHECK/,
    );
    assert.throws(
      () => execute("UPDATE conversations SET archived_at = ? WHERE id = ?", epoch, generalId),
      /CHECK/,
    );
  });

  check("participant names and request keys are unique in their scopes", () => {
    assert.throws(() => register(randomUUID(), "product", "different-key"), /UNIQUE/);
    assert.throws(() => register(randomUUID(), "Different", "register-product"), /UNIQUE/);
    assert.throws(() => register(randomUUID(), "name with spaces", "invalid-name"), /CHECK/);
    assert.throws(() => register(randomUUID(), "pröduct", "unicode-name"), /CHECK/);
  });

  check("channel names are case-insensitive and General is reserved", () => {
    assert.throws(
      () => execute("UPDATE conversations SET name = 'general' WHERE id = ?", channelId),
      /CHECK/,
    );
    assert.throws(
      () => execute("UPDATE conversations SET name = 'planning' WHERE id = ?", generalId),
      /CHECK/,
    );
    assert.throws(
      () =>
        execute(
          "INSERT INTO conversations (id, kind, name, created_by_participant_id, created_by_grant_id, request_key, created_at) VALUES (?, 'channel', 'planning', ?, ?, 'other-channel', ?)",
          randomUUID(),
          aliceId,
          grantId,
          epoch,
        ),
      /UNIQUE/,
    );
  });

  check("direct conversations require one ordered, distinct, valid pair", () => {
    assert.throws(() => openDirect(randomUUID(), aliceId, bobId), /UNIQUE/);
    assert.throws(() => openDirect(randomUUID(), bobId, aliceId), /CHECK/);
    assert.throws(() => openDirect(randomUUID(), aliceId, aliceId), /CHECK/);
    assert.throws(() => openDirect(randomUUID(), aliceId, null), /CHECK/);
    assert.throws(() => openDirect(randomUUID(), aliceId, bobId, carolId), /CHECK/);
    assert.throws(
      () => execute("UPDATE conversations SET archived_at = ? WHERE id = ?", epoch, directId),
      /CHECK/,
    );
  });

  const firstId = randomUUID();
  send(firstId, generalId, aliceId, "message-1", "Shared launch context");
  send(randomUUID(), generalId, bobId, "message-2", "More launch context");
  send(randomUUID(), directId, aliceId, "message-3", "Pair discussion");
  send(randomUUID(), directId, bobId, "message-4", "Pair reply");

  check("a third participant cannot send into someone else's direct pair", () => {
    assert.throws(
      () => send(randomUUID(), directId, carolId, "outsider", "No"),
      /direct_sender_not_in_pair/,
    );
    assert.equal(
      scalar("SELECT COUNT(*) AS value FROM messages WHERE conversation_id = ?", directId),
      2,
    );
  });

  check("foreign keys reject unknown senders and unknown grants", () => {
    assert.throws(
      () => send(randomUUID(), generalId, randomUUID(), "unknown", "No"),
      /FOREIGN KEY/,
    );
    assert.throws(
      () =>
        execute(
          "UPDATE participants SET created_by_grant_id = ? WHERE id = ?",
          randomUUID(),
          aliceId,
        ),
      /FOREIGN KEY/,
    );
  });

  check("duplicate message request keys do not increment counters or duplicate FTS entries", () => {
    assert.throws(
      () => send(randomUUID(), generalId, aliceId, "message-1", "Shared launch context"),
      /UNIQUE/,
    );
    assert.equal(
      scalar("SELECT message_count AS value FROM conversations WHERE id = ?", generalId),
      2,
    );
    assert.equal(
      scalar("SELECT COUNT(*) AS value FROM messages_fts WHERE messages_fts MATCH 'launch'"),
      2,
    );
  });

  check("message body limits count UTF-8 bytes and reject NUL", () => {
    assert.throws(
      () => send(randomUUID(), generalId, aliceId, "too-large", "é".repeat(8193)),
      /CHECK/,
    );
    assert.throws(() => send(randomUUID(), generalId, aliceId, "nul", "a\0b"), /CHECK/);
  });

  check("message timestamps cannot regress", () => {
    assert.throws(
      () => send(randomUUID(), generalId, aliceId, "old", "Old", epoch),
      /message_time_regressed/,
    );
  });

  check("equal timestamps still have deterministic sequence order", () => {
    const ordered = rows("SELECT seq, created_at FROM messages ORDER BY seq");
    assert.equal(ordered.length, 4);
    assert.equal(new Set(ordered.map((row) => row.created_at)).size, 1);
    assert.equal(new Set(ordered.map((row) => row.seq)).size, 4);
  });

  check("message insertion, counters, and full-text search roll back together", () => {
    const count = scalar("SELECT COUNT(*) AS value FROM messages");
    const summary = scalar(
      "SELECT message_count AS value FROM conversations WHERE id = ?",
      generalId,
    );
    database.exec("BEGIN");
    send(randomUUID(), generalId, aliceId, "rolled-back", "rollbackmarker");
    assert.equal(
      scalar(
        "SELECT COUNT(*) AS value FROM messages_fts WHERE messages_fts MATCH 'rollbackmarker'",
      ),
      1,
    );
    database.exec("ROLLBACK");
    assert.equal(scalar("SELECT COUNT(*) AS value FROM messages"), count);
    assert.equal(
      scalar("SELECT message_count AS value FROM conversations WHERE id = ?", generalId),
      summary,
    );
    assert.equal(
      scalar(
        "SELECT COUNT(*) AS value FROM messages_fts WHERE messages_fts MATCH 'rollbackmarker'",
      ),
      0,
    );
  });

  check("archived channels retain history and reject fresh messages", () => {
    send(randomUUID(), channelId, aliceId, "planning-1", "Archived searchable plan");
    execute(
      "UPDATE conversations SET archived_at = ?, revision = revision + 1 WHERE id = ? AND revision = 0",
      epoch + 1,
      channelId,
    );
    assert.throws(
      () => send(randomUUID(), channelId, aliceId, "planning-2", "Blocked"),
      /channel_archived/,
    );
    assert.equal(
      scalar("SELECT COUNT(*) AS value FROM messages WHERE conversation_id = ?", channelId),
      1,
    );
    assert.equal(
      scalar("SELECT COUNT(*) AS value FROM messages_fts WHERE messages_fts MATCH 'searchable'"),
      1,
    );
  });

  check("revision guards keep stale archive attempts from undoing reopen", () => {
    assert.equal(
      execute(
        "UPDATE conversations SET archived_at = NULL, revision = revision + 1 WHERE id = ? AND revision = 1",
        channelId,
      ).changes,
      1,
    );
    assert.equal(
      execute(
        "UPDATE conversations SET archived_at = ?, revision = revision + 1 WHERE id = ? AND revision = 0",
        epoch + 1,
        channelId,
      ).changes,
      0,
    );
    assert.equal(scalar("SELECT revision AS value FROM conversations WHERE id = ?", channelId), 2);
  });

  check("history pages can retain a snapshot ceiling across new appends", () => {
    const ceiling = scalar("SELECT MAX(seq) AS value FROM messages");
    const before = rows(
      "SELECT id FROM messages WHERE conversation_id = ? AND seq <= ? ORDER BY seq",
      generalId,
      ceiling,
    );
    send(randomUUID(), generalId, carolId, "after-snapshot", "Later append");
    const after = rows(
      "SELECT id FROM messages WHERE conversation_id = ? AND seq <= ? ORDER BY seq",
      generalId,
      ceiling,
    );
    assert.deepEqual(after, before);
    const anchor = scalar("SELECT seq AS value FROM messages WHERE id = ?", firstId);
    assert.equal(
      rows(
        "SELECT id FROM messages WHERE conversation_id = ? AND seq > ? AND seq <= ? ORDER BY seq",
        generalId,
        anchor,
        ceiling,
      ).length,
      1,
    );
  });

  check("search matches stored bodies with scope filters", () => {
    assert.equal(
      rows(
        "SELECT m.id FROM messages_fts f JOIN messages m ON m.seq = f.rowid WHERE messages_fts MATCH ? AND m.conversation_id = ? ORDER BY m.seq DESC",
        '"launch" AND "context"',
        generalId,
      ).length,
      2,
    );
    assert.equal(
      rows(
        "SELECT m.id FROM messages_fts f JOIN messages m ON m.seq = f.rowid WHERE messages_fts MATCH ? AND m.conversation_id = ?",
        '"launch"',
        directId,
      ).length,
      0,
    );
  });

  check("history query uses the conversation/sequence index", () => {
    const plan = rows(
      "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT 25",
      generalId,
      100,
    );
    assert.match(JSON.stringify(plan), /messages_conversation_seq/);
  });

  check("messages cannot be changed or removed through ordinary SQL", () => {
    assert.throws(
      () => execute("UPDATE messages SET body = 'changed' WHERE id = ?", firstId),
      /message_immutable/,
    );
    assert.throws(() => execute("DELETE FROM messages WHERE id = ?", firstId), /message_immutable/);
  });

  check("one active grant per principal while revoked grants remain referenced", () => {
    assert.throws(
      () =>
        execute(
          "INSERT INTO server_grants VALUES (?, 'test-principal', ?, NULL)",
          randomUUID(),
          epoch,
        ),
      /UNIQUE/,
    );
    execute("UPDATE server_grants SET revoked_at = ? WHERE id = ?", epoch + 2, grantId);
    assert.equal(
      scalar(
        "SELECT COUNT(*) AS value FROM server_grants WHERE id = ? AND principal_key = 'test-principal' AND revoked_at IS NULL",
        grantId,
      ),
      0,
    );
    execute(
      "INSERT INTO server_grants VALUES (?, 'test-principal', ?, NULL)",
      randomUUID(),
      epoch + 3,
    );
    assert.equal(
      scalar(
        "SELECT COUNT(*) AS value FROM server_grants WHERE principal_key = 'test-principal' AND revoked_at IS NULL",
      ),
      1,
    );
  });

  check("all summary counters and search indexes agree with source messages", () => {
    assert.equal(
      rows(
        "SELECT c.id FROM conversations c WHERE c.message_count <> (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) OR c.last_message_seq IS NOT (SELECT MAX(seq) FROM messages m WHERE m.conversation_id = c.id) OR c.last_message_at IS NOT (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id)",
      ).length,
      0,
    );
    assert.equal(
      rows(
        "SELECT p.id FROM participants p WHERE p.message_count <> (SELECT COUNT(*) FROM messages m WHERE m.sender_id = p.id) OR p.last_message_at IS NOT (SELECT MAX(created_at) FROM messages m WHERE m.sender_id = p.id)",
      ).length,
      0,
    );
    assert.equal(rows("PRAGMA foreign_key_check").length, 0);
    database.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)");
  });

  check("committed records and derived search survive reopening the database", () => {
    const count = scalar("SELECT COUNT(*) AS value FROM messages");
    database.close();
    database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys = ON");
    assert.equal(scalar("SELECT COUNT(*) AS value FROM messages"), count);
    assert.equal(
      scalar("SELECT COUNT(*) AS value FROM messages_fts WHERE messages_fts MATCH 'launch'"),
      2,
    );
    assert.equal(scalar("SELECT MAX(version) AS value FROM schema_migrations"), 1);
  });

  console.log(
    `\n${checks} SQL design checks passed. Application and Cloudflare integration tests remain separate.`,
  );
} finally {
  database.close();
  rmSync(directory, { recursive: true });
}
