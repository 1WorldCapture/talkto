import { Option, Schema } from "effect";
import * as M from "@talkto/api/models";
import * as P from "@talkto/api/platform";
import * as Pool from "./pool.js";

const reservationRow = Schema.Struct({
  serverId: M.ServerId,
  bytes: M.Count,
  expiresAt: M.Timestamp,
});
const totalRow = Schema.Struct({
  reservedBytes: M.Count,
  reservations: M.Count,
  nextExpiryAt: Schema.NullOr(M.Timestamp),
});
const decodeReservation = Schema.decodeUnknownSync(reservationRow);
const decodeTotal = Schema.decodeUnknownSync(totalRow);
const decodePlan = Schema.decodeUnknownSync(Pool.PlanPeriod);

/**
 * The organization's stored-file pool, kept inside the organization's quota object so every
 * server's reservation is checked against one serialized total. A reservation is exact, not a
 * block: transfers are rare and large, and a block held by one server would strand space that
 * another server needs. Each call runs in one synchronous transaction, so concurrent sends from
 * different servers can never both take the last space.
 */
export function make(
  storage: DurableObjectStorage,
  env: Env,
  clock: () => M.Timestamp,
  /** Whether the organization is on the standing Free plan, as its quota object knows it. */
  onFree: () => boolean = () => false,
) {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS storage_account(singleton INTEGER PRIMARY KEY CHECK(singleton=1),account_id TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS storage_plan(singleton INTEGER PRIMARY KEY CHECK(singleton=1),account_id TEXT NOT NULL,plan TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS storage_reservations(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes>=0),expires_at TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS storage_reservations_expiry ON storage_reservations(expires_at);
    CREATE INDEX IF NOT EXISTS storage_reservations_server ON storage_reservations(server_id);
  `);
  /** One quota object belongs to one organization; a different caller is a wiring defect. */
  const bind = (accountId: P.AccountId) => {
    const row = storage.sql
      .exec<{ account_id: string }>("SELECT account_id FROM storage_account WHERE singleton=1")
      .toArray()[0];
    if (row === undefined)
      storage.sql.exec("INSERT INTO storage_account(singleton,account_id) VALUES(1,?)", accountId);
    else if (row.account_id !== accountId)
      throw new Error("Storage pool organization cannot change");
  };
  const plan = () => {
    const row = storage.sql
      .exec("SELECT account_id AS accountId,plan,start,end FROM storage_plan WHERE singleton=1")
      .toArray()[0];
    return row === undefined ? Option.none() : Option.some(decodePlan(row));
  };
  /** Expired reservations free their space; the bucket's lifecycle rule removes their bytes. */
  const totals = (at: M.Timestamp) => {
    storage.sql.exec("DELETE FROM storage_reservations WHERE expires_at<=?", at);
    return decodeTotal(
      storage.sql
        .exec(
          "SELECT COALESCE(SUM(bytes),0) AS reservedBytes,COUNT(*) AS reservations,MIN(expires_at) AS nextExpiryAt FROM storage_reservations",
        )
        .one(),
    );
  };
  const limit = (accountId: P.AccountId, at: M.Timestamp) =>
    Pool.limitBytes(Pool.limits(env), accountId, plan(), at, onFree());
  return {
    /** The paid plan billing last confirmed, current or lapsed; none for an organization that never paid. */
    plan,
    /** Reserve once per transfer. A repeat of the same transfer renews nothing and counts nothing. */
    reserve: (input: Pool.Request): Pool.Outcome => {
      const request = Schema.decodeUnknownSync(Pool.Request)(input);
      return storage.transactionSync(() => {
        bind(request.accountId);
        const at = clock();
        const ceiling = limit(request.accountId, at);
        const current = totals(at);
        const prior = storage.sql
          .exec(
            "SELECT server_id AS serverId,bytes,expires_at AS expiresAt FROM storage_reservations WHERE id=?",
            request.id,
          )
          .toArray()[0];
        if (prior !== undefined) {
          const row = decodeReservation(prior);
          if (row.serverId !== request.serverId || row.bytes !== request.bytes)
            throw new Error("Storage reservation identity conflict");
          return { kind: "reserved" };
        }
        if (current.reservedBytes + request.bytes > ceiling)
          return {
            kind: "full",
            limitBytes: ceiling,
            reservedBytes: current.reservedBytes,
            nextExpiryAt: current.nextExpiryAt,
          };
        storage.sql.exec(
          "INSERT INTO storage_reservations(id,server_id,bytes,expires_at) VALUES(?,?,?,?)",
          request.id,
          request.serverId,
          request.bytes,
          request.expiresAt,
        );
        return { kind: "reserved" };
      });
    },
    /** A deleted server's objects are removed with it, so its reservations stop counting. */
    release: (input: { readonly accountId: P.AccountId; readonly serverId: M.ServerId }) => {
      const request = Schema.decodeUnknownSync(
        Schema.Struct({ accountId: P.AccountId, serverId: M.ServerId }),
      )(input);
      storage.transactionSync(() => {
        bind(request.accountId);
        storage.sql.exec("DELETE FROM storage_reservations WHERE server_id=?", request.serverId);
      });
    },
    /**
     * Record the paid plan billing confirmed. A later period replaces an earlier one, and the
     * same period may change plan; an older observation arriving late is ignored.
     */
    publish: (input: Pool.PlanPeriod) => {
      const value = Schema.decodeUnknownSync(Pool.PlanPeriod)(input);
      if (value.start >= value.end) throw new Error("Invalid storage plan period");
      return storage.transactionSync(() => {
        bind(value.accountId);
        const existing = plan();
        if (Option.isSome(existing) && existing.value.start > value.start) return { ok: false };
        storage.sql.exec(
          "INSERT INTO storage_plan(singleton,account_id,plan,start,end) VALUES(1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET plan=excluded.plan,start=excluded.start,end=excluded.end",
          value.accountId,
          value.plan,
          value.start,
          value.end,
        );
        return { ok: true };
      });
    },
    read: (accountId: P.AccountId): Pool.Usage => {
      const parsed = Schema.decodeUnknownSync(P.AccountId)(accountId);
      const at = clock();
      const current = storage.transactionSync(() => totals(at));
      const paid = plan();
      return {
        limitBytes: limit(parsed, at),
        reservedBytes: current.reservedBytes,
        reservations: current.reservations,
        plan: Option.match(paid, { onNone: () => null, onSome: (value) => value.plan }),
        planEnd: Option.match(paid, { onNone: () => null, onSome: (value) => value.end }),
        nextExpiryAt: current.nextExpiryAt,
        asOf: at,
      };
    },
  };
}
