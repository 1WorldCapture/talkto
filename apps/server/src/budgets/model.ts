import { Option, Schema } from "effect";
import * as M from "@talkto/api/models";
import * as P from "@talkto/api/platform";
import { adminCalls, readBurstMinutes, reads } from "@talkto/api/pricing";
import type * as Pool from "../files/pool.js";
import * as FreePlan from "../free-plan.js";

/**
 * What a server spends from its organization's monthly budgets (docs/plan-limits.md):
 * - `read`: agent and API reads, under the organization's per-minute bucket, then its slow lane;
 * - `dashboard`: the web app's reads, counted in the same monthly read budget but never under the
 *   agents' bucket (each server bounds them per person instead);
 * - `admin`: admin calls, refused once the month's number is spent.
 */
export const Lane = Schema.Literals(["read", "dashboard", "admin"]);
/** Parsed budget lane. */
export type Lane = typeof Lane.Type;
/** The plan whose numbers apply; organizations without a paid plan use Free's. */
export const BudgetPlan = Schema.Literals(["free", "shop", "studio", "factory"]);
/** Parsed budget plan. */
export type BudgetPlan = typeof BudgetPlan.Type;

/** The numbers that apply this month, as the quota object reports them to a server. */
export const Terms = Schema.Struct({
  plan: BudgetPlan,
  /** False when Free's numbers apply because the organization has no paid plan. */
  paid: Schema.Boolean,
  monthly: M.Count,
  perMinute: M.Count,
  burst: M.Count,
  slowPerMinute: M.Count,
  adminMonthly: M.Count,
  periodStart: M.Timestamp,
  periodEnd: M.Timestamp,
});
/** Parsed budget terms. */
export interface Terms extends Schema.Schema.Type<typeof Terms> {}

/** The quota object's answer to one lease request, returned as a value across Cloudflare RPC. */
export const Grant = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unlimited") }),
  Schema.Struct({
    kind: Schema.Literal("granted"),
    units: M.Count,
    /** The month's budget is spent: reads now come from the slow lane. */
    slow: Schema.Boolean,
    terms: Terms,
  }),
  Schema.Struct({
    kind: Schema.Literal("limited"),
    retryAfterSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 })),
    slow: Schema.Boolean,
    terms: Terms,
  }),
]);
/** Parsed lease answer. */
export type Grant = typeof Grant.Type;

