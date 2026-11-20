import { DateTime, Schema } from "effect";
import * as B from "@talkto/api/billing";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";

/** Allowlisted Stripe diagnostics, without response bodies or arbitrary provider messages. */
export const ProviderFailure = Schema.Struct({
  type: Schema.Literals([
    "StripePermissionError",
    "StripeAuthenticationError",
    "StripeConnectionError",
    "StripeRateLimitError",
    "StripeAPIError",
    "StripeInvalidRequestError",
    "StripeCardError",
    "StripeIdempotencyError",
    "StripeUnknownError",
  ]),
  status: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 }))),
  code: Schema.NullOr(
    Schema.Literals([
      "permission_denied",
      "api_key_expired",
      "invalid_api_key",
      "rate_limit",
      "resource_missing",
      "idempotency_key_in_use",
      "lock_timeout",
    ]),
  ),
  requestId: Schema.NullOr(Schema.String.check(Schema.isPattern(/^req_[A-Za-z0-9]{1,100}$/))),
});

/** Safe billing failures; provider response bodies and secrets are never retained. */
export class Failure extends Schema.TaggedError<Failure>()("BillingFailure", {
  code: Schema.Literals(["billing_unavailable", "billing_conflict", "invalid_input", "forbidden"]),
  message: Schema.String,
  operation: Schema.String,
  provider: Schema.optionalKey(ProviderFailure),
  recovery: Schema.optionalKey(
    Schema.Struct({
      operation: Schema.String,
      provider: Schema.optionalKey(ProviderFailure),
    }),
  ),
}) {}
/** A persisted binding, fenced lease, and latest provider observation. */
export const Workspace = Schema.Struct({
  accountId: P.AccountId,
  customerId: Schema.NullOr(Schema.String),
  subscriptionId: Schema.NullOr(Schema.String),
  subscription: Schema.NullOr(Schema.fromJsonString(B.Subscription)),
  checkedAt: Schema.NullOr(M.Timestamp),
  invoiceCursor: Schema.NullOr(Schema.String),
  lease: Schema.NullOr(Schema.String),
  eventHead: Schema.Int,
});
/** Parsed persisted billing workspace. */
export interface Workspace extends Schema.Schema.Type<typeof Workspace> {}
/** Bounded selected work with observation/attempt freshness for operator diagnostics. */
export const Due = Schema.Struct({
  id: P.AccountId,
  checkedAt: Schema.NullOr(M.Timestamp),
  attemptedAt: Schema.Int,
});
/** One selected reconciliation candidate. */
export interface Due extends Schema.Schema.Type<typeof Due> {}
/** Stable provider request parameters survive crashes and retries. */
export const Operation = Schema.Struct({
  id: Schema.String,
  accountId: P.AccountId,
  requestKey: M.RequestKey,
  plan: B.Plan,
  createdAt: Schema.Int,
  customerId: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["pending", "complete", "expired"]),
  offer: Schema.Literals(["paid", "trial"]),
});
/** Persisted checkout intent. */
export interface Operation extends Schema.Schema.Type<typeof Operation> {}
/** Eligibility survives organization recreation; no raw email or card data is retained. */
export const Trial = Schema.Struct({
  ...B.Trial.fields,
  accountId: P.AccountId,
  ownerId: P.UserId,
  emailKey: Schema.String,
  operationId: Schema.NullOr(Schema.String),
  subscriptionId: Schema.NullOr(Schema.String),
});
/** Internal trial record. */
export type Trial = typeof Trial.Type;
/** Verified trial dates and a provider card reuse signal, never a paid invoice. */
export interface TrialObservation {
  readonly subscriptionId: string;
  readonly operationId: string;
  readonly start: M.Timestamp;
  readonly end: M.Timestamp;
  readonly cardKey: string | null;
}
/** Provider event reference after raw signature verification. */
export const Event = Schema.Struct({
  id: Schema.String,
  customerId: Schema.String,
  type: Schema.String,
  /** The charge a refund or dispute event is about; reconciliation reads it again from Stripe. */
  chargeId: Schema.NullOr(Schema.String),
});
/** Verified event reference. */
export interface Event extends Schema.Schema.Type<typeof Event> {}
/** Payment evidence projected from a verified invoice line. */
export interface Period extends B.PaidPeriod {
  readonly invoiceId: string;
  readonly lineId: string;
  readonly subscriptionId: string;
}
/**
 * A paid move to a higher plan inside a billing period, projected from the paid proration invoice
 * Stripe sends for it. `end` names the period it changes; `at` is when the new plan started.
 */
