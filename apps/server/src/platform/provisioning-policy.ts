import { Config, ConfigProvider, DateTime, Effect, Schema } from "effect";
import * as M from "@talkto/api/models";
import * as Model from "./model.js";
import * as P from "@talkto/api/platform";
import { serversPerOrganization } from "@talkto/api/pricing";
import * as Entitlements from "../account-entitlements.js";
import * as FreePlan from "../free-plan.js";

const Limit = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(10000));

/** Operational admission budgets; these are independent of commercial trial activation. */
export const Configuration = Schema.Struct({
  unlimitedAccounts: Entitlements.Grant,
  unpaidServers: Limit,
  serversPerHour: Limit,
  organizationsPerHour: Limit,
  unpaidServersPerDay: Limit,
  /** The standing Free plan's switch (`TALKTO_FREE_PLAN_ENABLED`). */
  freePlan: Schema.Boolean,
  /** Servers one organization may hold: the safety cap, raised per organization on request. */
  serversPerOrganization: Limit,
  /** Operator overrides of the cap by organization ID (`TALKTO_SERVER_LIMITS`). */
  serverLimits: Schema.Record(P.AccountId, Limit),
  /**
   * `TALKTO_BOARD=on`: creation may ask for a swarm server (`board: true`). Off, the request is
   * created as a plain server, so no server list shows a board the deployment does not offer.
   */
  boards: Schema.Boolean,
});
/** Parsed resource admission policy. */
export interface Configuration extends Schema.Schema.Type<typeof Configuration> {}

/** Missing or invalid operating limits stop new reservations without blocking existing data. */
export const configuration = Effect.fn("Provisioning.configuration")(
  function* (_env: Env) {
    return {
      unlimitedAccounts: yield* Entitlements.unlimitedAccounts,
      unpaidServers: yield* Config.schema(Limit, "TALKTO_UNPAID_SERVER_LIMIT"),
      serversPerHour: yield* Config.schema(Limit, "TALKTO_SERVER_CREATIONS_PER_HOUR"),
      organizationsPerHour: yield* Config.schema(Limit, "TALKTO_ORGANIZATION_CREATIONS_PER_HOUR"),
      unpaidServersPerDay: yield* Config.schema(Limit, "TALKTO_UNPAID_SERVER_DAILY_LIMIT"),
      freePlan: yield* FreePlan.enabledConfig,
      serversPerOrganization: yield* Config.schema(Limit, "TALKTO_SERVERS_PER_ORGANIZATION").pipe(
        Config.withDefault(serversPerOrganization),
      ),
      serverLimits: yield* Config.schema(
        Schema.fromJsonString(Schema.Record(P.AccountId, Limit)),
        "TALKTO_SERVER_LIMITS",
      ).pipe(Config.withDefault({})),
      boards:
        (yield* Config.schema(Schema.String, "TALKTO_BOARD").pipe(Config.withDefault("off"))) ===
        "on",
    };
  },
  (effect, env) =>
    effect.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      Effect.mapError(
        () =>
          new Model.Failure({
            code: "storage_unavailable",
            message:
              "New resource creation is temporarily unavailable. Existing resources remain available.",
          }),
      ),
    ),
);

/** Admission windows use the authoritative creation time, never a client-supplied clock. */
export function windows(at: M.Timestamp) {
  const now = DateTime.makeUnsafe(at);
  return {
    hour: DateTime.formatIso(DateTime.subtract(now, { hours: 1 })),
    day: DateTime.formatIso(DateTime.startOf(now, "day")),
  };
}

/** The servers this organization may hold: its operator override, else the safety cap. */
export const serverCap = (policy: Configuration, accountId: P.AccountId) =>
  policy.serverLimits[accountId] ?? policy.serversPerOrganization;

/** The safety cap was reached; the message names it and how to raise it. */
export const serverLimitReached = (cap: number) =>
  new Model.Failure({
    code: "server_limit_reached",
    message: `This organization has reached its limit of ${cap} servers. Delete a server you no longer need, or ask TalkTo support to raise the limit; it is a safety cap and raised on request.`,
  });

/** A rejected admission creates no provider resource and spends no reservation. */
export const denied = () =>
  new Model.Failure({
    code: "forbidden",
    message:
      "Resource creation is limited for this organization or owner. Resume an existing request or contact the organization owner.",
  });
