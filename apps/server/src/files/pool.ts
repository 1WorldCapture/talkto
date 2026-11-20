import { Context, Effect, Option, Schema } from "effect";
import * as B from "@talkto/api/billing";
import * as E from "@talkto/api/errors";
import * as M from "@talkto/api/models";
import * as P from "@talkto/api/platform";
import { free, storageGigabytes } from "@talkto/api/pricing";
import * as Entitlements from "../account-entitlements.js";

/** Pool sizes are sold in decimal gigabytes. */
export const gigabyte = 1_000_000_000;
/**
 * The pool of an organization without an active paid plan: trials, lapsed plans and deployments
 * where billing is disabled. Enough to try sending a project folder or a few builds, small enough
 * that an unpaid organization cannot hold meaningful storage. `TALKTO_STORAGE_UNPAID_BYTES` overrides it.
 */
export const defaultUnpaidBytes = 5 * gigabyte;
/** The Free plan's pool (owner decision, November 16, 2026), in place of the unpaid pool. */
export const freeBytes = free.storageGigabytes * gigabyte;
/** The pool a paid plan includes. */
export const planBytes = (plan: B.Plan) => storageGigabytes[plan] * gigabyte;

/** What one transfer holds in the pool until it expires: its payload plus a folder's file list. */
export const Reservation = Schema.Struct({
  id: M.TransferId,
  bytes: M.Count,
  expiresAt: M.Timestamp,
});
export interface Reservation extends Schema.Schema.Type<typeof Reservation> {}
/** A reservation as the organization authority receives it from one server. */
export const Request = Schema.Struct({
  ...Reservation.fields,
  accountId: P.AccountId,
  serverId: M.ServerId,
});
export interface Request extends Schema.Schema.Type<typeof Request> {}
/** The authority returns business outcomes as values across Cloudflare RPC. */
export const Outcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("reserved") }),
  Schema.Struct({
    kind: Schema.Literal("full"),
    limitBytes: M.Count,
    reservedBytes: M.Count,
    nextExpiryAt: Schema.NullOr(M.Timestamp),
  }),
]);
export type Outcome = typeof Outcome.Type;
/** The paid plan billing last confirmed, and the period it covers. */
export const PlanPeriod = Schema.Struct({
  accountId: P.AccountId,
  plan: B.Plan,
  start: M.Timestamp,
  end: M.Timestamp,
});
export interface PlanPeriod extends Schema.Schema.Type<typeof PlanPeriod> {}
/** The organization pool as the authority sees it now. */
export const Usage = Schema.Struct({
  limitBytes: M.Count,
  reservedBytes: M.Count,
  reservations: M.Count,
  plan: Schema.NullOr(B.Plan),
  planEnd: Schema.NullOr(M.Timestamp),
  nextExpiryAt: Schema.NullOr(M.Timestamp),
  asOf: M.Timestamp,
});
export interface Usage extends Schema.Schema.Type<typeof Usage> {}

const Settings = Schema.Struct({
  TALKTO_STORAGE_UNPAID_BYTES: Schema.optionalKey(
    Schema.NumberFromString.pipe(Schema.decodeTo(M.Count)),
  ),
  TALKTO_UNLIMITED_ACCOUNTS: Schema.optionalKey(
    Schema.fromJsonString(Entitlements.UnlimitedAccounts),
  ),
});
/** Deployment settings the authority reads; malformed values fail closed at the RPC boundary. */
export interface Limits {
  readonly unpaidBytes: number;
  readonly unlimitedAccounts: Entitlements.Grant;
}
export const limits = (env: Env): Limits => {
  const value = Schema.decodeUnknownSync(Settings)(env);
  return {
    unpaidBytes: value.TALKTO_STORAGE_UNPAID_BYTES ?? defaultUnpaidBytes,
    unlimitedAccounts: Entitlements.isSelfHosted(env)
      ? "all"
      : (value.TALKTO_UNLIMITED_ACCOUNTS ?? []),
  };
};
/**
 * The pool an organization has at `at`: owner-pilot accounts and every organization on a
 * self-hosted copy get the largest plan, a paid plan applies only inside its confirmed period, an
 * organization on the Free plan gets Free's pool, and everything else gets the unpaid pool.
 */
export const limitBytes = (
  settings: Limits,
  accountId: P.AccountId,
  plan: Option.Option<PlanPeriod>,
  at: M.Timestamp,
  /** On the standing Free plan: its own pool replaces the unpaid one. */
  onFree = false,
) => {
  if (Entitlements.covers(settings.unlimitedAccounts, accountId)) return planBytes("factory");
  const unpaid = onFree ? freeBytes : settings.unpaidBytes;
  return Option.match(plan, {
    onNone: () => unpaid,
    onSome: (period) => (period.start <= at && at < period.end ? planBytes(period.plan) : unpaid),
  });
};

const gb = (bytes: number) => `${(bytes / gigabyte).toFixed(bytes % gigabyte === 0 ? 0 : 2)} GB`;
/** The typed failure for a full pool, with what an agent needs to decide what to do next. */
export const full = (outcome: Extract<Outcome, { kind: "full" }>, requestedBytes: number) =>
  new E.StoragePoolFull({
    retryable: false,
    action: "send_smaller_or_wait",
    limitBytes: outcome.limitBytes,
    reservedBytes: outcome.reservedBytes,
    requestedBytes,
    nextExpiryAt: outcome.nextExpiryAt,
    message: `This send needs ${gb(requestedBytes)}, but the organization's stored-file pool has ${gb(Math.max(0, outcome.limitBytes - outcome.reservedBytes))} of ${gb(outcome.limitBytes)} free. Every server in the organization shares this pool, and each transfer, delivered or not, counts until it expires 30 days after it was prepared${outcome.nextExpiryAt === null ? "" : `; the next space frees at ${outcome.nextExpiryAt}`}. Retrying now will not help: send something smaller, wait for space, or ask the organization owner about a larger plan. Nothing was reserved.`,
  });
/** The authority could not be reached; nothing is lost, and the same request key resumes. */
export const unavailable = () =>
  new E.FilesUnavailable({
    message:
      "The organization's stored-file pool could not be reached. Retry prepare_transfer with the same requestKey; nothing was offered.",
    operation: "storagePool.reserve",
    reason: "failed",
  });

/** Application-owned port: one organization-wide pool shared by every server it owns. */
export class StoragePool extends Context.Service<
  StoragePool,
  {
    /** Hold `bytes` until `expiresAt`; reserving the same transfer again never counts twice. */
    readonly reserve: (
      reservation: Reservation,
    ) => Effect.Effect<void, E.StoragePoolFull | E.FilesUnavailable>;
  }
>()("@talkto/files/StoragePool") {}
/** Standalone deployments have no organization, so nothing is pooled. */
export const unpooled = StoragePool.of({ reserve: () => Effect.void });
