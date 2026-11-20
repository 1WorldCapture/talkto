import { Config, Schema } from "effect";
import * as P from "@talkto/api/platform";

/** Operator grants use internal organization IDs, never email or request claims. */
export const UnlimitedAccounts = Schema.Array(P.AccountId);
/**
 * Which organizations are unlimited: the listed operator grants, or `"all"` on a self-hosted copy.
 * Unlimited means what the owner-pilot grant always meant: no metering, no plan limits, the
 * largest storage pool. It never grants access; membership and server grants still decide that.
 */
export const Grant = Schema.Union([Schema.Literal("all"), UnlimitedAccounts]);
/** Parsed unlimited grant. */
export type Grant = typeof Grant.Type;

const Flag = Schema.Union([Schema.Boolean, Schema.Literals(["true", "false"])]);
/**
 * `TALKTO_SELF_HOSTED="true"`: a customer's own copy. Every organization is unlimited, and billing,
 * trials and the free start are off whatever else is configured. Absent or "false" is hosted TalkTo.
 */
export const selfHosted = Config.schema(Flag, "TALKTO_SELF_HOSTED").pipe(
  Config.withDefault(false),
  Config.map((value) => value === true || value === "true"),
);

const SelfHostedSetting = Schema.Struct({
  TALKTO_SELF_HOSTED: Schema.Union([Schema.Literal(true), Schema.Literal("true")]),
});
/** The same switch for request routing, where no Config provider is in scope. */
export const isSelfHosted = (env: Env) =>
  Schema.decodeUnknownOption(SelfHostedSetting)(env)._tag === "Some";

/** Empty by default; malformed grants fail at the existing configuration boundary. */
export const unlimitedAccounts: Config.Config<Grant> = Config.all({
  selfHosted,
  listed: Config.schema(Schema.fromJsonString(UnlimitedAccounts), "TALKTO_UNLIMITED_ACCOUNTS").pipe(
    Config.withDefault([]),
  ),
}).pipe(Config.map(({ selfHosted, listed }): Grant => (selfHosted ? "all" : listed)));

/** Whether the grant makes this organization unlimited. */
export const covers = (grant: Grant, id: P.AccountId) => grant === "all" || grant.includes(id);
/**
 * The grant as a list for a SQL check about this one organization (`? IN unlimited`): with `"all"`
 * that is just this organization, which is all such a check asks about.
 */
export const forAccount = (grant: Grant, id: P.AccountId): ReadonlyArray<P.AccountId> =>
  grant === "all" ? [id] : grant;
