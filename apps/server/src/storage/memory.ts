import { Effect, Schema } from "effect";
import * as M from "@talkto/api/models";
import type * as Store from "../memory/store.js";
import type { Helpers } from "./board.js";

/**
 * Swarm memory's ledger over the session's statement helpers (migrations/memory-repository.sql).
 * Every statement reads one row, the cached files (at most 200), or a participant's tokens.
 */

const flag = Schema.Literals([0, 1]);
const repositoryRow = Schema.Struct({
  tokens: M.Count,
  name: Schema.String,
  remote: Schema.String,
  sourceServerId: Schema.NullOr(M.ServerId),
  seeded: flag,
  channelId: Schema.NullOr(M.ConversationId),
  posterId: Schema.NullOr(M.ParticipantId),
  posterGrantId: Schema.NullOr(M.GrantId),
  goodHead: Schema.NullOr(Schema.String),
  checkedAt: M.Count,
  cappedUntil: M.Count,
  createdAt: M.Count,
});
const fileRow = Schema.Struct({
  path: Schema.String,
  blob: Schema.String,
  text: Schema.String,
  bytes: M.Count,
  labels: Schema.fromJsonString(Schema.Array(Schema.String)),
});
const tokenRow = Schema.Struct({
  id: Schema.String,
  tokenId: Schema.String,
  participantId: M.ParticipantId,
  grantId: M.GrantId,
  scope: Schema.Literals(["read", "write"]),
  taskId: Schema.NullOr(Schema.String),
  epoch: Schema.NullOr(Schema.Int),
  issuedAt: M.Count,
  expiresAt: M.Count,
  revokedAt: Schema.NullOr(M.Count),
  settledAt: Schema.NullOr(M.Count),
});
const revocableRow = Schema.Struct({
  ...tokenRow.fields,
  reason: Schema.Literals(["access", "claim", "capped"]),
});
const personRow = Schema.Struct({ participantId: M.ParticipantId, grantId: M.GrantId });
/** An agent no person removed from the server. */
const activeAgent = "id NOT IN (SELECT participant_id FROM participant_removals)";
const countRow = Schema.Struct({ count: M.Count });
const atRow = Schema.Struct({ at: Schema.NullOr(M.Count) });
const tokenColumns = `id, token_id AS tokenId, participant_id AS participantId, grant_id AS grantId,
 scope, task_id AS taskId, epoch, issued_at AS issuedAt, expires_at AS expiresAt,
 revoked_at AS revokedAt, settled_at AS settledAt`;
/** A live token whose access ended: its grant revoked, or its participant removed from the server. */
const accessEnded = `(grant_id IN (SELECT id FROM server_grants WHERE revoked_at IS NOT NULL)
 OR participant_id IN (SELECT participant_id FROM participant_removals))`;
/** A write token whose claim is no longer this holder's live lease. */
const claimEnded = `(scope='write' AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id=memory_tokens.task_id
 AND t.state='claimed' AND t.claimer_id=memory_tokens.participant_id AND t.lease_epoch=memory_tokens.epoch
 AND t.lease_expires_at>?))`;

