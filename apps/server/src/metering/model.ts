import { Context, Effect, Schema } from "effect";
import * as M from "@talkto/api/models";
import * as P from "@talkto/api/platform";
import * as U from "@talkto/api/metering";
import * as E from "@talkto/api/errors";
import type * as B from "@talkto/api/billing";

/** Every server block holds this many units, so no single operation may cost more. */
export const blockUnits = 32;
/**
 * The longest a server keeps a block open across sends (docs/message-metering.md). Allocating and
 * closing a block wrote about 11 rows; a held block serves later sends with no quota call. Reported
 * usage lags by this much at most.
 */
export const holdSeconds = 1800;
/** What funds a period: a paid invoice, the card-backed trial, the no-card free start, or a Free plan month. */
export const PeriodKind = Schema.Literals(["paid", "trial", "starter", "free"]);
/** Parsed funding source. */
export type PeriodKind = typeof PeriodKind.Type;
/**
 * Capacity can only be spent during this period; trials and the free start never include courtesy
 * capacity. A starter period has no end (`end: null`): it lasts until spent or until a paid period
 * replaces it, and it never refills. Its unspent messages carry into that first paid period once.
 */
export const Period = Schema.Struct({
  accountId: P.AccountId,
  start: M.Timestamp,
  end: Schema.NullOr(M.Timestamp),
  allowance: M.Count,
  overdraft: M.Count,
  kind: Schema.optionalKey(PeriodKind),
});
export interface Period extends Schema.Schema.Type<typeof Period> {}
/** The free-start period's own counters; `end` is set only when a paid period replaced it. */
export interface StarterPeriod {
  readonly start: M.Timestamp;
  readonly end: M.Timestamp | null;
  readonly allowance: number;
  /** Share-link messages added on top of `allowance`; absent from authorities built before them. */
  readonly bonus?: number;
  readonly used: number;
  readonly reserved: number;
}
/** One Free plan month and its own counters; `retired` once a paid period replaced Free. */
export interface FreePeriod {
  readonly start: M.Timestamp;
  readonly end: M.Timestamp;
  readonly allowance: number;
  /** Share-link messages added to this month on top of `allowance`. */
  readonly bonus?: number;
  readonly used: number;
  readonly reserved: number;
  readonly retired: boolean;
}
/** A block a server holds open in the current period: its ID, its server and its size. */
export interface OpenBlock {
  readonly id: M.RequestKey;
  readonly serverId: M.ServerId;
  readonly capacity: number;
}
/** The workspace usage with the blocks behind `outstanding`, so a reader can count exactly. */
export interface HeldUsage {
  readonly usage: U.Usage;
  /** Empty when nothing is outstanding. */
  readonly blocks: ReadonlyArray<OpenBlock>;
}
/**
 * What the quota authority did with a share-link bonus: `added` to the free allowance,
 * `not_added` (no free allowance now), or `no_period` (nothing opened yet; not recorded, ask again).
 */
export type BonusOutcome = "added" | "not_added" | "no_period";
/** The quota authority's answer to a share-link bonus. */
export interface BonusAnswer {
  readonly outcome: BonusOutcome;
}
/** A durable server allocation; request identity is generated and retained by the server. */
export const Allocation = Schema.Struct({
  id: M.RequestKey,
  serverId: M.ServerId,
  periodStart: M.Timestamp,
  /** Null for a block of the nonexpiring free start. */
  periodEnd: Schema.NullOr(M.Timestamp),
  capacity: M.Count,
  used: M.Count,
  closed: Schema.Boolean,
});
export interface Allocation extends Schema.Schema.Type<typeof Allocation> {}
/** The coordinator returns business errors as values across Cloudflare RPC. */
export const Result = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("allocated"),
    allocation: Allocation,
    /**
     * How long the server may keep the block open; 0 or absent (an authority from before holds)
     * closes it at the server's next pass. Servers from before holds ignore it.
     */
    holdSeconds: Schema.optionalKey(M.Count),
  }),
  Schema.Struct({ kind: Schema.Literal("exhausted"), periodEnd: Schema.NullOr(M.Timestamp) }),
  Schema.Struct({
    kind: Schema.Literal("payment_required"),
    periodEnd: Schema.NullOr(M.Timestamp),
  }),
  Schema.Struct({ kind: Schema.Literal("pending"), periodEnd: Schema.NullOr(M.Timestamp) }),
]);
export type Result = typeof Result.Type;
/** One consumption must fit inside a single capacity block, so it can never exceed a block. */
export const Units = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: blockUnits })).pipe(
  Schema.brand("Units"),
);
/** Parsed spend size for one metered operation. */
export type Units = typeof Units.Type;
/** What every persisted message costs, and the default spend of any metered operation. */
export const singleUnit = Units.make(1);
/** The journal ID of one commit on swarm memory, which counts as a message (`memoryMetering`). */
export const MemoryUsageId = Schema.String.check(Schema.isUUID(4)).pipe(
  Schema.brand("MemoryUsageId"),
);
export type MemoryUsageId = typeof MemoryUsageId.Type;
/**
 * What one journal row counts: a message, or a commit on swarm memory. The journal's `message_id`
 * column has no foreign key and `kind` stays `message`, so an older Worker and the quota object
 * read the journal unchanged.
 */
