import { DateTime, Effect, Result, Schema } from "effect";
import * as M from "@talkto/api/models";
import * as Model from "./model.js";

/** What the shared database learns about one message: identity, order and time. Never its text. */
export const Reference = Schema.Struct({
  id: M.MessageId,
  sequence: M.Sequence,
  createdAt: M.Timestamp,
});
/** Parsed message reference. */
export interface Reference extends Schema.Schema.Type<typeof Reference> {}
/** Internal snapshot exported from immutable server history; never a public authorization bypass. */
export const Batch = Schema.Struct({
  serverId: M.ServerId,
  items: Schema.Array(Reference),
  through: M.Count,
  caughtUp: Schema.Boolean,
  asOf: M.Timestamp,
});
/** Parsed projection batch. */
export interface Batch extends Schema.Schema.Type<typeof Batch> {}
const unavailable = () =>
  new Model.Failure({
    code: "storage_unavailable",
    message: "Activity indexing is temporarily unavailable.",
  });

/** Replay one page atomically. The source sequence is the durable outbox position. */
export const publish = Effect.fn("ActivityProjection.publish")(function* (
  database: D1Database,
  batch: Batch,
  after: number,
) {
  const db = database.withSession("first-primary");
  // Encode the parsed references only, so no other field of a message can reach this database.
  const json = JSON.stringify(Schema.encodeSync(Schema.Array(Reference))(batch.items));
  const previous = "COALESCE((SELECT sequence FROM activity_progress WHERE server_id=?),0)";
  // Items are in sequence order, so the last one is the newest message this batch indexes.
  const lastMessageAt = batch.items.at(-1)?.createdAt ?? null;
  yield* Effect.tryPromise({
    try: () =>
      db.batch([
        db
          .prepare(`INSERT OR IGNORE INTO activity_events(account_id,server_id,message_id,sequence,created_at)
        SELECT s.account_id,s.id,json_extract(j.value,'$.id'),json_extract(j.value,'$.sequence'),json_extract(j.value,'$.createdAt')
        FROM servers s,json_each(?) j WHERE s.id=? AND s.deletion_requested_at IS NULL AND ${previous}=?`)
          .bind(json, batch.serverId, batch.serverId, after),
        db
          .prepare(`INSERT INTO activity_progress(server_id,sequence,checked_at,caught_up,last_message_at)
        SELECT ?,?,?,?,? WHERE ${previous}=? AND EXISTS(SELECT 1 FROM servers WHERE id=? AND deletion_requested_at IS NULL)
        ON CONFLICT(server_id) DO UPDATE SET sequence=excluded.sequence,checked_at=MAX(activity_progress.checked_at,excluded.checked_at),caught_up=excluded.caught_up,
          last_message_at=COALESCE(MAX(activity_progress.last_message_at,excluded.last_message_at),activity_progress.last_message_at,excluded.last_message_at)
        WHERE excluded.sequence>=activity_progress.sequence`)
          .bind(
            batch.serverId,
            batch.through,
            batch.asOf,
            batch.caughtUp ? 1 : 0,
            lastMessageAt,
            batch.serverId,
            after,
            batch.serverId,
          ),
      ]),
    catch: unavailable,
  });
});

/** Read the acknowledged sequence before asking a server for another bounded export. */
export const position = Effect.fn("ActivityProjection.position")(function* (
  database: D1Database,
  serverId: M.ServerId,
) {
  const row = yield* Effect.tryPromise({
    try: () =>
      database
        .withSession("first-primary")
        .prepare("SELECT sequence FROM activity_progress WHERE server_id=?")
        .bind(serverId)
        .first(),
    catch: unavailable,
  });
  const value = yield* Schema.decodeUnknownEffect(
    Schema.NullOr(Schema.Struct({ sequence: M.Count })),
  )(row).pipe(Effect.mapError(unavailable));
  return value?.sequence ?? 0;
});

/** Servers one scheduled repair pass asks to export: 1,200 an hour at one pass a minute. */
export const repairBatch = 20;
/**
 * How often a caught-up server is checked anyway. A send arms the server's own alarm, which
 * exports until caught up, so a caught-up server needs no hourly visit; this weekly sweep only
 * catches an alarm that was lost after the last export. Each later send repairs that too.
 */