export const make = ({
  execute,
  all,
  one,
}: Omit<Helpers, "allocateSequence">): Store.MemoryStore => {
  const run = (query: string, bindings: ReadonlyArray<SqlStorageValue>) =>
    execute(query, bindings).pipe(Effect.asVoid);
  return {
    repository: () =>
      one(
        repositoryRow,
        `SELECT tokens, name, remote, source_server_id AS sourceServerId, seeded,
         channel_id AS channelId, poster_id AS posterId, poster_grant_id AS posterGrantId,
         good_head AS goodHead, checked_at AS checkedAt, capped_until AS cappedUntil,
         created_at AS createdAt FROM memory_repository WHERE singleton=1`,
      ).pipe(Effect.map((row) => (row === null ? null : { ...row, seeded: row.seeded === 1 }))),
    createRepository: (input) =>
      run(
        // enabled is always 1: memory has no switch, and a rolled-back Worker then reads it as on.
        `INSERT INTO memory_repository(singleton,enabled,tokens,name,remote,source_server_id,seeded,created_at,changed_at)
         VALUES(1,1,?,?,?,?,?,?,?)`,
        [
          input.tokens,
          input.name,
          input.remote,
          input.sourceServerId,
          input.seeded ? 1 : 0,
          input.at,
          input.at,
        ],
      ),
    setSeeded: () => run("UPDATE memory_repository SET seeded=1 WHERE singleton=1", []),
    setSettings: (input) =>
      run(
        `UPDATE memory_repository SET enabled=1, tokens=?, changed_by_participant_id=?, changed_at=?
         WHERE singleton=1`,
        [input.tokens, input.changedBy, input.at],
      ),
    setChannel: (channelId) =>
      run("UPDATE memory_repository SET channel_id=? WHERE singleton=1", [channelId]),
    setPoster: (input) =>
      run("UPDATE memory_repository SET poster_id=?, poster_grant_id=? WHERE singleton=1", [
        input.posterId,
        input.posterGrantId,
      ]),
    person: (principalKey) =>
      one(
        personRow,
        `SELECT p.id AS participantId, p.created_by_grant_id AS grantId FROM person_participants pp
         JOIN participants p ON p.id=pp.participant_id WHERE pp.principal_key=? AND p.kind='person'`,
        [principalKey],
      ),
    agent: (participantId) =>
      one(
        personRow,
        `SELECT id AS participantId, created_by_grant_id AS grantId FROM participants
         WHERE id=? AND kind IS NULL AND ${activeAgent}`,
        [participantId],
      ),
    firstAgent: () =>
      one(
        personRow,
        `SELECT id AS participantId, created_by_grant_id AS grantId FROM participants
         WHERE kind IS NULL AND ${activeAgent} ORDER BY created_at, id LIMIT 1`,
      ),
    setChecked: (at) => run("UPDATE memory_repository SET checked_at=? WHERE singleton=1", [at]),
    setHead: Effect.fnUntraced(function* (input) {
      const moved = yield* execute(
        `UPDATE memory_repository SET good_head=?, checked_at=? WHERE singleton=1
         AND (good_head IS ? OR good_head=?) RETURNING 1 AS moved`,
        [input.head, input.at, input.expected, input.expected],
      );
      if (moved.length === 0) return false;
      yield* run("DELETE FROM memory_files", []);
      for (const file of input.files)
        yield* run("INSERT INTO memory_files(path,blob,text,bytes,labels) VALUES(?,?,?,?,?)", [
          file.path,
          file.blob,
          file.text,
          file.bytes,
          JSON.stringify(file.labels),
        ]);
      return true;
    }),
    setCapped: (until) =>
      run("UPDATE memory_repository SET capped_until=? WHERE singleton=1", [until]),
    files: () =>
      all(fileRow, "SELECT path, blob, text, bytes, labels FROM memory_files ORDER BY path"),
    file: (path) =>
      one(fileRow, "SELECT path, blob, text, bytes, labels FROM memory_files WHERE path=?", [path]),
    commitKnown: (hash) =>
      one(countRow, "SELECT COUNT(*) AS count FROM memory_commits WHERE hash=?", [hash]).pipe(
        Effect.map((row) => (row?.count ?? 0) > 0),
      ),
    addCommit: (row) =>
      run(
        `INSERT INTO memory_commits(hash,subject,message_id,usage_id,metered,found_at) VALUES(?,?,?,?,?,?)
         ON CONFLICT(hash) DO NOTHING`,
        [row.hash, row.subject, row.messageId, row.usageId, row.metered ? 1 : 0, row.foundAt],
      ),
    commitCount: () =>
      one(countRow, "SELECT COUNT(*) AS count FROM memory_commits").pipe(
        Effect.map((row) => row?.count ?? 0),
      ),
    addToken: (row) =>
      run(
        `INSERT INTO memory_tokens(id,token_id,participant_id,grant_id,scope,task_id,epoch,issued_at,expires_at,revoked_at,settled_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [
          row.id,
          row.tokenId,
          row.participantId,
          row.grantId,
          row.scope,
          row.taskId,
          row.epoch,
          row.issuedAt,
          row.expiresAt,
          row.revokedAt,
          row.settledAt,
        ],
      ),
    grantsSince: (participantId, scope, since) =>
      all(
        Schema.Struct({ at: M.Count }),
        `SELECT issued_at AS at FROM memory_tokens WHERE participant_id=? AND scope=? AND issued_at>?
         ORDER BY issued_at`,
        [participantId, scope, since],
      ).pipe(Effect.map((rows) => rows.map((row) => row.at))),
    revocable: (at, capped) =>
      all(
        revocableRow,
        `SELECT ${tokenColumns}, CASE WHEN ${accessEnded} THEN 'access'
           WHEN ${claimEnded} THEN 'claim' ELSE 'capped' END AS reason
         FROM memory_tokens WHERE revoked_at IS NULL AND expires_at>?
         AND (${accessEnded} OR ${claimEnded} OR (scope='write' AND ?=1))
         ORDER BY issued_at, id`,
        [at, at, at, capped ? 1 : 0],
      ),
    liveWrites: (at) =>
      all(
        tokenRow,
        `SELECT ${tokenColumns} FROM memory_tokens WHERE scope='write' AND revoked_at IS NULL
         AND expires_at>? ORDER BY issued_at, id`,
        [at],
      ),
    markRevoked: (id, at) =>
      run(
        "UPDATE memory_tokens SET revoked_at=MAX(issued_at,?) WHERE id=? AND revoked_at IS NULL",
        [at, id],
      ),
    unsettled: (at) =>
      all(
        tokenRow,
        `SELECT ${tokenColumns} FROM memory_tokens WHERE scope='write' AND settled_at IS NULL
         AND (revoked_at IS NOT NULL OR expires_at<=?) ORDER BY issued_at, id`,
        [at],
      ),
    markSettled: Effect.fnUntraced(function* (ids, at) {
      for (const id of ids)
        yield* run("UPDATE memory_tokens SET settled_at=? WHERE id=? AND settled_at IS NULL", [
          at,
          id,
        ]);
    }),
    nextExpiry: () =>
      one(
        atRow,
        "SELECT MIN(expires_at) AS at FROM memory_tokens WHERE scope='write' AND settled_at IS NULL",
      ).pipe(Effect.map((row) => row?.at ?? null)),
    writing: (participantId) =>
      one(
        countRow,
        "SELECT COUNT(*) AS count FROM memory_tokens WHERE scope='write' AND settled_at IS NULL AND participant_id=?",
        [participantId],
      ).pipe(Effect.map((row) => (row?.count ?? 0) > 0)),
    erase: Effect.fnUntraced(function* () {
      yield* run("DELETE FROM memory_files", []);
      yield* run("DELETE FROM memory_commits", []);
      yield* run("DELETE FROM memory_tokens", []);
      yield* run("DELETE FROM memory_repository", []);
    }),
  };
};
