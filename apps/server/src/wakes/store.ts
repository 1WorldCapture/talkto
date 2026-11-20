import { Context, Effect, Predicate, Schema } from "effect";
import * as M from "@talkto/api/models";
import * as U from "@talkto/api/updates";
import * as W from "@talkto/api/wake";
import { StorageUnavailable } from "@talkto/api/errors";
import * as Policy from "./policy.js";

/** One wake target as stored. Times are epoch milliseconds. */
export interface Target {
  readonly id: W.WakeId;
  readonly identity: string;
  readonly kind: W.Kind;
  readonly participantId: M.ParticipantId;
  readonly grantId: M.GrantId;
  readonly url: string;
  readonly sealed: string;
  readonly hint: string;
  readonly selection: U.Selection;
  readonly generation: U.Generation;
  readonly deliveredThrough: number;
  readonly minIntervalMs: number;
  readonly dueAt: number | null;
  readonly attemptId: string | null;
  readonly failures: number;
  readonly lastAttemptAt: number | null;
  readonly lastSentAt: number | null;
  readonly lastError: string | null;
  readonly disabledAt: number | null;
  readonly disabledReason: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** When a person last sent a test from the dashboard. Kept apart from delivery state. */
  readonly lastTestAt: number | null;
  /** How that test ended: `accepted`, a delivery reason code, or `unfinished` while it is out. */
  readonly lastTestOutcome: string | null;
}
/** How one test is recorded. */
export type TestOutcome = "accepted" | "unfinished" | Policy.Reason;
/** What registration writes; delivery state starts empty or carries over on a refresh. */
export type Registration = Pick<
  Target,
  | "id"
  | "identity"
  | "kind"
  | "participantId"
  | "grantId"
  | "url"
  | "sealed"
  | "hint"
  | "selection"
  | "generation"
  | "deliveredThrough"
  | "minIntervalMs"
  | "createdAt"
  | "expiresAt"
>;
/** Who a committed message can wake; the same facts get_updates waits match on. */
export interface Arrival {
  readonly conversationId: M.ConversationId;
  readonly senderId: M.ParticipantId;
  readonly directParticipantIds: ReadonlyArray<M.ParticipantId>;
  /** Participants a channel message @mentions; they are woken as for their direct chats. */
  readonly mentionedIds: ReadonlyArray<M.ParticipantId>;
  /** Sent with priority urgent, which only direct chats allow: it skips the cadence. */
  readonly urgent: boolean;
}
/** How one attempt is recorded. */
export type Result =
  | {
      readonly _tag: "Sent";
      readonly through: number;
      readonly at: number;
      readonly error: Policy.Reason | null;
    }
  | {
      readonly _tag: "Failed";
      readonly at: number;
      readonly reason: Policy.Reason;
      readonly retryAt: number;
    }
  | { readonly _tag: "Disabled"; readonly at: number; readonly reason: string };

type Op<A> = Effect.Effect<A, StorageUnavailable>;
/**
 * Persistence for wake targets. Every operation is a synchronous statement on the server
 * object's SQLite database, so calls made inside a `Persistence.transaction` body join it.
 */
export class WakeStore extends Context.Service<
  WakeStore,
  {
    readonly put: (registration: Registration) => Op<void>;
    readonly byId: (id: W.WakeId) => Op<Target | null>;
    readonly list: (participantId: M.ParticipantId) => Op<ReadonlyArray<Target>>;
    readonly count: (participantId: M.ParticipantId, kind: W.Kind | null) => Op<number>;
    readonly remove: (participantId: M.ParticipantId, id: W.WakeId | null) => Op<number>;
    readonly removeIdentity: (identity: string) => Op<void>;
    readonly removeExpired: (at: number) => Op<void>;
    /** Mark every matching idle target due; returns the earliest due time set, or null. */
    readonly markDue: (arrival: Arrival, at: number, debounceMs: number) => Op<number | null>;
    /**
     * After the participant's cadence changed: move its due wakes earlier where the new cadence
     * allows, never later. Returns the earliest due time, or null.
     */
    readonly advance: (participantId: M.ParticipantId, at: number) => Op<number | null>;
    readonly due: (at: number, limit: number) => Op<ReadonlyArray<Target>>;
    readonly nextDue: () => Op<number | null>;
    /** Reserve the stable attempt ID a notice keeps across retries. */
    readonly setAttempt: (id: W.WakeId, attemptId: string) => Op<void>;
    readonly clearDue: (id: W.WakeId) => Op<void>;
    readonly postpone: (
      id: W.WakeId,
      until: number,
      error: Policy.Reason | "budget" | "read_limit",
    ) => Op<void>;
    /** Start counting after `through` in a new history lineage. */
    readonly rebase: (id: W.WakeId, generation: U.Generation, through: number) => Op<void>;
    readonly record: (id: W.WakeId, result: Result) => Op<void>;
    readonly sent: (participantId: M.ParticipantId, fromHour: number) => Op<number>;
    readonly addSend: (participantId: M.ParticipantId, hour: number) => Op<void>;
    /**
     * Record a person's test of one target. Touches only the test's own row, never the target's
     * checkpoint, due time, failures or last attempt.
     */
    readonly recordTest: (id: W.WakeId, at: number, outcome: TestOutcome) => Op<void>;
    /** Hold a due wake until `until` without recording a problem: the host's minimum after a test. */
    readonly defer: (id: W.WakeId, until: number) => Op<void>;
  }
