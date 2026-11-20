import { Context, Effect, Schema } from "effect";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as Share from "@talkto/api/share";

/*
  Share links (docs/share-links-spec.md): the application's ports. D1 owns links, referrals and
  bonus records; servers answer how many metered messages they committed; the quota authority adds
  bonuses to the free allowance; Stripe answers card fingerprints; a flag source answers whether an
  organization is flagged.
*/

/** Share-link records or a provider could not be reached; retrying is safe. */
export class Unavailable extends Schema.TaggedError<Unavailable>()("ShareUnavailable", {
  operation: Schema.String,
  message: Schema.String,
}) {
  /** Shared operational code for scheduled-stage reporting. */
  get code() {
    return "storage_unavailable" as const;
  }
}
export const unavailable = (operation: string) =>
  new Unavailable({
    operation,
    message: "Share links are temporarily unavailable. Try again.",
  });

/** Where a referral stands. */
export type ReferralStatus = Share.Referral["status"];
/** Why a referral was excluded at qualification. */
export type Exclusion = "flagged" | "same_card";
/** Who a bonus is for: the link's owner, or the organization that joined. */
export type Side = "sharer" | "joined";

/** One organization owner's link. */
export interface Link {
  readonly code: Share.Code;
  readonly accountId: P.AccountId;
  readonly ownerId: P.UserId;
  readonly createdAt: M.Timestamp;
}
/** One accepted sign-up. */
export interface Referral {
  readonly id: string;
  readonly code: Share.Code;
  readonly sharerAccountId: P.AccountId;
  readonly sharerOwnerId: P.UserId;
  readonly accountId: P.AccountId;
  readonly ownerId: P.UserId;
  readonly joinedAt: M.Timestamp;
  readonly windowStart: M.Timestamp;
  readonly windowEnd: M.Timestamp;
  readonly status: ReferralStatus;
  readonly settledAt: M.Timestamp | null;
}
/** One bonus record. */
export interface Bonus {
  readonly referralId: string;
  readonly side: Side;
  readonly accountId: P.AccountId;
  readonly ownerId: P.UserId;
  readonly status: Share.BonusStatus;
  readonly appliedAt: M.Timestamp | null;
  readonly createdAt: M.Timestamp;
}
/** A referral about to be recorded, with its first check time. */
export interface Joining extends Referral {
  readonly nextCheckAt: M.Timestamp;
}
/** A referral with the sharer's bonus, as the owner's list shows it. */
export interface Listed extends Referral {
  readonly bonus: Bonus | null;
}
/** What decides whether a sign-up is new: the organization's free-start claim time, if any. */
export interface Newness {
  readonly claimedAt: M.Timestamp | null;
  readonly createdAt: M.Timestamp;
}
/** Why an atomic join recorded nothing. */
export type JoinOutcome =
  | { readonly kind: "joined"; readonly referral: Referral }
  | { readonly kind: "already_joined" | "link_full" };