export type UsageId = M.MessageId | MemoryUsageId;
/** Journalled operation class; shares stay countable per server and period before any price exists. */
export const UsageKind = Schema.Literals(["message", "share"]);
/** Parsed operation class for the usage journal. */
export type UsageKind = typeof UsageKind.Type;
/** Internal control flow: the synchronous transaction rolls back before network refill. */
export class CapacityRequired extends Schema.TaggedError<CapacityRequired>()(
  "CapacityRequired",
  {},
) {}
export type Failure = E.MessageAllowanceExhausted | E.MessagePaymentRequired | E.SendingUnavailable;
/** Local atomic consumption and external refill share one durable server ledger. */
export class Meter extends Context.Service<
  Meter,
  {
    /**
     * Journal one metered operation. Wrapping implementations must forward `units`
     * and `kind`; dropping them would silently meter a surcharged operation as one message.
     */
    readonly consume: (
      usageId: UsageId,
      units?: Units,
      kind?: UsageKind,
    ) => Effect.Effect<void, CapacityRequired | E.StorageUnavailable>;
    /** Acquire a block large enough for `units`, which the failed consumption reported. */
    readonly refill: (units?: Units) => Effect.Effect<void, Failure>;
  }
>()("@talkto/metering/Meter") {}
/** Explicit standalone/test mode; hosted composition supplies the real meter. */
export const unmetered = Meter.of({ consume: () => Effect.void, refill: () => Effect.void });
/** What one `share_file` spends: the message unit plus the deployment's configured surcharge. */
export class ShareCost extends Context.Service<ShareCost, { readonly units: () => Units }>()(
  "@talkto/metering/ShareCost",
) {}
/** Billing publishes paid periods and reads usage through this application-owned port. */
export class Quotas extends Context.Service<
  Quotas,
  {
    readonly publish: (
      accountId: P.AccountId,
      period: {
        readonly start: M.Timestamp;
        readonly end: M.Timestamp;
        readonly allowance: number;
        readonly kind?: "paid" | "trial";
      } | null,
    ) => Effect.Effect<boolean, E.SendingUnavailable>;
    /**
     * End the paid period that starts at `start` at `at`, because its payment was refunded or
     * disputed. Idempotent; false where messages are not counted or no such paid period exists.
     */
    readonly revoke: (
      accountId: P.AccountId,
      period: { readonly start: M.Timestamp; readonly at: M.Timestamp },
    ) => Effect.Effect<boolean, E.SendingUnavailable>;
    /** Undo `revoke` for the period that starts at `start` (a dispute was won). Idempotent. */
    readonly restore: (
      accountId: P.AccountId,
      start: M.Timestamp,
    ) => Effect.Effect<void, E.SendingUnavailable>;
    /**
     * Open the organization's one nonexpiring free-start allowance. Accepted only while the
     * authority has never held a period, and idempotent for the same grant start; a replay after
     * a paid period replaced it returns false and changes nothing.
     */
    readonly publishStarter: (
      accountId: P.AccountId,
      grant: { readonly start: M.Timestamp; readonly allowance: number },
    ) => Effect.Effect<boolean, E.SendingUnavailable>;
    /**
     * Put the organization on the Free plan from `start`: accepted on an organization that never
     * held a period, or one whose free start is still in use (it ends at `start` without carrying
     * over). Idempotent for the same start; false where messages are not counted.
     */
    readonly publishFree: (
      accountId: P.AccountId,
      start: M.Timestamp,
    ) => Effect.Effect<boolean, E.SendingUnavailable>;
    /**
     * Add one share-link bonus (`id` names it) to the organization's free allowance. Idempotent
     * for the same ID: a retry returns the first outcome. `not_added` where messages are not counted.
     */
    readonly addBonus: (
      accountId: P.AccountId,
      bonus: { readonly id: string; readonly messages: number },
    ) => Effect.Effect<BonusOutcome, E.SendingUnavailable>;
    readonly read: (accountId: P.AccountId) => Effect.Effect<U.Usage, E.SendingUnavailable>;
    /**
     * `read`, with `counted` set when servers hold blocks: reported usage plus what each holder
     * has committed but not reported yet. Asks only the servers holding blocks, once each, and
     * leaves `counted` out when any of them cannot answer. Read-only: it never closes a block.
     */
    readonly readCounted: (accountId: P.AccountId) => Effect.Effect<U.Usage, E.SendingUnavailable>;
    /** The latest Free plan month, if the organization ever joined Free; null where not counted. */
    readonly readFree: (
      accountId: P.AccountId,
    ) => Effect.Effect<FreePeriod | null, E.SendingUnavailable>;
    /** The free-start period, if one was ever opened; null where messages are not counted. */
    readonly readStarter: (
      accountId: P.AccountId,
    ) => Effect.Effect<StarterPeriod | null, E.SendingUnavailable>;
    /**
     * Record the confirmed paid plan so the organization's stored-file pool follows it. Applies to
     * every organization, metered or not; a missing paid period leaves the unpaid pool in force.
     */
    readonly publishStorage: (
      accountId: P.AccountId,
      period: {
        readonly plan: B.Plan;
        readonly start: M.Timestamp;
        readonly end: M.Timestamp;
      } | null,
    ) => Effect.Effect<void, E.SendingUnavailable>;
  }
