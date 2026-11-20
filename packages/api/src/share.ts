import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import * as M from "./models.js";
import * as P from "./platform.js";
import * as Envelope from "./envelope.js";
import { Authorization } from "./security.js";
import { share } from "./pricing.js";

/*
  Share links (docs/share-links-spec.md). An organization owner's link gives a new organization
  that signs up with it `share.messages` more free messages, and gives the owner the same once the
  new organization's agents have used TalkTo on two different days. Messages, never money.
*/

/** A link's code: 16 random bytes in base64url. It names nobody and cannot be guessed. */
export const Code = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/)).pipe(
  Schema.brand("ShareCode"),
);
/** Parsed share code. */
export type Code = typeof Code.Type;
/** The query parameter that carries a code on any TalkTo page: `https://talkto.sh/?ref=<code>`. */
export const parameter = "ref";

/** What both people get, as this environment offers it. */
export const Offer = Schema.Struct({
  messages: Schema.Literal(share.messages),
  qualifyingMessages: Schema.Literal(share.qualifyingMessages),
  qualifyingDays: Schema.Literal(share.qualifyingDays),
  windowDays: Schema.Literal(share.windowDays),
  sharerLimit: Schema.Literal(share.sharerLimit),
}).annotate({ identifier: "ShareOffer" });
/** Parsed share offer. */
export interface Offer extends Schema.Schema.Type<typeof Offer> {}

/** The owner's link. */
export const Link = Schema.Struct({ code: Code, url: Schema.String, createdAt: M.Timestamp });
/** Parsed share link. */
export interface Link extends Schema.Schema.Type<typeof Link> {}

/**
 * Where 500 messages stand: `pending` (being added), `added` to the free allowance, or
 * `not_added` because the organization had no free allowance then (a paid plan, for example).
 */
export const BonusStatus = Schema.Literals(["pending", "added", "not_added"]);
/** Parsed bonus status. */
export type BonusStatus = typeof BonusStatus.Type;

/**
 * One sign-up with the owner's link, naming nobody. `waiting`: its agents have not yet sent the
 * qualifying messages, until `windowEndsAt`. `qualified`: the owner's messages were earned
 * (`bonus` says where they stand). `capped`: it qualified after the owner had received the most.
 * `excluded`: not counted (a recorded dispute or the same card). `expired`: the window passed.
 */
export const Referral = Schema.Struct({
  joinedAt: M.Timestamp,
  windowEndsAt: M.Timestamp,
  status: Schema.Literals(["waiting", "qualified", "capped", "excluded", "expired"]),
  settledAt: Schema.NullOr(M.Timestamp),
  bonus: Schema.NullOr(
    Schema.Struct({ status: BonusStatus, appliedAt: Schema.NullOr(M.Timestamp) }),
  ),
}).annotate({ identifier: "ShareReferral" });
/** Parsed referral. */
export interface Referral extends Schema.Schema.Type<typeof Referral> {}

/**
 * One organization's share state. `unavailable`: not offered here. `owner_only`: only the
 * organization's owner has a link. `available`: the owner's view. `free` is false when the
 * organization has no free allowance now (a paid plan), so the owner's messages would not be added.
 * `exhausted` is true once the owner received the most or the link took the most sign-ups.
 * `joined` is present when this organization signed up with someone's link.
 */
export const State = Schema.Struct({
  status: Schema.Literals(["unavailable", "owner_only", "available"]),
  offer: Schema.NullOr(Offer),
  link: Schema.NullOr(Link),
  free: Schema.Boolean,
  exhausted: Schema.Boolean,
  referrals: Schema.Array(Referral),
  joined: Schema.NullOr(
    Schema.Struct({
      joinedAt: M.Timestamp,
      status: BonusStatus,
      appliedAt: Schema.NullOr(M.Timestamp),
    }),
  ),
  asOf: M.Timestamp,
}).annotate({ identifier: "ShareState" });
/** Parsed share state. */
export interface State extends Schema.Schema.Type<typeof State> {}

/** Attach this organization's sign-up to a link. */
export const Join = Schema.Struct({ code: Code }).annotate({
  parseOptions: { onExcessProperty: "error" },
});
/** Parsed join request. */
export interface Join extends Schema.Schema.Type<typeof Join> {}
/**
 * Why a join was refused. Expected answers, not errors: `unavailable` (not offered here),
 * `unknown_code`, `not_owner`, `not_new` (no free start claimed in the last
 * `share.joinWithinDays` days), `already_joined`, `own_link` (the same person, a member of the
 * other organization, or the same email domain outside the public mail domains), `link_full`
 * (the owner received the most, or the link took the most sign-ups).
 */
export const JoinRefusal = Schema.Literals([
  "unavailable",
  "unknown_code",
  "not_owner",
  "not_new",
  "already_joined",
  "own_link",
  "link_full",
]);
/** Parsed join refusal. */
export type JoinRefusal = typeof JoinRefusal.Type;
/** The answer to a join. A repeated join of the same code answers `joined: true` again. */
export const Joined = Schema.Union([
  Schema.Struct({ joined: Schema.Literal(true), state: State }),
  Schema.Struct({ joined: Schema.Literal(false), reason: JoinRefusal }),
]);
/** Parsed join answer. */
export type Joined = typeof Joined.Type;

const params = { accountId: P.AccountId };
/** People's share-link operations. No MCP surface: links are for people. */
export const Api = HttpApi.make("talkto-share").add(
  HttpApiGroup.make("share")
    .add(
      HttpApiEndpoint.get("state", "/v1/accounts/:accountId/share", {
        params,
        success: P.response(State),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("link", "/v1/accounts/:accountId/share/link", {
        params,
        success: P.response(State),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("join", "/v1/accounts/:accountId/share/join", {
        params,
        payload: Join,
        success: P.response(Joined),
        error: Envelope.failures,
      }),
    )
    .middleware(Authorization),
);
