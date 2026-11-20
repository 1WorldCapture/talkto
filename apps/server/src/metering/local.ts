import { DateTime, Effect, Schema, Semaphore } from "effect";
import * as M from "@talkto/api/models";
import * as P from "@talkto/api/platform";
import * as Model from "./model.js";

const rowSchema = Schema.Struct({
  id: M.RequestKey,
  state: Schema.Literals(["pending", "active", "closing"]),
  periodStart: Schema.NullOr(M.Timestamp),
  periodEnd: Schema.NullOr(M.Timestamp),
  capacity: M.Count,
  used: M.Count,
});
const decode = Schema.decodeUnknownSync(rowSchema);
const columns =
  "id,state,period_start AS periodStart,period_end AS periodEnd,capacity,used FROM message_allocation WHERE singleton=1";
const select = `SELECT ${columns}`;
/** The block with its hold: null for today's short hold, closed at the next pass. */
const heldSchema = Schema.Struct({ ...rowSchema.fields, holdUntil: Schema.NullOr(M.Timestamp) });
const decodeHeld = Schema.decodeUnknownSync(heldSchema);
type Held = typeof heldSchema.Type;
const selectHeld = `SELECT hold_until AS holdUntil,${columns}`;
const time = () => M.Timestamp.make(DateTime.formatIso(DateTime.nowUnsafe()));
const iso = (ms: number) => M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(ms)));
/**
 * Whether an active block stays open at `at`: its hold has not ended, it can still fund a message,
 * and its period has not ended. A block with no hold closes at the next pass.
 */
const holding = (row: Held, at: M.Timestamp) =>
  row.holdUntil !== null &&
  at < row.holdUntil &&
  row.used < row.capacity &&
  (row.periodEnd === null || at < row.periodEnd);

