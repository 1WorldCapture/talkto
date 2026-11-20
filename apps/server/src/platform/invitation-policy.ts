import { Config, ConfigProvider, DateTime, Effect, Encoding, Schema } from "effect";
import type * as Envelope from "@talkto/api/envelope";
import type * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as Model from "./model.js";
import * as Entitlements from "../account-entitlements.js";

const Limit = (maximum: number) =>
  Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maximum));
const Minutes = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1440),
);

/** The specification's proposed tuning defaults; these are not measured fraud thresholds. */
export const defaults = {
  unpaidDaily: 10,
  unpaidTotalDaily: 100,
  paidDaily: 200,
  recipientCooldownMinutes: 10,
  recipientDaily: 3,
} as const;

/** Email budgets for invitation sends and resends. Days are UTC days. */
export interface Configuration {
  /** Operator grants count as paid. */
  readonly unlimitedAccounts: Entitlements.Grant;
  /** Attempts per owner and organization per day without confirmed paid access. */
  readonly unpaidDaily: number;
  /** Attempts per day across every organization without confirmed paid access. */
  readonly unpaidTotalDaily: number;
  /** Attempts per owner and organization per day with confirmed paid access. */
  readonly paidDaily: number;
  /** Minimum minutes between attempts to one address in one organization; 0 turns it off. */
  readonly recipientCooldownMinutes: number;
  /** Attempts per address in one organization per day. */
  readonly recipientDaily: number;
}

const read = Effect.gen(function* () {
  const value: Configuration = {
    unlimitedAccounts: yield* Entitlements.unlimitedAccounts,
    unpaidDaily: yield* Config.schema(Limit(1000), "TALKTO_INVITATION_UNPAID_DAILY_LIMIT").pipe(
      Config.withDefault(defaults.unpaidDaily),
    ),
    unpaidTotalDaily: yield* Config.schema(
      Limit(100000),
      "TALKTO_INVITATION_UNPAID_TOTAL_DAILY_LIMIT",
    ).pipe(Config.withDefault(defaults.unpaidTotalDaily)),
    paidDaily: yield* Config.schema(Limit(10000), "TALKTO_INVITATION_PAID_DAILY_LIMIT").pipe(
      Config.withDefault(defaults.paidDaily),
    ),
    recipientCooldownMinutes: yield* Config.schema(
      Minutes,
      "TALKTO_INVITATION_RECIPIENT_COOLDOWN_MINUTES",
    ).pipe(Config.withDefault(defaults.recipientCooldownMinutes)),
    recipientDaily: yield* Config.schema(
      Limit(100),
      "TALKTO_INVITATION_RECIPIENT_DAILY_LIMIT",
    ).pipe(Config.withDefault(defaults.recipientDaily)),
  };
  if (value.unpaidDaily > value.unpaidTotalDaily) return yield* Effect.fail("invalid" as const);
  return value;
});

/** Invalid budgets stop invitation email instead of sending without limits. */
export const configuration = Effect.fn("Invitations.configuration")(
  function* (env: Env) {
    return yield* read.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))));
  },
  Effect.tapError(() =>
    Effect.logError("Invitation budgets are misconfigured; invitations paused"),
  ),
  Effect.mapError(
    () =>
      new Model.Failure({
        code: "storage_unavailable",
        message: "Invitations are temporarily unavailable. Existing invitations still work.",
      }),
  ),
);

/**
 * Recipient key scoped to one organization, so one organization's attempts never limit another's
 * invitations to the same person. Addresses compare case-insensitively.
 */
export const recipientKey = (organizationId: P.OrganizationId, email: string) =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          `talkto-invitation-recipient:v1\n${organizationId}\n${email.trim().toLowerCase()}`,
        ),
      ),
    catch: () =>
      new Model.Failure({
        code: "storage_unavailable",
        message: "Invitations are temporarily unavailable.",
      }),
  }).pipe(Effect.map((digest) => Encoding.encodeHex(new Uint8Array(digest))));