>()("@talkto/WakeStore") {}

const Row = Schema.Struct({
  id: W.WakeId,
  identity: Schema.String,
  kind: W.Kind,
  participantId: M.ParticipantId,
  grantId: M.GrantId,
  url: Schema.String,
  sealed: Schema.String,
  hint: Schema.String,
  selection: Schema.fromJsonString(U.Selection),
  generation: U.Generation,
  deliveredThrough: M.Count,
  minIntervalMs: Schema.Int,
  dueAt: Schema.NullOr(Schema.Int),
  attemptId: Schema.NullOr(Schema.String),
  failures: Schema.Int,
  lastAttemptAt: Schema.NullOr(Schema.Int),
  lastSentAt: Schema.NullOr(Schema.Int),
  lastError: Schema.NullOr(Schema.String),
  disabledAt: Schema.NullOr(Schema.Int),
  disabledReason: Schema.NullOr(Schema.String),
  createdAt: Schema.Int,
  expiresAt: Schema.Int,
  lastTestAt: Schema.NullOr(Schema.Int),
  lastTestOutcome: Schema.NullOr(Schema.String),
});
const columns = `id, identity, kind, participant_id AS participantId, grant_id AS grantId, url, sealed, hint,
 json_object('channelIds',json(channel_ids),'directChats',direct_chats) AS selection, generation,
 delivered_through AS deliveredThrough, min_interval_ms AS minIntervalMs, due_at AS dueAt,
 attempt_id AS attemptId, failures, last_attempt_at AS lastAttemptAt, last_sent_at AS lastSentAt,
 last_error AS lastError, disabled_at AS disabledAt, disabled_reason AS disabledReason,
 created_at AS createdAt, expires_at AS expiresAt,
 (SELECT tested_at FROM wake_tests WHERE wake_id=wake_targets.id) AS lastTestAt,
 (SELECT outcome FROM wake_tests WHERE wake_id=wake_targets.id) AS lastTestOutcome`;
const Count = Schema.Struct({ count: Schema.NullOr(Schema.Int) });
/** Later than any due time, for SQL MIN over a due time that may be empty. */
const latest = 253_402_300_799_999;
const unavailable = () =>
  new StorageUnavailable({
    operation: "wakes",
    message: "Server storage is temporarily unavailable.",
  });

