import { Option, Schema } from "effect";
import * as M from "@talkto/api/models";
import type * as Pool from "../files/pool.js";
import * as Model from "./model.js";

const monthRow = Schema.Struct({ used: M.Count, beyond: M.Count });
const bucketRow = Schema.Struct({ tokens: Schema.Number, at: Schema.Number });
const decodeMonth = Schema.decodeUnknownSync(monthRow);
const decodeBucket = Schema.decodeUnknownSync(bucketRow);
/** Months older than this are forgotten; the table holds a year of history at most. */
const keepMillis = 400 * 86_400_000;
/**
 * Counts and buckets are kept in memory and saved at most this often. Saving on every lease wrote
 * two rows per lease, the largest single cost of a read (docs/cost-measured-2026-11-17.md).
 */
export const saveMillis = 60_000;
/**
 * Cloudflare hibernates a Durable Object after 10 seconds without a request or alarm, and drops
 * its memory. A call that comes this long after the one before is isolated: nothing may keep the
 * object in memory until a later save, so its months are saved at once (one row each). The alarm
 * also saves once no call has come for this long.
 */
export const quietMillis = 5_000;
/**
 * While counts are unsaved, the alarm is due at most this long after the last call, so it runs
 * before the object can hibernate. Each time it finds calls still coming, it is due again this
 * long after the latest one.
 */
export const tailMillis = 5_000;

/**
 * The organization's read and admin budgets, kept in its quota object beside message capacity and
 * the file pool (docs/plan-limits.md). Servers lease small blocks of units and spend them locally,
 * so the quota object sees one call per block, not per read. A lease counts in full when granted,
 * so a server's unspent balance is counted though never read (see `Model.maxLease`). Every call
 * runs synchronously, so leases from different servers never race.
 *
 * Counts and token buckets live in memory. An isolated call saves its months at once. Otherwise
 * counts wait for the alarm, which runs `tailMillis` after the last call while calls keep coming
 * and saves once they stop (`quietMillis`), or once the last save is a minute old (`saveMillis`):
 * a busy object writes its counts once a minute, and an object going idle writes them before it
 * can hibernate. Buckets are saved only with the alarm's and the once-a-minute saves, never on
 * their own: an idle organization's bucket refills anyway, and after a restart it is as full as it
 * was saved. Counts are lost only if the object restarts with counts unsaved for another reason (a
 * deploy or a runtime restart) or its alarm runs more than 5 seconds late. The loss is at most the
 * minute since the last save, and it makes the month count low, never high.
 */