export interface PlanChange {
  readonly subscriptionId: string;
  readonly invoiceId: string;
  readonly lineId: string;
  readonly from: B.Plan;
  readonly plan: B.Plan;
  readonly at: M.Timestamp;
  readonly end: M.Timestamp;
}
const rank = (plan: B.Plan) => B.Plan.literals.indexOf(plan);
/** Whether moving from `from` to `to` is an upgrade: Shop, then Studio, then Factory. */
export const upgrades = (from: B.Plan, to: B.Plan) => rank(to) > rank(from);
const epoch = (value: M.Timestamp) => DateTime.toEpochMillis(DateTime.makeUnsafe(value));
/**
 * The period after its paid upgrades. Each upgrade adds the difference between the two plans'
 * monthly messages, prorated by the time left in the period, as Stripe prorates the price. The
 * latest upgrade sets the plan. Order and repeats do not matter: each upgrade adds its own share.
 */
export const upgraded = (
  period: B.PaidPeriod,
  changes: ReadonlyArray<Pick<PlanChange, "from" | "plan" | "at">>,
): B.PaidPeriod => {
  const start = epoch(period.start);
  const end = epoch(period.end);
  let allowance = period.allowance;
  let latest: Pick<PlanChange, "plan" | "at"> | undefined;
  for (const change of changes) {
    const at = epoch(change.at);
    if (at < start || at >= end || !upgrades(change.from, change.plan)) continue;
    const difference = B.plans[change.plan].messages - B.plans[change.from].messages;
    allowance += Math.ceil((difference * (end - at)) / (end - start));
    // Upgrades within a period only go up, so two in the same second resolve to the bigger plan.
    if (
      latest === undefined ||
      change.at > latest.at ||
      (change.at === latest.at && upgrades(latest.plan, change.plan))
    )
      latest = change;
  }
  return latest === undefined
    ? period
    : { ...period, plan: latest.plan, allowance, upgrade: { from: period.plan, at: latest.at } };
};
/** Why a plan payment no longer counts: fully refunded, or disputed and not (yet) won. */
export const Reversal = Schema.Literals(["refund", "dispute"]);
/** Parsed payment reversal reason. */
export type Reversal = typeof Reversal.Type;
/**
 * A charge's current state, read again from Stripe after a refund or dispute event. `invoiceId`
 * is the invoice it paid (null when it paid none); `reason` is null once nothing reverses it, for
 * example after a dispute is won. A partial refund reverses nothing.
 */
export interface ChargeReview {
  readonly chargeId: string;
  readonly invoiceId: string | null;
  readonly reason: Reversal | null;
}
/** The reversal recorded against the invoices that paid for one period. */
export const Revocation = Schema.Struct({
  reason: Reversal,
  status: Schema.Literals(["active", "cleared"]),
  at: M.Timestamp,
});
/** Parsed recorded reversal. */
export interface Revocation extends Schema.Schema.Type<typeof Revocation> {}
/** A scheduled move to a smaller plan that starts soon, with the organization whose people count. */
export const Downgrade = Schema.Struct({
  accountId: P.AccountId,
  organizationId: P.OrganizationId,
  plan: B.Plan,
  at: M.Timestamp,
});
/** Parsed due downgrade. */
export interface Downgrade extends Schema.Schema.Type<typeof Downgrade> {}
/** A move to a smaller plan that TalkTo canceled because the organization had too many people. */
export const Hold = Schema.Struct({
  plan: B.Plan,
  kept: B.Plan,
  at: M.Timestamp,
  people: Schema.Int,
});
/** Parsed kept-plan record. */
export interface Hold extends Schema.Schema.Type<typeof Hold> {}
/** Provider checkout recovery result, without customer details. */
export interface Session {
  readonly id: string;
  readonly subscriptionId: string | null;
  readonly result: B.CheckoutResult;
}
/** One bounded reconciliation page, fetched from current provider state. */
export interface Observation {
  readonly subscriptionId: string | null;
  readonly subscription: B.State["subscription"];
  readonly periods: ReadonlyArray<Period>;
  readonly changes: ReadonlyArray<PlanChange>;
  readonly invoiceCursor: string | null;
  readonly trial: TrialObservation | null;
  /** Charges named by refund and dispute events received since the last observation. */
  readonly charges: ReadonlyArray<ChargeReview>;
}
/** Safe provider/storage failure without leaking SDK diagnostics. */
export const unavailable = (operation: string, provider?: typeof ProviderFailure.Type) => {
  const configuration =
    provider?.status === 401 ||
    provider?.status === 403 ||
    operation.startsWith("configuration") ||
    operation === "stripe.account_mismatch";
  const failure = {
    code: "billing_unavailable",
    operation,
    message: configuration
      ? "The billing service needs a configuration repair. Contact support before retrying this action."
      : "Billing is temporarily unavailable. Retry with the same request key.",
  } satisfies Pick<Failure, "code" | "operation" | "message">;
  return new Failure(provider === undefined ? failure : { ...failure, provider });
};
/** Expected state conflict, distinct from infrastructure failure. */
export const conflict = (message: string) =>
  new Failure({ code: "billing_conflict", operation: "billing", message });