/** A lease request from one server. */
export const Request = Schema.Struct({
  accountId: P.AccountId,
  serverId: M.ServerId,
  lane: Lane,
  want: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  /**
   * Units that spends already waiting on this lease will use at once; the lease may cover them
   * past `maxLease`. Absent from servers built before it.
   */
  needed: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
/** Parsed lease request. */
export interface Request extends Schema.Schema.Type<typeof Request> {}

/** One lane's monthly count as the quota object reports it. */
export const Month = Schema.Struct({
  used: M.Count,
  /** Reads admitted through the slow lane after the monthly budget, counted apart. */
  beyond: M.Count,
  limit: M.Count,
});
/** The organization's budgets this month. */
export const Usage = Schema.Struct({
  terms: Schema.NullOr(Terms),
  reads: Month,
  admin: Month,
});
/** Parsed budget usage. */
export interface Usage extends Schema.Schema.Type<typeof Usage> {}

/** Operator or test numbers that replace a plan's; each field is optional. */
export const Overrides = Schema.Struct({
  monthly: Schema.optionalKey(M.Count),
  perMinute: Schema.optionalKey(M.Count),
  burst: Schema.optionalKey(M.Count),
  slowPerMinute: Schema.optionalKey(M.Count),
  adminMonthly: Schema.optionalKey(M.Count),
});
/** Parsed overrides. */
export interface Overrides extends Schema.Schema.Type<typeof Overrides> {}

const day = 86_400_000;
/**
 * A renewal Stripe confirms a little after the period ends keeps the paid plan's numbers: for this
 * long after a paid period ends, the next period is assumed to start where the last one ended,
 * which is where a renewal starts, so the renewal continues the same count.
 */
export const renewalGraceMillis = 3 * day;
const iso = (ms: number) => M.Timestamp.make(new Date(ms).toISOString());

/**
 * The numbers and month that apply at `now`. A current paid period applies with its own dates; a
 * paid period that ended less than `renewalGraceMillis` ago continues from its end; otherwise
 * Free's numbers apply per UTC calendar month (Free, trials and organizations without a plan).
 */
export const terms = (
  paid: Option.Option<Pool.PlanPeriod>,
  now: number,
  overrides: Overrides | null,
): Terms => {
  const period = Option.match(paid, {
    onNone: () => null,
    onSome: (value) => {
      const start = Date.parse(value.start);
      const end = Date.parse(value.end);
      if (start <= now && now < end) return { plan: value.plan, start, end };
      if (end <= now && now < end + renewalGraceMillis)
        return { plan: value.plan, start: end, end: end + renewalGraceMillis };
      return null;
    },
  });
  const plan: BudgetPlan = period?.plan ?? "free";
  const start = period?.start ?? FreePlan.monthStart(now);
  const end = period?.end ?? FreePlan.nextMonth(now);
  const perMinute = overrides?.perMinute ?? reads[plan].perMinute;
  return {
    plan,
    paid: period !== null,
    monthly: M.Count.make(overrides?.monthly ?? reads[plan].monthly),
    perMinute: M.Count.make(perMinute),
    burst: M.Count.make(overrides?.burst ?? perMinute * readBurstMinutes),
    slowPerMinute: M.Count.make(overrides?.slowPerMinute ?? reads[plan].slowPerMinute),
    adminMonthly: M.Count.make(overrides?.adminMonthly ?? adminCalls[plan]),
    periodStart: iso(start),
    periodEnd: iso(end),
  };
};

/**
 * The largest read lease the quota object hands one server at a time: about six seconds of the
 * organization's steady rate (dashboard and admin leases: at most 10), at least 1 and at most 100.
 * A lease may pass this only to cover reads already waiting, which spend it at once. A lease is
 * counted when granted, so a server's unspent balance is counted though never read. That balance is
 * under an eighth of what the server spent since it entered memory or its month began
 * (`budgets/client.ts`) and at most one less than this, or 2 when a deep read (3 units) is refused
 * after part of its lease. It is counted each time the server leaves memory with units left.
 */
export const maxLease = (lane: Lane, value: Terms) =>
  lane === "read" ? Math.max(1, Math.min(100, Math.floor(value.perMinute / 10))) : 10;

/** A token bucket as stored: `tokens` saved up at `at` (epoch milliseconds). */
export interface Bucket {
  readonly tokens: number;
  readonly at: number;
}
/** Refill a bucket to `now` at `perMinute`, never above `capacity`. A new bucket starts full. */
export const refill = (
  bucket: Bucket | null,
  perMinute: number,
  capacity: number,
  now: number,
): number =>
  bucket === null
    ? capacity
    : Math.min(capacity, bucket.tokens + (Math.max(0, now - bucket.at) * perMinute) / 60_000);
/** Seconds until one token is available again, at least 1 and at most an hour. */
export const waitSeconds = (tokens: number, perMinute: number) =>
  Math.min(3600, Math.max(1, Math.ceil(((1 - tokens) * 60) / Math.max(perMinute, 1 / 60))));
/** Seconds until the month ends, at least 1 and at most an hour (callers retry hourly). */
export const untilEnd = (value: Terms, now: number) =>
  Math.min(3600, Math.max(1, Math.ceil((Date.parse(value.periodEnd) - now) / 1000)));

const planNames: Record<BudgetPlan, string> = {
  free: "Free",
  shop: "Shop",
  studio: "Studio",
  factory: "Factory",
};
/** "the organization's Shop plan" or, without a paid plan, "Free's limits, which apply without a paid plan". */
export const describePlan = (value: Terms) =>
  value.paid
    ? `the organization's ${planNames[value.plan]} plan`
    : "the Free limits that apply to an organization without a paid plan";
const count = (value: number) => value.toLocaleString("en-US");
/** Why reads were slowed, naming the plan's numbers and what to do. */
export const readMessage = (value: Terms, slow: boolean, wait: number) =>
  slow
    ? `The organization has used the ${count(value.monthly)} reads a month that ${describePlan(value)} includes, until ${value.periodEnd}. Agents keep receiving, slowly: ${count(value.slowPerMinute)} read${value.slowPerMinute === 1 ? "" : "s"} a minute across the organization until then. Wait ${wait} seconds, then retry the same call; poll less often, and ask the organization owner about a larger plan.`
    : `The organization is reading faster than ${describePlan(value)} allows: ${count(value.perMinute)} reads a minute across all of its servers, with bursts up to ${count(value.burst)}. Wait ${wait} seconds, then retry the same call. Polling every 30–60 seconds as the monitoring procedure describes stays well under this.`;
/** Why an admin call was refused: the month's number is spent. */
export const adminMessage = (value: Terms, wait: number) =>
  `The organization has used the ${count(value.adminMonthly)} admin calls a month (registering, renaming, channels, signal links, wakes and refused sends) that ${describePlan(value)} includes, until ${value.periodEnd}. Messages and reads still work. Retry in ${wait} seconds at the earliest, or ask the organization owner about a larger plan.`;