>()("@talkto/metering/Quotas") {}
export const unavailable = (operation: string, periodEnd: M.Timestamp | null = null) =>
  new E.SendingUnavailable({
    operation,
    periodEnd,
    retryable: true,
    action: "retry_same_request",
    message:
      "Sending capacity is being synchronized. Retry with the same message request key; do not register another identity.",
  });
/** The workspace cannot fund another spend of this size in the current period. */
export const exhausted = (periodEnd: M.Timestamp | null) =>
  new E.MessageAllowanceExhausted({
    periodEnd,
    retryable: false,
    action: "contact_workspace_owner",
    message:
      "The organization message allowance is exhausted. Stop retrying new sends and notify the organization owner. Sending resumes after new capacity is confirmed; history remains readable.",
  });
/** Interpret capacity outcomes consistently for both public transports. */
export const requireAllocation = (result: Result) => {
  switch (result.kind) {
    case "allocated":
      return Effect.succeed(result.allocation);
    case "pending":
      return Effect.fail(unavailable("allocation.pending", result.periodEnd));
    case "payment_required":
      return Effect.fail(
        new E.MessagePaymentRequired({
          periodEnd: result.periodEnd,
          retryable: false,
          action: "contact_workspace_owner",
          message:
            "No current message allowance is confirmed. Ask the organization owner to check billing. History remains readable; signing in again will not help.",
        }),
      );
    case "exhausted":
      return Effect.fail(exhausted(result.periodEnd));
  }
};
/**
 * Spend capacity for one operation, refilling once when the current block cannot fund it.
 *
 * `CapacityRequired` is internal control flow: the caller's synchronous transaction must
 * roll back before the network refill, so the whole operation is retried, not just the spend.
 *
 * @param meter - The meter that owns both the consumption and the refill.
 * @param units - The spend the retried operation needs, so the refilled block can fund it.
 * @returns A combinator that turns `CapacityRequired` into a refill, one retry, and a typed failure.
 */
export const withCapacity =
  (meter: Meter["Service"], units: Units = singleUnit) =>
  <A, F>(operation: Effect.Effect<A, F | CapacityRequired>) =>
    operation.pipe(
      Effect.catchTag("CapacityRequired", () =>
        meter.refill(units).pipe(
          Effect.flatMap(() => operation),
          Effect.catchTag("CapacityRequired", () => Effect.fail(unavailable("allocation.changed"))),
        ),
      ),
    );
