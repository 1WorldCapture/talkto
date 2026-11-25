import { Option, Schema } from "effect";
import * as M from "@talkto/api/models";
import * as P from "@talkto/api/platform";
import {
  adminCalls,
  memoryMetering,
  readBurstMinutes,
  reads,
  taskOperationParts,
  taskOperations,
} from "@talkto/api/pricing";

/** A rate a minute that may be a fraction (1 every 10 minutes is 0.1). */
export const PerMinute = Schema.Number.check(
  Schema.isBetween({ minimum: 1 / 60, maximum: 1_000_000 }),
);
import type * as Pool from "../files/pool.js";
import * as FreePlan from "../free-plan.js";

/**
 * What a server spends from its organization's monthly budgets (docs/plan-limits.md):
 * - `read`: agent and API reads, under the organization's per-minute bucket, then its slow lane;
 * - `dashboard`: the web app's reads, counted in the same monthly read budget but never under the
 *   agents' bucket (each server bounds them per person instead);
 * - `admin`: admin calls, refused once the month's number is spent;
 * - `task`: task operations (create, claim, update), then a slow lane like reads. Counted in parts:
 *   an operation is `taskOperationParts`, a lease renewal `renewalWeight.parts`; every number a
 *   person or agent sees is in whole operations;
 * - `memory`: new commits on swarm memory. A commit has already landed when it is counted, so the
 *   lane never refuses: past the month's number it reports `slow`, and memory turns read-only.
 */
export const Lane = Schema.Literals(["read", "dashboard", "admin", "task", "memory"]);
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
  /** Task operations a month, then the slow lane's task operations a minute (0.1: 1 every 10). */
  taskMonthly: M.Count,
  taskSlowPerMinute: PerMinute,
  /** New commits on swarm memory a month. */
  memoryMonthly: M.Count,
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
  tasks: Month,
  /** New commits on swarm memory; `beyond` counts those that landed past the month's number. */
  memory: Month,
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
  taskMonthly: Schema.optionalKey(M.Count),
  taskSlowPerMinute: Schema.optionalKey(PerMinute),
  memoryMonthly: Schema.optionalKey(M.Count),
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
    taskMonthly: M.Count.make(overrides?.taskMonthly ?? taskOperations[plan].monthly),
    taskSlowPerMinute: overrides?.taskSlowPerMinute ?? taskOperations[plan].slowPerMinute,
    memoryMonthly: M.Count.make(overrides?.memoryMonthly ?? memoryMetering.editsMonthly[plan]),
    periodStart: iso(start),
    periodEnd: iso(end),
  };
};

/**
 * The largest read lease the quota object hands one server at a time: about six seconds of the
 * organization's steady rate (dashboard, admin and task leases: at most 10), at least 1 and at most
 * 100.
 * A lease may pass this only to cover reads already waiting, which spend it at once. A lease is
 * counted when granted, so a server's unspent balance is counted though never read. That balance is
 * under an eighth of what the server spent since it entered memory or its month began
 * (`budgets/client.ts`) and at most one less than this, or 2 when a deep read (3 units) is refused
 * after part of its lease. It is counted each time the server leaves memory with units left.
 */
export const maxLease = (lane: Lane, value: Terms) =>
  lane === "read"
    ? Math.max(1, Math.min(100, Math.floor(value.perMinute / 10)))
    : // Memory commits are few and counted exactly: a lease covers the commits being counted.
      lane === "memory"
      ? 1
      : // Task operations lease in parts: up to 10 operations' worth.
        lane === "task"
        ? 10 * taskOperationParts
        : 10;
/** Whole task operations in a count of parts (a renewal is a fifth of one). */
export const operations = (parts: number) => Math.floor(parts / taskOperationParts);
/** "1 a minute", "1 every 10 minutes": a slow lane as people read it. */
export const rate = (perMinute: number) =>
  perMinute >= 1
    ? `${count(perMinute)} a minute`
    : `1 every ${count(Math.round(1 / perMinute))} minutes`;

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
/** "1 second" or "12 seconds". */
export const seconds = (value: number) => `${value} second${value === 1 ? "" : "s"}`;
/**
 * The one "Wait N seconds" in a read refusal. The Worker finds it to give the refusal again with
 * the seconds left (`refusals.ts`), so every refusal writes it through here.
 */
export const waitFor = (value: number) => `Wait ${seconds(value)}`;
/** Why reads were slowed, naming the plan's numbers and what to do. */
export const readMessage = (value: Terms, slow: boolean, wait: number) =>
  slow
    ? `The organization has used the ${count(value.monthly)} reads a month that ${describePlan(value)} includes, until ${value.periodEnd}. Agents keep receiving, slowly: ${count(value.slowPerMinute)} read${value.slowPerMinute === 1 ? "" : "s"} a minute across the organization until then. ${waitFor(wait)}, then retry the same call; poll less often, and ask the organization owner about a larger plan.`
    : `The organization is reading faster than ${describePlan(value)} allows: ${count(value.perMinute)} reads a minute across all of its servers, with bursts up to ${count(value.burst)}. ${waitFor(wait)}, then retry the same call. Polling every 30–60 seconds as the monitoring procedure describes stays well under this.`;
/** Why an admin call was refused: the month's number is spent. */
export const adminMessage = (value: Terms, wait: number) =>
  `The organization has used the ${count(value.adminMonthly)} admin calls a month (registering, renaming, channels, signal links, wakes and refused sends) that ${describePlan(value)} includes, until ${value.periodEnd}. Messages and reads still work. Retry in ${seconds(wait)} at the earliest, or ask the organization owner about a larger plan.`;
/**
 * Why a task operation was slowed: the month's task operations are spent. Names when they reset
 * and that a larger plan raises them; the slow lane keeps a swarm moving until then.
 */
export const taskMessage = (value: Terms, wait: number) =>
  `The organization has used the ${count(value.taskMonthly)} task operations a month (creating, claiming, including empty claims, and updating tasks; a lease renewal counts a fifth) that ${describePlan(value)} includes. The allowance resets at ${value.periodEnd}. Until then task operations go through a slow lane: ${rate(value.taskSlowPerMinute)} across the organization. ${waitFor(wait)}, then retry with the same request key. Do not claim in a loop: when nothing is ready, wait for get_updates. Upgrading to a larger plan raises the allowance; ask the organization owner.`;
/** The same, for a person on the website: what they tried, in their terms, and no agent advice. */
export const websiteAdminMessage = (value: Terms, wait: number) =>
  `The organization has used the ${count(value.adminMonthly)} changes a month other than messages (such as agents joining or being renamed, channels, signal links, wake settings and wake tests) that ${describePlan(value)} includes, until ${value.periodEnd}. Messages and reading still work. Try again in ${seconds(wait)}, or ask the organization owner about a larger plan.`;
