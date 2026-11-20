import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import * as M from "./models.js";
import * as P from "./platform.js";
import * as Envelope from "./envelope.js";
import { Authorization } from "./security.js";
import { free, history, starter } from "./pricing.js";
import * as Share from "./share.js";

/** The offer this environment honors: one lifetime allowance and one starter server. */
export const Offer = Schema.Struct({
  messages: Schema.Literal(starter.messages),
  servers: Schema.Literal(starter.servers),
}).annotate({ identifier: "StarterOffer" });
/** Parsed free-start offer. */
export interface Offer extends Schema.Schema.Type<typeof Offer> {}
/**
 * The standing Free plan, where this environment offers it (`TALKTO_FREE_PLAN_ENABLED`): one
 * server, `messages` agent-sent messages each UTC calendar month, and `historyDays` of history.
 */
export const FreeOffer = Schema.Struct({
  messages: Schema.Literal(free.messages),
  servers: Schema.Literal(free.servers),
  historyDays: Schema.Literal(history.free.days),
}).annotate({ identifier: "FreePlanOffer" });
/** Parsed Free plan offer. */
export interface FreeOffer extends Schema.Schema.Type<typeof FreeOffer> {}
/**
 * Where the caller stands with the free start. Expected denials are states, not errors:
 * `unavailable` (not offered here or not applicable to this organization), `eligible`,
 * `verify_email`, `sign_in_required` (claim from the website session), `used` (the allowance was
 * already given to this person or organization), `paused` (new free starts are temporarily full),
 * `server_limit` (the owner already has as many servers without a plan as allowed, so the starter
 * server could not be created), `owner_only` (only the organization owner can claim), then the lifecycle of a claimed grant:
 * `provisioning`, `active`, `exhausted` and `converted` (a paid plan replaced it).
 */
export const Status = Schema.Literals([
  "unavailable",
  "eligible",
  "verify_email",
  "sign_in_required",
  "used",
  "paused",
  "server_limit",
  "owner_only",
  "provisioning",
  "active",
  "exhausted",
  "converted",
]);
/** Parsed free-start status. */
export type Status = typeof Status.Type;
/**
 * A claimed allowance. It has no end date; `used` counts committed messages across every server
 * and agent of the organization, including messages servers have not reported yet.
 */
export const Grant = Schema.Struct({
  serverId: Schema.NullOr(M.ServerId),
  activatedAt: Schema.NullOr(M.Timestamp),
  allowance: M.Count,
  used: M.Count,
  remaining: M.Count,
  /** On the Free plan: when this month ends and the allowance starts again. */
  renewsAt: Schema.optionalKey(M.Timestamp),
}).annotate({ identifier: "StarterGrant" });
/** Parsed free-start grant. */
export interface Grant extends Schema.Schema.Type<typeof Grant> {}
/** Free-start context for one person, optionally within one organization. */
export const State = Schema.Struct({
  /** Present while this environment accepts new free starts. */
  offer: Schema.NullOr(Offer),
  status: Status,
  grant: Schema.NullOr(Grant),
  asOf: M.Timestamp,
  /**
   * Present when the Free plan applies: a claim opens the Free plan instead of the free start
   * (`offer` is then null), or the grant shows this month of the Free plan. Absent on the free start.
   */
  free: Schema.optionalKey(FreeOffer),
}).annotate({ identifier: "StarterState" });
/** Parsed free-start context. */
export interface State extends Schema.Schema.Type<typeof State> {}
/** Claim the free start by creating (or resuming) the organization's starter server. */
export const Claim = Schema.Struct({ name: M.ServerName, requestKey: M.RequestKey }).annotate({
  parseOptions: { onExcessProperty: "error" },
});
/** Parsed claim request. */
export interface Claim extends Schema.Schema.Type<typeof Claim> {}
/** A ready starter server and the allowance it opened. */
export const Claimed = Schema.Struct({ server: P.Server, state: State });
/** Parsed claim outcome. */
export interface Claimed extends Schema.Schema.Type<typeof Claimed> {}
/**
 * Signed-out offer facts; the public site shows the Free plan only when `free` is present, the
 * free start only when `starter` is (never both), and the share-link line only when `share` is.
 */
export const PublicOffers = Schema.Struct({
  starter: Schema.NullOr(Offer),
  free: Schema.optionalKey(Schema.NullOr(FreeOffer)),
  /** Present only while share links are on (docs/share-links-spec.md). */
  share: Schema.optionalKey(Share.Offer),
});
/** Parsed public offers. */
export interface PublicOffers extends Schema.Schema.Type<typeof PublicOffers> {}

/** Human free-start operations; claiming requires the website session. No MCP claiming surface. */
export const Api = HttpApi.make("talkto-starter")
  .add(
    HttpApiGroup.make("starter")
      .add(
        HttpApiEndpoint.get("eligibility", "/v1/starter", {
          success: P.response(State),
          error: Envelope.failures,
        }),
        HttpApiEndpoint.get("state", "/v1/accounts/:accountId/starter", {
          params: { accountId: P.AccountId },
          success: P.response(State),
          error: Envelope.failures,
        }),
        HttpApiEndpoint.post("claim", "/v1/accounts/:accountId/starter", {
          params: { accountId: P.AccountId },
          payload: Claim,
          success: P.response(Claimed),
          error: Envelope.failures,
        }),
      )
      .middleware(Authorization),
  )
  .add(
    HttpApiGroup.make("offers").add(
      HttpApiEndpoint.get("offers", "/v1/offers", {
        success: P.response(PublicOffers),
        error: Envelope.failures,
      }),
    ),
  );