export function make(
  storage: DurableObjectStorage,
  clock: () => number,
  plan: () => Option.Option<Pool.PlanPeriod>,
  overrides: () => Model.Overrides | null,
) {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS budget_months(lane TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0,beyond INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(lane,start)) STRICT;
    CREATE TABLE IF NOT EXISTS budget_buckets(name TEXT PRIMARY KEY,tokens REAL NOT NULL,at INTEGER NOT NULL) STRICT;
  `);
  interface Month {
    readonly lane: "read" | "admin";
    readonly start: string;
    end: string;
    used: number;
    beyond: number;
  }
  const months = new Map<string, Month>();
  const buckets = new Map<string, Model.Bucket>();
  const unsavedMonths = new Set<string>();
  const unsavedBuckets = new Set<string>();
  // What storage holds is current when the object starts, so the first full save waits a minute.
  let savedAt = clock();
  let lastCallAt: number | null = null;
  const monthOf = (lane: "read" | "admin", terms: Model.Terms): Month => {
    const key = `${lane} ${terms.periodStart}`;
    const known = months.get(key);
    if (known !== undefined) return known;
    const row = storage.sql
      .exec(
        "SELECT used,beyond FROM budget_months WHERE lane=? AND start=?",
        lane,
        terms.periodStart,
      )
      .toArray()[0];
    const stored = row === undefined ? { used: 0, beyond: 0 } : decodeMonth(row);
    const loaded: Month = { lane, start: terms.periodStart, end: terms.periodEnd, ...stored };
    months.set(key, loaded);
    return loaded;
  };
  const month = (lane: "read" | "admin", terms: Model.Terms) => {
    const { used, beyond } = monthOf(lane, terms);
    return { used, beyond };
  };
  const count = (lane: "read" | "admin", terms: Model.Terms, used: number, beyond: number) => {
    const known = monthOf(lane, terms);
    known.used += used;
    known.beyond += beyond;
    known.end = terms.periodEnd;
    unsavedMonths.add(`${lane} ${terms.periodStart}`);
  };
  const bucketOf = (name: string): Model.Bucket | null => {
    const known = buckets.get(name);
    if (known !== undefined) return known;
    const row = storage.sql
      .exec("SELECT tokens,at FROM budget_buckets WHERE name=?", name)
      .toArray()[0];
    if (row === undefined) return null;
    const stored = decodeBucket(row);
    buckets.set(name, stored);
    return stored;
  };
  /** Take up to `want` tokens from a bucket, returning what was taken and the tokens left. */
  const take = (name: string, perMinute: number, capacity: number, want: number, now: number) => {
    const tokens = Model.refill(bucketOf(name), perMinute, capacity, now);
    const taken = Math.min(want, Math.floor(tokens));
    buckets.set(name, { tokens: tokens - taken, at: now });
    unsavedBuckets.add(name);
    return { taken, left: tokens - taken };
  };
  /**
   * Write unsaved counts, and unless `monthsOnly`, unsaved buckets too and forget months past the
   * history window.
   */
  const write = (monthsOnly: boolean) => {
    const now = clock();
    storage.transactionSync(() => {
      for (const key of unsavedMonths) {
        const value = months.get(key);
        if (value === undefined) continue;
        storage.sql.exec(
          `INSERT INTO budget_months(lane,start,end,used,beyond) VALUES(?,?,?,?,?)
           ON CONFLICT(lane,start) DO UPDATE SET used=excluded.used,beyond=excluded.beyond,end=excluded.end`,
          value.lane,
          value.start,
          value.end,
          value.used,
          value.beyond,
        );
      }
      if (monthsOnly) return;
      for (const name of unsavedBuckets) {
        const value = buckets.get(name);
        if (value === undefined) continue;
        storage.sql.exec(
          "INSERT INTO budget_buckets(name,tokens,at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET tokens=excluded.tokens,at=excluded.at",
          name,
          value.tokens,
          value.at,
        );
      }
      const oldest = new Date(now - keepMillis).toISOString();
      storage.sql.exec("DELETE FROM budget_months WHERE end<?", oldest);
      for (const [key, value] of months) if (value.end < oldest) months.delete(key);
    });
    unsavedMonths.clear();
    if (monthsOnly) return;
    unsavedBuckets.clear();
    savedAt = now;
  };
  /** Write unsaved counts and buckets, and forget months past the history window. */
  const save = () => write(false);
  const unsaved = () => unsavedMonths.size > 0 || unsavedBuckets.size > 0;
  /** Save what this call counted at once, or leave it for the alarm (`due`). */
  const settle = () => {
    const now = clock();
    const gap = lastCallAt === null ? Number.POSITIVE_INFINITY : now - lastCallAt;
    lastCallAt = now;
    if (!unsaved()) return;
    const elapsed = now - savedAt;
    // A clock that moved backwards (a test clock) saves at once rather than never.
    if (elapsed >= saveMillis || elapsed < 0) return save();
    if (gap >= quietMillis && unsavedMonths.size > 0) write(true);
  };
  const current = () => {
    const now = clock();
    return { now, terms: Model.terms(plan(), now, overrides()) };
  };
  return {
    /** Lease up to `want` units for one server. Business outcomes are values, never thrown. */
    lease: (input: Model.Request): Model.Grant => {
      const request = Schema.decodeUnknownSync(Model.Request)(input);
      const grant = ((): Model.Grant => {
        const { now, terms } = current();
        // Reads already waiting are spent at once, so they may take a lease past `maxLease`;
        // only the part beyond them is ever left unspent.
        const want = Math.min(
          request.want,
          Math.max(Model.maxLease(request.lane, terms), request.needed ?? 0),
        );
        if (request.lane === "admin") {
          const spent = month("admin", terms).used;
          const remaining = terms.adminMonthly - spent;
          if (remaining <= 0)
            return {
              kind: "limited",
              retryAfterSeconds: Model.untilEnd(terms, now),
              slow: true,
              terms,
            };
          const units = Math.min(want, remaining);
          count("admin", terms, units, 0);
          return { kind: "granted", units: M.Count.make(units), slow: false, terms };
        }
        const spent = month("read", terms).used;
        const remaining = terms.monthly - spent;
        // The web app's reads never wait on the agents' bucket. On Free's numbers (Free, the
        // trial, no plan) they are not counted at all, and the month never slows them (owner,
        // November 22, 2026). On a paid plan they count in the month; past the budget they count
        // apart, and each server slows them per person.
        if (request.lane === "dashboard" && terms.plan === "free")
          return { kind: "granted", units: M.Count.make(want), slow: false, terms };
        if (request.lane === "dashboard") {
          const within = Math.max(0, Math.min(want, remaining));
          count("read", terms, within, want - within);
          return {
            kind: "granted",
            units: M.Count.make(want),
            slow: spent + within >= terms.monthly,
            terms,
          };
        }
        if (remaining > 0) {
          const { taken, left } = take(
            "read",
            terms.perMinute,
            terms.burst,
            Math.min(want, remaining),
            now,
          );
          if (taken < 1)
            return {
              kind: "limited",
              retryAfterSeconds: Model.waitSeconds(left, terms.perMinute),
              slow: false,
              terms,
            };
          count("read", terms, taken, 0);
          return { kind: "granted", units: M.Count.make(taken), slow: false, terms };
        }
        // The slow lane: one read at a time, at most a minute's worth saved up.
        const { taken, left } = take(
          "slow",
          terms.slowPerMinute,
          Math.max(1, terms.slowPerMinute),
          1,
          now,
        );
        if (taken < 1)
          return {
            kind: "limited",
            retryAfterSeconds: Model.waitSeconds(left, terms.slowPerMinute),
            slow: true,
            terms,
          };
        count("read", terms, 0, taken);
        return { kind: "granted", units: M.Count.make(taken), slow: true, terms };
      })();
      settle();
      return grant;
    },
    /**
     * When the alarm must run (epoch milliseconds), or null when no count is unsaved: `tailMillis`
     * after the last call, and never more than a minute after the last save. Buckets alone never
     * schedule it.
     */
    due: (): number | null =>
      unsavedMonths.size > 0
        ? Math.min(savedAt + saveMillis, (lastCallAt ?? savedAt) + tailMillis)
        : null,
    /**
     * The quota object's alarm: save once no call has come for `quietMillis` or the last save is a
     * minute old. Otherwise calls are still coming, the object stays in memory, and the alarm is
     * due again (`due`).
     */
    alarm: () => {
      if (!unsaved()) return;
      const now = clock();
      const quiet = lastCallAt === null || now - lastCallAt >= quietMillis || now < lastCallAt;
      const stale = now - savedAt >= saveMillis || now < savedAt;
      if (quiet || stale) save();
    },
    /** This month's counts, for Billing and verification. */
    read: (): Model.Usage => {
      const { terms } = current();
      const reads = month("read", terms);
      const admin = month("admin", terms);
      return {
        terms,
        reads: {
          used: M.Count.make(reads.used),
          beyond: M.Count.make(reads.beyond),
          limit: terms.monthly,
        },
        admin: {
          used: M.Count.make(admin.used),
          beyond: M.Count.make(admin.beyond),
          limit: terms.adminMonthly,
        },
      };
    },
  };
}