/** Per-server capacity and committed-usage journal; all consumption runs in the message transaction. */
export function make(
  storage: DurableObjectStorage,
  namespace: Env["QUOTAS"],
  accountId: P.AccountId,
  serverId: M.ServerId,
  clock: () => M.Timestamp = time,
) {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS message_allocation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL,state TEXT NOT NULL,period_start TEXT,period_end TEXT,capacity INTEGER NOT NULL DEFAULT 0,used INTEGER NOT NULL DEFAULT 0,hold_until TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS message_usage(message_id TEXT PRIMARY KEY,allocation_id TEXT NOT NULL,period_start TEXT NOT NULL,committed_at TEXT NOT NULL,units INTEGER NOT NULL DEFAULT 1,kind TEXT NOT NULL DEFAULT 'message') STRICT;
    CREATE INDEX IF NOT EXISTS message_usage_allocation ON message_usage(allocation_id);
  `);
  // Servers journalled before metered units recorded one message per row; the defaults restate that.
  const columns = storage.sql.exec<{ name: string }>("PRAGMA table_info(message_usage)").toArray();
  if (!columns.some((column) => column.name === "units"))
    storage.sql.exec("ALTER TABLE message_usage ADD COLUMN units INTEGER NOT NULL DEFAULT 1");
  if (!columns.some((column) => column.name === "kind"))
    storage.sql.exec("ALTER TABLE message_usage ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'");
  // Blocks allocated before holds have none, so they close at the next pass as they always did.
  const allocationColumns = storage.sql
    .exec<{ name: string }>("PRAGMA table_info(message_allocation)")
    .toArray();
  if (!allocationColumns.some((column) => column.name === "hold_until"))
    storage.sql.exec("ALTER TABLE message_allocation ADD COLUMN hold_until TEXT");
  const lock = Semaphore.makeUnsafe(1);
  const read = () => {
    const row = storage.sql.exec(selectHeld).toArray()[0];
    return row === undefined ? null : decodeHeld(row);
  };
  const remote = () => namespace.getByName(accountId);
  const request = Effect.fn("Metering.allocate")(function* (id: M.RequestKey) {
    const result = yield* Effect.tryPromise({
      try: async () => await remote().allocate({ id, serverId }),
      catch: () => Model.unavailable("allocate"),
    });
    // The authority returns an existing grant before checking payment. These outcomes
    // therefore prove this request acquired no capacity; ambiguous failures retain it.
    if (result.kind === "payment_required" || result.kind === "exhausted")
      storage.sql.exec("DELETE FROM message_allocation WHERE id=? AND state='pending'", id);
    // An authority from before holds sends none: today's short hold. Never longer than ours.
    const hold = result.kind === "allocated" ? (result.holdSeconds ?? 0) : 0;
    const allocation = yield* Model.requireAllocation(result);
    return { allocation, holdSeconds: Math.max(0, Math.min(Model.holdSeconds, hold)) };
  });
  const install = (
    id: M.RequestKey,
    { allocation, holdSeconds }: { allocation: Model.Allocation; holdSeconds: number },
  ) =>
    storage.transactionSync(() => {
      if (allocation.closed) {
        storage.sql.exec("DELETE FROM message_allocation WHERE id=? AND state='pending'", id);
        return;
      }
      // The hold runs from when this server installs the block, and ends with the period.
      const until =
        holdSeconds === 0
          ? null
          : Math.min(
              Date.parse(clock()) + holdSeconds * 1000,
              allocation.periodEnd === null
                ? Number.POSITIVE_INFINITY
                : Date.parse(allocation.periodEnd),
            );
      storage.sql.exec(
        "UPDATE message_allocation SET state='active',period_start=?,period_end=?,capacity=?,hold_until=? WHERE id=? AND state='pending'",
        allocation.periodStart,
        allocation.periodEnd,
        allocation.capacity,
        until === null ? null : iso(until),
        id,
      );
    });
  /**
   * Close the block and report it. `force` closes a held block too (reports, deletion, refills);
   * the alarm pass leaves a held block open until its hold ends, it fills, or its period ends.
   * `only` closes the block only if it is that allocation: a recall that arrives after the server
   * replaced the block it named finds that block already closed, and leaves the new one open.
   */
  const settle = Effect.fn("Metering.close")(function* (force: boolean, only?: M.RequestKey) {
    if (only !== undefined && read()?.id !== only) return;
    const pending = read();
    if (pending?.state === "pending") {
      const recovered = yield* request(pending.id);
      install(pending.id, recovered);
    }
    const open = read();
    if (!force && open !== null && open.state === "active" && holding(open, clock())) return;
    // The state transition fences consumption before crossing the RPC boundary.
    const row = storage.transactionSync(() => {
      const value = read();
      if (value !== null && value.state === "active")
        storage.sql.exec("UPDATE message_allocation SET state='closing' WHERE singleton=1");
      return value;
    });
    if (row === null || row.state === "pending") return;
    yield* Effect.tryPromise({
      try: () => remote().close({ id: row.id, serverId, used: row.used }),
      catch: () => Model.unavailable("close", row.periodEnd),
    });
    storage.sql.exec(
      "DELETE FROM message_allocation WHERE singleton=1 AND id=? AND state='closing'",
      row.id,
    );
  });
  const refill = Effect.fn("Metering.refill")(function* (units: Model.Units) {
    const active = read();
    const at = clock();
    if (
      active?.state === "active" &&
      active.used + units <= active.capacity &&
      (active.periodEnd === null || at < active.periodEnd) &&
      (active.holdUntil === null || at < active.holdUntil)
    )
      return;
    if (active?.state !== "pending") yield* settle(true);
    const id = storage.transactionSync(() => {
      const current = read();
      if (current !== null) return current.id;
      const next = M.RequestKey.make(crypto.randomUUID());
      storage.sql.exec(
        "INSERT INTO message_allocation(singleton,id,state) VALUES(1,?,'pending')",
        next,
      );
      return next;
    });
    const granted = yield* request(id);
    install(id, granted);
    // A fresh block is capped by what the period has left. A spend that still does not fit
    // cannot be funded before renewal, so report exhaustion instead of refilling forever.
    const installed = read();
    if (installed !== null && installed.used + units > installed.capacity)
      return yield* Model.exhausted(granted.allocation.periodEnd);
  });
  const meter = Model.Meter.of({
    consume: Effect.fn("Metering.consume")(function* (
      messageId: M.MessageId,
      units: Model.Units = Model.singleUnit,
      kind: Model.UsageKind = "message",
    ) {
      const row = read();
      const at = clock();
      if (
        row === null ||
        row.state !== "active" ||
        row.periodStart === null ||
        at < row.periodStart ||
        // An active block without an end belongs to the nonexpiring free start.
        (row.periodEnd !== null && at >= row.periodEnd) ||
        // A block past its hold is closed and replaced, so reported usage lags by the hold at most.
        (row.holdUntil !== null && at >= row.holdUntil) ||
        row.used + units > row.capacity
      )
        return yield* new Model.CapacityRequired({});
      storage.sql.exec("UPDATE message_allocation SET used=used+? WHERE singleton=1", units);
      storage.sql.exec(
        "INSERT INTO message_usage(message_id,allocation_id,period_start,committed_at,units,kind) VALUES(?,?,?,?,?,?)",
        messageId,
        row.id,
        row.periodStart,
        at,
        units,
        kind,
      );
    }),
    refill: (units: Model.Units = Model.singleUnit) => lock.withPermits(1)(refill(units)),
  });
  return {
    meter,
    /**
     * When this server's block next needs a pass: now or earlier while a close or recovery is
     * outstanding, the end of its hold while it is held, or null without a block.
     */
    due: (): M.Timestamp | null => {
      const row = read();
      if (row === null) return null;
      const at = clock();
      if (row.state !== "active" || row.holdUntil === null || !holding(row, at)) return at;
      return row.holdUntil;
    },
    settle: (force: boolean, only?: M.RequestKey) =>
      lock
        .withPermits(1)(settle(force, only))
        .pipe(
          Effect.catchTag(
            ["MessageAllowanceExhausted", "MessagePaymentRequired"],
            () => Effect.void,
          ),
        ),
  };
}

/**
 * Messages this server has committed against its current block but not yet reported to the quota
 * authority, and the block's ID so a reader can match it to the authority's open block. Read-only:
 * it never creates the journal or contacts the authority.
 */
export function unreported(storage: DurableObjectStorage) {
  const table = storage.sql
    .exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_allocation'")
    .toArray()[0];
  if (table === undefined) return null;
  const row = storage.sql.exec(select).toArray()[0];
  if (row === undefined) return null;
  const value = decode(row);
  return value.state === "pending" || value.periodStart === null
    ? null
    : { id: value.id, periodStart: value.periodStart, used: value.used };
}

/** Metered messages a server committed in a time range, and the UTC days they fell on. */
export interface Activity {
  readonly messages: number;
  /** Distinct UTC days (`YYYY-MM-DD`), oldest first. */
  readonly days: ReadonlyArray<string>;
}
const ActivityRows = Schema.Array(Schema.Struct({ day: Schema.String, n: M.Count }));
/**
 * Metered operations (agent messages and file shares) this server committed in `[from, to)`, from
 * its own usage journal, for share-link qualification (docs/share-links-spec.md). People's messages
 * and TalkTo's notices are never metered, so they never count. Read-only: a server that never
 * metered anything answers zero.
 */
export function activity(
  storage: DurableObjectStorage,
  from: M.Timestamp,
  to: M.Timestamp,
): Activity {
  const table = storage.sql
    .exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_usage'")
    .toArray()[0];
  if (table === undefined) return { messages: 0, days: [] };
  const rows = Schema.decodeUnknownSync(ActivityRows)(
    storage.sql
      .exec(
        "SELECT substr(committed_at,1,10) AS day,COUNT(*) AS n FROM message_usage WHERE committed_at>=? AND committed_at<? GROUP BY day ORDER BY day",
        from,
        to,
      )
      .toArray(),
  );
  return {
    messages: rows.reduce((sum, row) => sum + row.n, 0),
    days: rows.map((row) => row.day),
  };
}
