import { Config, ConfigProvider, Effect, Redacted, Schema } from "effect";
import * as Model from "./model.js";
import * as Entitlements from "../account-entitlements.js";

const Flag = Schema.Union([Schema.Boolean, Schema.Literals(["true", "false"])]);
/** Commercial experiment stays off until explicit launch configuration is present. */
export const configuration = (env: Env) =>
  Effect.gen(function* () {
    const enabled = yield* Config.schema(Flag, "TALKTO_TRIALS_ENABLED").pipe(
      Config.withDefault(false),
    );
    if ((enabled !== true && enabled !== "true") || (yield* Entitlements.selfHosted)) return null;
    const dailyLimit = yield* Config.schema(
      Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
      "TALKTO_TRIAL_DAILY_LIMIT",
    );
    const secret = yield* Config.redacted("TALKTO_TRIAL_CLAIM_SECRET");
    const paymentConfiguration = yield* Config.schema(
      Schema.String.check(Schema.isPattern(/^pmc_[A-Za-z0-9]+$/)),
      "STRIPE_TRIAL_PAYMENT_CONFIGURATION",
    );
    if (Redacted.value(secret).length < 32) return yield* Model.unavailable("trial.claim_secret");
    return { dailyLimit, secret, paymentConfiguration };
  }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Effect.mapError(() => Model.unavailable("trial.configuration")),
  );
/** Parsed trial launch configuration. */
export type Configuration = Effect.Success<ReturnType<typeof configuration>>;
/** Persist stable, scoped HMACs instead of raw owner emails or provider fingerprints. */
export const claimKey = (secret: Redacted.Redacted<string>, scope: string, value: string) =>
  Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(Redacted.value(secret)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${scope}:${value}`));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
    },
    catch: () => Model.unavailable("trial.claim_key"),
  });