/** The server object's SQLite adapter. */
export const sqlite = (storage: DurableObjectStorage) => {
  const exec = (query: string, bindings: ReadonlyArray<SqlStorageValue> = []) =>
    Effect.try({
      try: () => storage.sql.exec(query, ...bindings).toArray(),
      catch: (cause) => {
        if (
          Predicate.isError(cause) &&
          /SQLITE_(BUSY|LOCKED|FULL|IOERR)|database (?:is locked|or disk is full)|overloaded/i.test(
            cause.message,
          )
        )
          return unavailable();
        throw cause;
      },
    });
  const rows = (query: string, bindings: ReadonlyArray<SqlStorageValue> = []) =>
    exec(query, bindings).pipe(
      Effect.flatMap((found) =>
        Schema.decodeUnknownEffect(Schema.Array(Row))(found).pipe(Effect.orDie),
      ),
    );
  const scalar = (query: string, bindings: ReadonlyArray<SqlStorageValue> = []) =>
    exec(query, bindings).pipe(
      Effect.flatMap((found) =>
        Schema.decodeUnknownEffect(Schema.Array(Count))(found).pipe(Effect.orDie),
      ),
      Effect.map((found) => found[0]?.count ?? null),
    );
  const done = Effect.asVoid;
  const earliest = (found: ReadonlyArray<unknown>) =>
    Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ dueAt: Schema.Int })))(found).pipe(
      Effect.orDie,
      Effect.map((items) =>
        items.length === 0 ? null : Math.min(...items.map((item) => item.dueAt)),
      ),
    );
  return WakeStore.of({
    put: (target) =>
      exec(
        `INSERT INTO wake_targets(id,identity,kind,participant_id,grant_id,url,sealed,hint,channel_ids,
         direct_chats,generation,delivered_through,min_interval_ms,created_at,expires_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET id=excluded.id,
         grant_id=excluded.grant_id,url=excluded.url,sealed=excluded.sealed,hint=excluded.hint,
         channel_ids=excluded.channel_ids,direct_chats=excluded.direct_chats,
         generation=excluded.generation,delivered_through=excluded.delivered_through,
         min_interval_ms=excluded.min_interval_ms,expires_at=excluded.expires_at,failures=0,
         last_error=NULL,disabled_at=NULL,disabled_reason=NULL,attempt_id=NULL`,
        [
          target.id,
          target.identity,
          target.kind,
          target.participantId,
          target.grantId,
          target.url,
          target.sealed,
          target.hint,
          JSON.stringify(target.selection.channelIds),
          target.selection.directChats,
          target.generation,
          target.deliveredThrough,
          target.minIntervalMs,
          target.createdAt,
          target.expiresAt,
        ],
      ).pipe(done),
    byId: (id) =>
      rows(`SELECT ${columns} FROM wake_targets WHERE id=?`, [id]).pipe(
        Effect.map((found) => found[0] ?? null),
      ),
    list: (participantId) =>
      rows(`SELECT ${columns} FROM wake_targets WHERE participant_id=? ORDER BY created_at, id`, [
        participantId,
      ]),
    count: (participantId, kind) =>
      scalar(
        "SELECT COUNT(*) AS count FROM wake_targets WHERE participant_id=? AND (? IS NULL OR kind=?)",
        [participantId, kind, kind],
      ).pipe(Effect.map((count) => count ?? 0)),
    remove: (participantId, id) =>
      exec("DELETE FROM wake_targets WHERE participant_id=? AND (? IS NULL OR id=?) RETURNING id", [
        participantId,
        id,
        id,
      ]).pipe(Effect.map((removed) => removed.length)),
    removeIdentity: (identity) =>
      exec("DELETE FROM wake_targets WHERE identity=?", [identity]).pipe(done),
    removeExpired: (at) =>
      exec("DELETE FROM wake_targets WHERE expires_at<=?", [at]).pipe(
        Effect.andThen(
          exec("DELETE FROM wake_sends WHERE hour<?", [Math.floor(at / 3_600_000) - 24]),
        ),
        // Tests of revoked, replaced or expired targets.
        Effect.andThen(
          exec("DELETE FROM wake_tests WHERE wake_id NOT IN (SELECT id FROM wake_targets)"),
        ),
        done,
      ),
    markDue: (arrival, at, debounceMs) => {
      const matches = `disabled_at IS NULL AND expires_at>? AND participant_id<>?
         AND (EXISTS (SELECT 1 FROM json_each(channel_ids) WHERE value=?)
           OR (direct_chats='own' AND participant_id IN (SELECT value FROM json_each(?))))`;
      const bindings = [
        at,
        arrival.senderId,
        arrival.conversationId,
        // Direct-chat members and mentioned participants both arrive through directChats "own".
        JSON.stringify([...arrival.directParticipantIds, ...arrival.mentionedIds]),
      ];
      // Normal: after the debounce, and no sooner than the host's minimum or the cadence after the
      // last attempt. Urgent: as soon as the host's minimum allows, and earlier than a wake the
      // cadence is holding back.
      return (
        arrival.urgent
          ? exec(
              `UPDATE wake_targets SET due_at=MIN(COALESCE(due_at,${latest}),
               MAX(?, COALESCE(last_attempt_at,0)+min_interval_ms))
               WHERE (due_at IS NULL OR (${Policy.advanceableSql})) AND ${matches}
               RETURNING due_at AS dueAt`,
              [at, ...bindings],
            )
          : exec(
              `UPDATE wake_targets SET due_at=MAX(?, COALESCE(last_attempt_at,0)+${Policy.gapSql})
               WHERE due_at IS NULL AND ${matches} RETURNING due_at AS dueAt`,
              [at + debounceMs, ...bindings],
            )
      ).pipe(Effect.flatMap(earliest));
    },
    advance: (participantId, at) =>
      exec(
        `UPDATE wake_targets SET due_at=MIN(due_at, MAX(?, COALESCE(last_attempt_at,0)+${Policy.gapSql}))
         WHERE participant_id=? AND due_at IS NOT NULL AND disabled_at IS NULL AND ${Policy.advanceableSql}
         RETURNING due_at AS dueAt`,
        [at, participantId],
      ).pipe(Effect.flatMap(earliest)),
    due: (at, limit) =>
      rows(
        `SELECT ${columns} FROM wake_targets WHERE due_at IS NOT NULL AND due_at<=? AND disabled_at IS NULL
         ORDER BY due_at LIMIT ?`,
        [at, limit],
      ),
    nextDue: () =>
      scalar(
        "SELECT MIN(due_at) AS count FROM wake_targets WHERE due_at IS NOT NULL AND disabled_at IS NULL",
      ),
    setAttempt: (id, attemptId) =>
      exec("UPDATE wake_targets SET attempt_id=? WHERE id=?", [attemptId, id]).pipe(done),
    clearDue: (id) =>
      exec("UPDATE wake_targets SET due_at=NULL, attempt_id=NULL WHERE id=?", [id]).pipe(done),
    postpone: (id, until, error) =>
      exec("UPDATE wake_targets SET due_at=?, last_error=? WHERE id=?", [until, error, id]).pipe(
        done,
      ),
    rebase: (id, generation, through) =>
      exec(
        "UPDATE wake_targets SET generation=?, delivered_through=?, due_at=NULL, attempt_id=NULL WHERE id=?",
        [generation, through, id],
      ).pipe(done),
    record: (id, result) => {
      switch (result._tag) {
        case "Sent":
          // A message that arrived during the attempt is past `through`; it keeps the wake due,
          // after the cadence, or after only the host's minimum when one is urgent for this target.
          return exec(
            `UPDATE wake_targets SET delivered_through=MAX(delivered_through,?), last_attempt_at=?,
             last_sent_at=?, last_error=?, failures=0, attempt_id=NULL,
             due_at=CASE WHEN EXISTS (SELECT 1 FROM messages WHERE seq>?) THEN ?+CASE WHEN
               direct_chats='own' AND EXISTS (SELECT 1 FROM message_priority p
                 JOIN messages m ON m.seq=p.seq JOIN conversations c ON c.id=m.conversation_id
                 WHERE p.seq>? AND c.kind='direct' AND m.sender_id<>wake_targets.participant_id
                 AND (c.participant_low_id=wake_targets.participant_id
                   OR c.participant_high_id=wake_targets.participant_id))
               THEN min_interval_ms ELSE ${Policy.gapSql} END ELSE NULL END
             WHERE id=?`,
            [
              result.through,
              result.at,
              result.at,
              result.error,
              result.through,
              result.at,
              result.through,
              id,
            ],
          ).pipe(done);
        case "Failed":
          return exec(
            "UPDATE wake_targets SET failures=failures+1, last_attempt_at=?, last_error=?, due_at=? WHERE id=?",
            [result.at, result.reason, result.retryAt, id],
          ).pipe(done);
        case "Disabled":
          return exec(
            `UPDATE wake_targets SET disabled_at=?, disabled_reason=?, due_at=NULL, attempt_id=NULL,
             last_attempt_at=COALESCE(last_attempt_at,?) WHERE id=?`,
            [result.at, result.reason, result.at, id],
          ).pipe(done);
      }
    },
    sent: (participantId, fromHour) =>
      scalar("SELECT SUM(sent) AS count FROM wake_sends WHERE participant_id=? AND hour>=?", [
        participantId,
        fromHour,
      ]).pipe(Effect.map((count) => count ?? 0)),
    addSend: (participantId, hour) =>
      exec(
        "INSERT INTO wake_sends(participant_id,hour,sent) VALUES(?,?,1) ON CONFLICT(participant_id,hour) DO UPDATE SET sent=sent+1",
        [participantId, hour],
      ).pipe(done),
    recordTest: (id, at, outcome) =>
      exec(
        "INSERT INTO wake_tests(wake_id,tested_at,outcome) VALUES(?,?,?) ON CONFLICT(wake_id) DO UPDATE SET tested_at=excluded.tested_at, outcome=excluded.outcome",
        [id, at, outcome],
      ).pipe(done),
    defer: (id, until) =>
      exec("UPDATE wake_targets SET due_at=MAX(COALESCE(due_at,0),?) WHERE id=?", [until, id]).pipe(
        done,
      ),
  });
};
