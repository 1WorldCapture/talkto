import { Config, ConfigProvider, Effect, Schema } from "effect";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as U from "@talkto/api/metering";
import * as Model from "./model.js";
import * as Entitlements from "../account-entitlements.js";

const Limits = Schema.Struct({
  accountId: P.AccountId,
  allowance: M.Count.check(Schema.isLessThanOrEqualTo(100)),
  overdraft: M.Count.check(Schema.isLessThanOrEqualTo(100)),
});
/** Surcharge per share, above the one unit a persisted message already costs; the sum must fit one block. */
const ShareUnits = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Model.blockUnits - 1 }),
);
const Settings = Schema.Struct({
  workspaces: Schema.Union([Schema.Literal("all"), Schema.Array(P.AccountId)]),
  unlimitedAccounts: Entitlements.Grant,
  testLimits: Schema.NullOr(Limits),
  shareUnits: ShareUnits,
});
/** Parse rollout scope once at runtime boundaries; synthetic limits cannot be used with live Stripe. */
export const read = Effect.fn("Metering.configure")(function* (env: Env) {
  const values = yield* Config.all({
    unlimitedAccounts: Entitlements.unlimitedAccounts,
    workspaces: Config.schema(
      Schema.fromJsonString(Settings.fields.workspaces),
      "METERED_WORKSPACES",
    ).pipe(Config.withDefault([])),
    testLimits: Config.schema(
      Schema.fromJsonString(Settings.fields.testLimits),
      "METERING_TEST_LIMITS",
    ).pipe(Config.withDefault(null)),
    shareUnits: Config.schema(ShareUnits, "TALKTO_FILE_SHARE_UNITS").pipe(Config.withDefault(0)),
    environment: Config.string("STRIPE_ENVIRONMENT").pipe(Config.withDefault("disabled")),
    live: Config.boolean("STRIPE_LIVE_MODE").pipe(Config.withDefault(true)),
  }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Effect.mapError(() => Model.unavailable("configuration")),
  );
  if (
    values.testLimits !== null &&
    (values.live || !["staging", "test"].includes(values.environment))
  )
    return yield* Model.unavailable("configuration.test_limits");
  return Settings.make(values);
});
/** One share spends the message unit plus the surcharge; `ShareUnits` keeps the sum inside one block. */
export const shareCost = (settings: typeof Settings.Type) =>
  Model.Units.make(1 + settings.shareUnits);
/** Explicit rollout scope never derives from a caller-controlled field. */
export const enabled = (settings: typeof Settings.Type, id: P.AccountId) =>
  !Entitlements.covers(settings.unlimitedAccounts, id) &&
  (settings.workspaces === "all" || settings.workspaces.includes(id));
/** Test limits reduce a paid sandbox allowance; they never create an entitlement. */
export const limits = (settings: typeof Settings.Type, id: P.AccountId, allowance: number) =>
  settings.testLimits?.accountId === id
    ? {
        allowance: Math.min(allowance, settings.testLimits.allowance),
        overdraft: settings.testLimits.overdraft,
      }
    : { allowance, overdraft: U.overdraftMessages };