export const sweepDays = 7;

/**
 * Repair missed wakeups and backfill old servers in fair, bounded scheduled passes. A pass picks
 * servers never exported, servers whose last export was behind (`caught_up=0`) and servers not
 * checked for `sweepDays`; an idle, caught-up server is not woken.
 */
export const repair = Effect.fn("ActivityProjection.repair")(function* (
  database: D1Database,
  servers: Env["SERVERS"],
) {
  const now = yield* DateTime.now;
  // Rotate the bounded batch before RPCs, including failures and interrupted runs, so a failing
  // server is retried after the others instead of blocking them. A failed export leaves its
  // progress unchanged, so the server stays a candidate. Only publish() may advance the
  // successful projection checkpoint.
  const rows = yield* Effect.tryPromise({
    try: () =>
      database
        .withSession("first-primary")
        .prepare(`UPDATE servers SET activity_repair_at=MAX(activity_repair_at,?) WHERE id IN (
      SELECT s.id FROM servers s LEFT JOIN activity_progress p ON p.server_id=s.id
      WHERE s.status='ready' AND s.deletion_requested_at IS NULL AND (p.server_id IS NULL OR p.caught_up=0 OR p.checked_at<?)
      ORDER BY s.activity_repair_at,COALESCE(p.checked_at,''),s.id LIMIT ?)
      RETURNING id`)
        .bind(
          DateTime.formatIso(now),
          DateTime.formatIso(DateTime.subtract(now, { days: sweepDays })),
          repairBatch,
        )
        .all(),
    catch: unavailable,
  });
  const ids = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: M.ServerId })))(
    rows.results,
  ).pipe(Effect.mapError(unavailable));
  const results = yield* Effect.forEach(
    ids,
    ({ id }) =>
      Effect.tryPromise({
        try: () => servers.getByName(id).projectActivity(),
        catch: unavailable,
      }).pipe(Effect.result),
    { concurrency: 5 },
  );
  if (results.some((r) => r._tag === "Failure")) return yield* unavailable();
});

/**
 * How long the shared database keeps message references. Home ranks the past 30 minutes and the
 * account feed pages recent activity; full history stays in each server's own database.
 */
export const retentionDays = 30;
/** One prune statement's rows, and the statements one scheduled run may issue. */
export const pruneLimits = { rows: 1000, statements: 5 } as const;

/**
 * Delete references created before the retention window, oldest delivery first, in small
 * statements so no run holds D1 for long; a backlog drains over successive minutes. Each statement
 * reads only the oldest `rows` references by primary key, so a caught-up run reads at most that
 * many rows. A reference indexed late with an old creation time waits behind newer deliveries and
 * is removed at the latest one retention window after its delivery. Resolves to the rows deleted.
 */
export const prune = Effect.fn("ActivityProjection.prune")(function* (
  database: D1Database,
  limits: { readonly rows: number; readonly statements: number } = pruneLimits,
) {
  const now = yield* DateTime.now;
  const cutoff = DateTime.formatIso(DateTime.subtract(now, { days: retentionDays }));
  const db = database.withSession("first-primary");
  let deleted = 0;
  for (let statement = 0; statement < limits.statements; statement++) {
    const result = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(`DELETE FROM activity_events WHERE id IN (
        SELECT id FROM (SELECT id,created_at FROM activity_events ORDER BY id LIMIT ?) WHERE created_at<?)`)
          .bind(limits.rows, cutoff)
          .run(),
      catch: unavailable,
    });
    deleted += result.meta.changes;
    if (result.meta.changes === 0) break;
  }
  return deleted;
});

/** The minute cron's activity stage: repair missed exports and enforce retention independently. */
export const maintain = Effect.fn("ActivityProjection.maintain")(function* (
  database: D1Database,
  servers: Env["SERVERS"],
) {
  const [repaired, pruned] = yield* Effect.all(
    [repair(database, servers).pipe(Effect.result), prune(database).pipe(Effect.result)],
    { concurrency: 2 },
  );
  if (Result.isFailure(repaired)) return yield* repaired.failure;
  if (Result.isFailure(pruned)) return yield* pruned.failure;
});
