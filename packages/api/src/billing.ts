import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import * as M from "./models.js";
import * as P from "./platform.js";
import * as Envelope from "./envelope.js";
import { Authorization } from "./security.js";
import * as Metering from "./metering.js";

/** Fixed monthly tiers; more allowance requires a higher tier. */
export const Plan = Schema.Literals(["shop", "studio", "factory"]);
/** Parsed commercial tier. */
export type Plan = typeof Plan.Type;
export { plans, planVersion } from "./pricing.js";
/** Provider-confirmed subscription lifecycle; payment is reported separately. */
export const SubscriptionStatus = Schema.Literals([
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
]);
/** A paid period does not imply usage has been measured or access enforcement is enabled. */
export const PaidPeriod = Schema.Struct({
  plan: Plan,
  planVersion: Schema.String,
  start: M.Timestamp,
  end: M.Timestamp,
  allowance: Schema.Int.check(Schema.isGreaterThan(0)),
  /**
   * A paid upgrade inside this period: `plan` is the new plan from `at`, and `allowance` adds the
   * new plan's prorated share of messages for the rest of the period. `from` is the plan the
   * period was bought on.
   */
  upgrade: Schema.optionalKey(Schema.Struct({ from: Plan, at: M.Timestamp })),
});
/** Parsed paid monthly allowance. */
export interface PaidPeriod extends Schema.Schema.Type<typeof PaidPeriod> {}
/** Durable checkout intent; clients retain the request key through retries. */
export const Checkout = Schema.Struct({
  plan: Plan,
  requestKey: M.RequestKey,
  offer: Schema.optionalKey(Schema.Literal("trial")),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
/** Parsed checkout request. */
export interface Checkout extends Schema.Schema.Type<typeof Checkout> {}
/** Keep optional offer identity intact without forwarding browser-only intent fields. */
export function checkoutIntent(
  plan: Plan,
  requestKey: M.RequestKey,
  offer?: "trial" | "paid",
): Checkout {
  return offer === "trial" ? { plan, requestKey, offer } : { plan, requestKey };
}
/** Billing state remains explicit while checkout or payment confirmation is pending. */
export const Subscription = Schema.Struct({
  plan: Plan,
  status: SubscriptionStatus,
  cancelAtPeriodEnd: Schema.Boolean,
  payment: Schema.Literals(["pending", "paid", "unpaid"]),
  /** A move to a smaller plan, scheduled in Stripe for `at`, the end of the current period. */
  change: Schema.optionalKey(Schema.Struct({ plan: Plan, at: M.Timestamp })),
});
/** A one-time trial, separate from paid invoices and monthly courtesy capacity. */
export const Trial = Schema.Struct({
  status: Schema.Literals(["pending", "active", "rejected"]),
  start: Schema.NullOr(M.Timestamp),
  end: Schema.NullOr(M.Timestamp),
  allowance: Schema.Literal(500),
});
/** Explicit renewal changes are authenticated and retryable by request key. */
export const Renewal = Schema.Struct({ cancel: Schema.Boolean, requestKey: M.RequestKey });
/** Parsed renewal request. */
export type Renewal = typeof Renewal.Type;
/**
 * Move an active subscription to another plan. A bigger plan starts now and is charged the
 * prorated difference; a smaller one is scheduled for the next renewal. Retryable by request key.
 */
export const PlanChange = Schema.Struct({ plan: Plan, requestKey: M.RequestKey }).annotate({
  parseOptions: { onExcessProperty: "error" },
});
/** Parsed plan change request. */
export type PlanChange = typeof PlanChange.Type;
/** Billing state with explicit confirmation freshness. */
export const State = Schema.Struct({
  plans: Schema.Array(
    Schema.Struct({
      key: Plan,
      name: Schema.String,
      monthlyCents: Schema.Int,
      messages: Schema.Int,
      /** Humans in the organization, counting pending invitations; null is unlimited. */
      peopleLimit: Schema.NullOr(Schema.Int),
    }),
  ),
  subscription: Schema.NullOr(Subscription),
  checkout: Schema.NullOr(Checkout),
  paidPeriod: Schema.NullOr(PaidPeriod),
  issue: Schema.NullOr(Schema.Literal("period_conflict")),
  /**
   * The payment for the current paid period was fully refunded or is disputed, so the period ended
   * at `at` and new sends are paused until a new payment (or a won dispute). Absent otherwise.
   */
  revocation: Schema.optionalKey(
    Schema.Struct({ reason: Schema.Literals(["refund", "dispute"]), at: M.Timestamp }),
  ),
  /**
   * A scheduled move to `plan` that TalkTo canceled shortly before the renewal at `at`, because the
   * organization had `people` (counting pending invitations), more than `plan` includes. `kept`
   * continued. Present for a month after that renewal; absent otherwise.
   */
  downgradeKept: Schema.optionalKey(
    Schema.Struct({ plan: Plan, kept: Plan, at: M.Timestamp, people: Schema.Int }),
  ),
  trial: Schema.NullOr(Trial),
  trialAvailable: Schema.Boolean,
  usage: Metering.Usage,
  checkedAt: Schema.NullOr(M.Timestamp),
  permissions: Schema.Struct({ manageBilling: Schema.Boolean }),
});
/** Parsed subscription context with confirmed entitlement and metered usage. */
export interface State extends Schema.Schema.Type<typeof State> {}
/** Only an open checkout contains a navigable URL. Completion still requires payment confirmation. */
export const CheckoutResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("open"), url: Schema.String, expiresAt: M.Timestamp }),
  Schema.Struct({ status: Schema.Literals(["complete", "expired"]) }),
]);
/** Parsed checkout outcome. */
export type CheckoutResult = typeof CheckoutResult.Type;
/** Expiration is confirmed by Stripe; a completed checkout cannot be canceled here. */
export const CancelCheckoutResult = Schema.Struct({
  status: Schema.Literals(["expired", "complete"]),
});
/** Parsed cancellation outcome. */
export type CancelCheckoutResult = typeof CancelCheckoutResult.Type;
/** Human billing operations use the existing workspace authorization boundary. */
export const Api = HttpApi.make("talkto-billing").add(
  HttpApiGroup.make("billing")
    .add(
      HttpApiEndpoint.get("state", "/v1/accounts/:accountId/billing", {
        params: { accountId: P.AccountId },
        success: P.response(State),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("checkout", "/v1/accounts/:accountId/billing/checkout", {
        params: { accountId: P.AccountId },
        payload: Checkout,
        success: P.response(CheckoutResult),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("cancelCheckout", "/v1/accounts/:accountId/billing/checkout/cancel", {
        params: { accountId: P.AccountId },
        payload: Checkout,
        success: P.response(CancelCheckoutResult),
        error: Envelope.failures,
      }),
      // After Stripe Checkout returns: confirm with Stripe now rather than wait for webhooks.
      HttpApiEndpoint.post("confirmCheckout", "/v1/accounts/:accountId/billing/checkout/confirm", {
        params: { accountId: P.AccountId },
        success: P.response(State),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("portal", "/v1/accounts/:accountId/billing/portal", {
        params: { accountId: P.AccountId },
        success: P.response(Schema.Struct({ url: Schema.String })),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("changePlan", "/v1/accounts/:accountId/billing/plan", {
        params: { accountId: P.AccountId },
        payload: PlanChange,
        success: P.response(Schema.Struct({ confirmed: Schema.Boolean })),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("keepPlan", "/v1/accounts/:accountId/billing/plan/keep", {
        params: { accountId: P.AccountId },
        payload: Schema.Struct({ requestKey: M.RequestKey }),
        success: P.response(Schema.Struct({ confirmed: Schema.Boolean })),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("renewal", "/v1/accounts/:accountId/billing/renewal", {
        params: { accountId: P.AccountId },
        payload: Renewal,
        success: P.response(Schema.Struct({ confirmed: Schema.Boolean })),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("startPaid", "/v1/accounts/:accountId/billing/trial/convert", {
        params: { accountId: P.AccountId },
        payload: Schema.Struct({ requestKey: M.RequestKey }),
        success: P.response(Schema.Struct({ confirmed: Schema.Boolean })),
        error: Envelope.failures,
      }),
    )
    .middleware(Authorization),
);
