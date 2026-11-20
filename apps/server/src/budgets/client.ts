import { Schema } from "effect";
import * as Model from "./model.js";

/** What spending from a lane decided. `slow` reports that the month's read budget is spent. */
export type Outcome =
  | { readonly kind: "admitted"; readonly slow: boolean }
  | {
      readonly kind: "limited";
      readonly retryAfterSeconds: number;
      readonly slow: boolean;
      readonly terms: Model.Terms;
    };

/** A failed or malformed lease call admits reads uncounted for this long, then asks again. */
export const outageMillis = 5_000;
/** An unlimited organization asks again after this long, in case a grant was removed. */
export const unlimitedMillis = 3_600_000;
/** Lease sizes follow what this server spent in the last window of this length. */
const windowMillis = 10_000;
/**
 * A lease grows past what waiting spends need by at most this fraction of what this object has
 * spent since it entered memory or its month began. What is left when the object leaves memory was
 * counted but never read, so it stays under an eighth of what the object read, and a burst of up to
 * 16 reads is counted exactly. Doubling leases within a burst counted up to 78% more than was read.
 */
const leaseShare = 8;
/**
 * A spend that this many leases did not cover is refused for a second, never admitted uncounted.
 * The first lease of a burst is sized for the first spend alone and each later one covers up to 100
 * waiting units, so only bursts of more than about 700 units waiting at once get here.
 */
const maxPasses = 8;
const decodeGrant = Schema.decodeUnknownSync(Model.Grant);

interface LaneState {
  balance: number;
  periodEnd: number;
  limitedUntil: number;
  limited: Extract<Outcome, { kind: "limited" }> | null;
  openUntil: number;
  slow: boolean;
  windowStart: number;
  windowCount: number;
  previousCount: number;
  /** Units spent since this object entered memory or its last month began. */
  spent: number;
  /** Units of the spends waiting for a lease, which it is sized to cover. */
  waiting: number;
  /** Leases granted so far, so a spend knows whether the balance came from the one it waited for. */
  grants: number;
  /** The terms of the last answer, for a refusal this object makes itself. */
  terms: Model.Terms | null;
  refilling: Promise<void> | null;
}
const fresh = (): LaneState => ({
  balance: 0,
  periodEnd: 0,
  limitedUntil: 0,
  limited: null,
  openUntil: 0,
  slow: false,
  windowStart: 0,
  windowCount: 0,
  previousCount: 0,
  spent: 0,
  waiting: 0,
  grants: 0,
  terms: null,
  refilling: null,
});

/**
 * One server's view of its organization's budgets (docs/plan-limits.md). Units are spent from a
 * local balance leased from the quota object; a lease is requested only when the balance cannot
 * cover a spend. It covers every spend waiting then (concurrent spends share one lease call); past
 * that, it follows what this server spent in the last ten seconds, and is never more than an
 * eighth of what it spent since it entered memory or the month began (`leaseShare`). A refusal is
 * remembered until its retry time, so a refused agent costs no quota call. Memory only: eviction
 * forgets the balance, which the quota object already counted, so the month counts it as read (see
 * `Model.maxLease`).
 */
export const make = (
  lease: (lane: Model.Lane, want: number, needed: number) => Promise<Model.Grant>,
  clock: () => number,
) => {
  const lanes = new Map<Model.Lane, LaneState>();
  const state = (lane: Model.Lane) => {
    const existing = lanes.get(lane);
    if (existing !== undefined) return existing;
    const created = fresh();
    lanes.set(lane, created);
    return created;
  };
  const note = (s: LaneState, units: number, now: number) => {
    if (now - s.windowStart >= windowMillis) {
      s.previousCount = now - s.windowStart < 2 * windowMillis ? s.windowCount : 0;
      s.windowStart = now;
      s.windowCount = 0;
    }
    s.windowCount += units;
    s.spent += units;
  };
  const refill = async (lane: Model.Lane, s: LaneState) => {
    // Every spend waiting now, so concurrent reads are all counted by one lease.
    const needed = Math.min(100, Math.max(1, s.waiting - s.balance));
    const recent = Math.max(s.windowCount, s.previousCount);
    const want = Math.min(
      100,
      Math.max(needed, Math.min(recent, Math.floor(s.spent / leaseShare))),
    );
    let grant: Model.Grant;
    try {
      grant = decodeGrant(await lease(lane, want, needed));
    } catch {
      s.openUntil = clock() + outageMillis;
      return;
    }
    const now = clock();
    if (grant.kind !== "unlimited") s.terms = grant.terms;
    switch (grant.kind) {
      case "unlimited":
        s.openUntil = now + unlimitedMillis;
        return;
      case "granted":
        // Never admit a spend uncounted: a grant of nothing refuses for a second instead.
        if (grant.units < 1) {
          s.limitedUntil = now + 1000;
          s.limited = {
            kind: "limited",
            retryAfterSeconds: 1,
            slow: grant.slow,
            terms: grant.terms,
          };
          return;
        }
        s.balance += grant.units;
        s.slow = grant.slow;
        s.periodEnd = Date.parse(grant.terms.periodEnd);
        s.grants++;
        return;
      case "limited":
        s.slow = grant.slow;
        s.limitedUntil = now + grant.retryAfterSeconds * 1000;
        s.limited = {
          kind: "limited",
          retryAfterSeconds: grant.retryAfterSeconds,
          slow: grant.slow,
          terms: grant.terms,
        };
        return;
    }
  };
  return {
    /** Spend `units` from `lane`, leasing more when the balance cannot cover them. */
    spend: async (lane: Model.Lane, units: number): Promise<Outcome> => {
      const s = state(lane);
      // The lease this spend waited for, if one was granted while it waited.
      let awaited = -1;
      // Each pass answers, or waits for a lease that grants at least a unit, refuses or opens.
      // Waiting spends resume in the order they waited, so each is served or refused in turn;
      // a spend is admitted uncounted only while the quota object is unreachable or unlimited.
      for (let pass = 0; ; pass++) {
        const now = clock();
        // A lease belongs to its month; what an earlier lease left at the boundary was counted
        // there, and the new month's leases grow from its own reads. The lease a spend waited for
        // is spent even if its month has already ended on this server's clock: the quota object's
        // clock decides the month, and this one may run ahead of it.
        if (s.periodEnd !== 0 && now >= s.periodEnd && s.grants !== awaited) {
          s.balance = 0;
          s.periodEnd = 0;
          s.slow = false;
          s.spent = 0;
        }
        if (now < s.openUntil) return { kind: "admitted", slow: s.slow };
        if (now < s.limitedUntil && s.limited !== null)
          return {
            ...s.limited,
            retryAfterSeconds: Math.max(1, Math.ceil((s.limitedUntil - now) / 1000)),
          };
        if (s.balance >= units) {
          s.balance -= units;
          note(s, units, now);
          return { kind: "admitted", slow: s.slow };
        }
        if (pass >= maxPasses && s.terms !== null) {
          s.limitedUntil = now + 1000;
          s.limited = { kind: "limited", retryAfterSeconds: 1, slow: s.slow, terms: s.terms };
          return s.limited;
        }
        const before = s.grants;
        s.waiting += units;
        try {
          s.refilling ??= refill(lane, s).finally(() => {
            s.refilling = null;
          });
          await s.refilling;
        } finally {
          s.waiting -= units;
        }
        if (s.grants !== before) awaited = s.grants;
      }
    },
    /** Whether the last lease said the month's read budget is spent. */
    slow: (lane: Model.Lane) => lanes.get(lane)?.slow ?? false,
  };
};
/** One server's budget client. */
export type Client = ReturnType<typeof make>;