type Operation<A> = Effect.Effect<A, Unavailable>;
/** D1 records. Every write that must happen once is one conditional statement or batch. */
export class Store extends Context.Service<
  Store,
  {
    readonly link: (accountId: P.AccountId) => Operation<Link | null>;
    readonly linkByCode: (code: Share.Code) => Operation<Link | null>;
    /** Insert the organization's link unless it has one; returns the link it has. */
    readonly createLink: (link: Link) => Operation<Link>;
    /** The organization's free-start claim time (null without one) and creation time. */
    readonly newness: (accountId: P.AccountId) => Operation<Newness | null>;
    /** Whether a person is an active member of an organization. */
    readonly member: (accountId: P.AccountId, userId: P.UserId) => Operation<boolean>;
    /** The referral an organization joined with, with its own bonus. */
    readonly joined: (
      accountId: P.AccountId,
    ) => Operation<{ readonly referral: Referral; readonly bonus: Bonus | null } | null>;
    /** The link's referrals, newest first, each with the sharer's bonus. At most `limit`. */
    readonly referrals: (code: Share.Code, limit: number) => Operation<ReadonlyArray<Listed>>;
    /** Whether the owner has received `sharerLimit` bonuses or the link took `signupsPerLink`. */
    readonly exhausted: (link: Link) => Operation<boolean>;
    /**
     * Record a join and its `joined` bonus in one batch, only while the link has room and neither
     * the organization nor its owner joined before.
     */
    readonly join: (referral: Joining) => Operation<JoinOutcome>;
    /** Waiting referrals due a check at `now`, oldest due first. */
    readonly due: (now: M.Timestamp, limit: number) => Operation<ReadonlyArray<Referral>>;
    /**
     * Mark a waiting referral qualified and insert the sharer's bonus in one batch, unless the
     * sharer already has `sharerLimit` (then `capped`). Returns the status it ended with; a
     * referral no longer waiting keeps its status.
     */
    readonly qualify: (referral: Referral, at: M.Timestamp) => Operation<ReferralStatus>;
    /** End a waiting referral without a bonus. */
    readonly settle: (
      referralId: string,
      status: "excluded" | "expired",
      reason: Exclusion | null,
      at: M.Timestamp,
    ) => Operation<void>;
    /** Schedule a waiting referral's next check. */
    readonly recheck: (
      referralId: string,
      checkedAt: M.Timestamp,
      next: M.Timestamp,
    ) => Operation<void>;
    /** Pending bonuses, oldest first. */
    readonly pending: (limit: number) => Operation<ReadonlyArray<Bonus>>;
    /** Record what the quota authority did with a pending bonus. */
    readonly applied: (
      bonus: Pick<Bonus, "referralId" | "side">,
      status: "added" | "not_added",
      at: M.Timestamp,
    ) => Operation<void>;
    /** Ready servers of an organization. */
    readonly servers: (accountId: P.AccountId) => Operation<ReadonlyArray<M.ServerId>>;
  }
>()("@talkto/share/Store") {}

/** Metered messages and their UTC days on each of an organization's servers. */
export class Activity extends Context.Service<
  Activity,
  {
    /** Null when any server could not answer; the check runs again later. */
    readonly metered: (
      servers: ReadonlyArray<M.ServerId>,
      from: M.Timestamp,
      to: M.Timestamp,
    ) => Effect.Effect<{ readonly messages: number; readonly days: ReadonlySet<string> } | null>;
  }
>()("@talkto/share/Activity") {}

/** Adds bonuses to free allowances (the quota authority); idempotent per bonus ID. */
export class Allowances extends Context.Service<
  Allowances,
  {
    readonly add: (
      accountId: P.AccountId,
      id: string,
    ) => Operation<"added" | "not_added" | "no_period">;
    /** Whether the organization has a free allowance now (a free start or a Free plan month). */
    readonly free: (accountId: P.AccountId) => Operation<boolean>;
  }
>()("@talkto/share/Allowances") {}

/**
 * Whether two organizations saved the same card. Stripe payment method fingerprints, read when
 * asked and never stored. Organizations without a payment customer have no card.
 */
export class Cards extends Context.Service<
  Cards,
  { readonly shared: (a: P.AccountId, b: P.AccountId) => Operation<boolean> }
>()("@talkto/share/Cards") {}
/** No billing configured: no organization has a card. */
export const noCards = Cards.of({ shared: () => Effect.succeed(false) });

/**
 * Whether an organization is flagged as fraudulent. TalkTo records disputes; it does not record
 * Stripe Radar early fraud warnings or reviews. A Radar adapter answers the same question here.
 */
export class Flags extends Context.Service<
  Flags,
  { readonly flagged: (accountId: P.AccountId) => Operation<boolean> }
>()("@talkto/share/Flags") {}

/** The environment's share-link settings. */
export interface Configuration {
  /** `TALKTO_SHARE_LINKS_ENABLED` and an open free start: links, joins and checks run. */
  readonly enabled: boolean;
  /** The public origin links are built on, for example `https://talkto.sh`. */
  readonly origin: string;
}
