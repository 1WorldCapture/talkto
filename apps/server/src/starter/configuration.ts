import { Config, ConfigProvider, Effect, Option, Redacted, Schema } from "effect";
import * as Entitlements from "../account-entitlements.js";
import * as Model from "./model.js";
import * as FreePlan from "../free-plan.js";

const Flag = Schema.Union([Schema.Boolean, Schema.Literals(["true", "false"])]);
const Limit = (maximum: number) =>
  Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maximum));
/** Names a pilot. Counting is per cohort, so a new name is an explicit operator decision. */
const Cohort = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/));
/** Version of the starter terms recorded on every grant; bump when the offer changes. */
export const offerVersion = "2026-11-12";
/** Recorded instead of `offerVersion` on a grant that opened the Free plan. */
export const freeOfferVersion = "free-2026-11-16";
/**
 * The owner chose "everyone with a verified email" (November 12, 2026). These are the
 * largest values the settings accept: a backstop against a flood of sign-ups, not a quota.
 */
export const defaults = {
  dailyLimit: 1000,
  cohortLimit: 100000,
  cohort: "pilot-2026-11",
  observationDays: 30,
} as const;

/** New free starts: open only with explicit configuration. */
export interface Admissions {
  readonly dailyLimit: number;
  readonly cohortLimit: number;
  readonly cohort: string;
  readonly secret: Redacted.Redacted<string>;
  /** The card trial's email key derivation, so its claims also count as spent. */
  readonly legacy: { readonly secret: Redacted.Redacted<string>; readonly scope: string } | null;
}
/** Parsed free-start configuration; existing grants keep working while admissions are closed. */
export interface Configuration {
  readonly admissions: Admissions | null;
  /** Stable identity environment: claims never move with whichever Stripe account is configured. */
  readonly namespace: string;
  readonly observationDays: number;
  readonly unlimitedAccounts: Entitlements.Grant;
  /** The switch is on but its settings are missing or invalid, so admissions stay closed. */
  readonly misconfigured: boolean;
  /** `TALKTO_FREE_PLAN_ENABLED`: claims open the Free plan, and free starts in use move to it. */
  readonly free: boolean;
}

const read = Effect.gen(function* () {
  // The identity environment: on a self-hosted copy that signs people in with Cloudflare Access
  // (docs/self-host-cloudflare-access.md), the Access team; otherwise WorkOS's client.
  const accessTeam = yield* Config.schema(
    Schema.String.check(
      Schema.isPattern(/^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$/),
    ),
    "TALKTO_ACCESS_TEAM_DOMAIN",
  ).pipe(Config.option);
  // Only a self-hosted copy can sign in with Access (CloudflareAccess.settings refuses otherwise).
  const namespace =
    Option.isSome(accessTeam) && (yield* Entitlements.selfHosted)
      ? `access:${new URL(accessTeam.value).hostname}`
      : `workos:${yield* Config.schema(
          Schema.String.check(Schema.isPattern(/^client_[A-Za-z0-9]+$/)),
          "WORKOS_CLIENT_ID",
        )}`;
  const unlimitedAccounts = yield* Entitlements.unlimitedAccounts;
  const observationDays = yield* Config.schema(Limit(90), "TALKTO_STARTER_OBSERVATION_DAYS").pipe(
    Config.withDefault(defaults.observationDays),
  );
  const enabled = yield* Config.schema(Flag, "TALKTO_STARTER_ADMISSIONS_ENABLED").pipe(
    Config.withDefault(false),
  );
  // A self-hosted copy never offers the free start: every organization there is unlimited.
  const on = (enabled === true || enabled === "true") && !(yield* Entitlements.selfHosted);
  const admissions = on ? yield* readAdmissions.pipe(Effect.option) : null;
  const free = yield* FreePlan.enabledConfig;
  return {
    free,
    namespace,
    observationDays,
    unlimitedAccounts,
    admissions: admissions === null || admissions._tag === "None" ? null : admissions.value,
    misconfigured: admissions !== null && admissions._tag === "None",
  };
});

const readAdmissions = Effect.gen(function* () {
  const dailyLimit = yield* Config.schema(Limit(1000), "TALKTO_STARTER_DAILY_LIMIT").pipe(
    Config.withDefault(defaults.dailyLimit),
  );
  const cohortLimit = yield* Config.schema(Limit(100000), "TALKTO_STARTER_COHORT_LIMIT").pipe(
    Config.withDefault(defaults.cohortLimit),
  );
  const cohort = yield* Config.schema(Cohort, "TALKTO_STARTER_COHORT").pipe(
    Config.withDefault(defaults.cohort),
  );
  const secret = yield* Config.redacted("TALKTO_STARTER_CLAIM_SECRET");
  if (Redacted.value(secret).length < 32 || dailyLimit > cohortLimit)
    return yield* Effect.fail("invalid" as const);
  const trialSecret = yield* Config.option(Config.redacted("TALKTO_TRIAL_CLAIM_SECRET"));
  const stripe = yield* Config.option(
    Config.all({
      account: Config.schema(
        Schema.String.check(Schema.isPattern(/^acct_[A-Za-z0-9]+$/)),
        "STRIPE_ACCOUNT_ID",
      ),
      environment: Config.schema(
        Schema.Literals(["test", "staging", "production"]),
        "STRIPE_ENVIRONMENT",
      ),
      live: Config.boolean("STRIPE_LIVE_MODE"),
    }),
  );
  // Same scope as billing/stripe.ts `scope`, so legacy card-trial email keys compare exactly.
  const legacy =
    trialSecret._tag === "Some" &&
    Redacted.value(trialSecret.value).length >= 32 &&
    stripe._tag === "Some"
      ? {
          secret: trialSecret.value,
          scope: `${stripe.value.account}:${stripe.value.environment}:${stripe.value.live ? "live" : "test"}`,
        }
      : null;
  return { dailyLimit, cohortLimit, cohort, secret, legacy };
});

/**
 * Off by default. A switch that is on but incompletely configured closes new admissions (and the
 * public offer) instead of advertising something the environment cannot honor.
 */
export const configuration = Effect.fn("Starter.configuration")(function* (env: Env) {
  const value: Configuration = yield* read.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Effect.mapError(() => Model.unavailable("configuration")),
  );
  if (value.misconfigured)
    yield* Effect.logError("Free-start admissions are switched on but misconfigured; kept closed");
  return value;
});