/** One send or resend, recorded before the identity provider is asked to email anyone. */
export interface Attempt {
  readonly account: P.Account;
  readonly recipientKey: string;
  readonly kind: "send" | "resend";
  readonly at: M.Timestamp;
}
/** Paid means a confirmed paid period covering now, or an operator grant; Checkout alone is not. */
export type Tier = "unpaid" | "paid";
/** Counts read in the same transaction that tried to record the attempt. */
export const Facts = Schema.Struct({
  admitted: Schema.Int,
  tier: Schema.Literals(["unpaid", "paid"]),
  organization: Schema.Int,
  unpaidTotal: Schema.Int,
  recipientToday: Schema.Int,
  lastRecipient: Schema.NullOr(M.Timestamp),
});
/** Parsed reservation facts. */
export interface Facts extends Schema.Schema.Type<typeof Facts> {}
/** Which budget refused, and when every exceeded budget next allows an attempt. */
export interface Refusal {
  readonly scope: Envelope.InvitationLimitScope;
  readonly tier: Tier;
  readonly retryAt: M.Timestamp;
}

/** UTC day of an authoritative timestamp. */
export const day = (at: M.Timestamp) => at.slice(0, 10);
const iso = (value: DateTime.DateTime) => M.Timestamp.make(DateTime.formatIso(value));
/** Earliest attempt time that still counts toward a recipient's cooldown. */
export const cooldownStart = (configuration: Configuration, at: M.Timestamp) =>
  iso(
    DateTime.subtract(DateTime.makeUnsafe(at), { minutes: configuration.recipientCooldownMinutes }),
  );
/** Attempts older than a week no longer affect any budget. */
export const retainedFrom = (at: M.Timestamp) =>
  day(iso(DateTime.subtract(DateTime.makeUnsafe(at), { days: 7 })));

/**
 * The refusal the stored counts imply, mirroring the reservation's SQL conditions. The latest
 * retry time wins, because an attempt succeeds only once every exceeded budget allows it.
 */
export const refusal = (
  configuration: Configuration,
  at: M.Timestamp,
  facts: Facts,
): Refusal | null => {
  const now = DateTime.makeUnsafe(at);
  const tomorrow = iso(DateTime.startOf(DateTime.add(now, { days: 1 }), "day"));
  const exceeded: Array<Omit<Refusal, "tier">> = [];
  const organizationLimit =
    facts.tier === "paid" ? configuration.paidDaily : configuration.unpaidDaily;
  if (facts.organization >= organizationLimit)
    exceeded.push({ scope: "organization", retryAt: tomorrow });
  if (facts.tier === "unpaid" && facts.unpaidTotal >= configuration.unpaidTotalDaily)
    exceeded.push({ scope: "unpaid_total", retryAt: tomorrow });
  if (facts.recipientToday >= configuration.recipientDaily)
    exceeded.push({ scope: "recipient", retryAt: tomorrow });
  if (
    configuration.recipientCooldownMinutes > 0 &&
    facts.lastRecipient !== null &&
    facts.lastRecipient > cooldownStart(configuration, at)
  )
    exceeded.push({
      scope: "recipient",
      retryAt: iso(
        DateTime.add(DateTime.makeUnsafe(facts.lastRecipient), {
          minutes: configuration.recipientCooldownMinutes,
        }),
      ),
    });
  const latest = exceeded.reduce<Omit<Refusal, "tier"> | null>(
    (found, next) => (found === null || next.retryAt > found.retryAt ? next : found),
    null,
  );
  return latest === null ? null : { ...latest, tier: facts.tier };
};

/** A refusal whose cause could not be read back: try again in a minute. */
export const briefly = (at: M.Timestamp, tier: Tier): Refusal => ({
  scope: "organization",
  tier,
  retryAt: iso(DateTime.add(DateTime.makeUnsafe(at), { minutes: 1 })),
});

/** Plain refusal copy: what limit applies, never a judgment about the person. */
export const limited = (value: Refusal) =>
  new Model.InvitationLimited({
    scope: value.scope,
    retryAt: value.retryAt,
    message:
      value.scope === "recipient"
        ? "This address was sent an invitation recently. To avoid repeat emails, wait before sending another."
        : value.scope === "unpaid_total"
          ? "Organizations without a paid plan have used today's shared invitation allowance. A paid plan can send more."
          : value.tier === "paid"
            ? "This organization has sent today's maximum number of invitations."
            : "This organization has sent today's maximum number of invitations. A paid plan can send more.",
  });

/** Whole seconds until `retryAt`, within the public contract's bounds. */
export const retryAfterSeconds = (retryAt: M.Timestamp, now: M.Timestamp) => {
  const millis =
    DateTime.toEpochMillis(DateTime.makeUnsafe(retryAt)) -
    DateTime.toEpochMillis(DateTime.makeUnsafe(now));
  return Math.min(86400, Math.max(1, Math.ceil(millis / 1000)));
};
