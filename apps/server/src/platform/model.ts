import { Schema } from "effect";
import type * as B from "@talkto/api/billing";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as Envelope from "@talkto/api/envelope";
import * as Access from "../access.js";

/**
 * The OAuth client behind an MCP resource token: its `client_id`, its `sid` when present, and when
 * it was issued (`iat`, epoch seconds). Signed-in computers record and revoke by these. Never the
 * token itself.
 */
export const McpClient = Schema.Struct({
  clientId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  sid: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  issuedAt: Schema.Number,
});
/** Parsed MCP client claims. */
export interface McpClient extends Schema.Schema.Type<typeof McpClient> {}
/** Verified WorkOS user; credentials stay at the authentication boundary. */
export const Actor = Schema.Struct({
  userId: P.UserId,
  principalKey: Access.PrincipalKey,
  /** Present only for MCP resource tokens that name their client. */
  mcpClient: Schema.optionalKey(McpClient),
});
/** Parsed authenticated caller. */
export interface Actor extends Schema.Schema.Type<typeof Actor> {}
/** Provisioning reservation survives interrupted WorkOS calls. */
export const AccountReservation = Schema.Struct({
  id: P.AccountId,
  organizationId: Schema.NullOr(P.OrganizationId),
  name: M.ServerName,
  createdBy: P.UserId,
  requestKey: M.RequestKey,
  createdAt: M.Timestamp,
});
/** Persisted account reservation. */
export interface AccountReservation extends Schema.Schema.Type<typeof AccountReservation> {}
/** An account being deleted with its sole owner; the organization is null if never recorded. */
export const AccountTombstone = Schema.Struct({
  id: P.AccountId,
  organizationId: Schema.NullOr(P.OrganizationId),
});
/** Parsed account being deleted. */
export interface AccountTombstone extends Schema.Schema.Type<typeof AccountTombstone> {}
/** Directory aggregate before caller permissions are attached by the application service. */
export const AccountSummary = Schema.Struct({ ...P.Account.fields, serverCount: M.Count });
/** Parsed organization directory aggregate. */
export interface AccountSummary extends Schema.Schema.Type<typeof AccountSummary> {}
/** Server creation contains everything needed for an idempotent retry. */
export const ServerReservation = Schema.Struct({
  ...P.Server.fields,
  organizationId: P.OrganizationId,
  requestKey: M.RequestKey,
  generalId: M.ConversationId,
});
/** Persisted server reservation. */
export interface ServerReservation extends Schema.Schema.Type<typeof ServerReservation> {}
/** Durable deletion intent; billing and admission history remain workspace-owned. */
export const ServerDeletion = Schema.Struct({
  serverId: M.ServerId,
  accountId: P.AccountId,
  createdBy: P.UserId,
  completedAt: Schema.NullOr(M.Timestamp),
});
/** Parsed deletion intent. */
export interface ServerDeletion extends Schema.Schema.Type<typeof ServerDeletion> {}
/** Versioned access command applied only through a private Worker binding. */
export const AccessCommand = Schema.Struct({
  ...P.Grant.fields,
  principalKey: Access.PrincipalKey,
});
/** Persisted access command. */
export interface AccessCommand extends Schema.Schema.Type<typeof AccessCommand> {}
/**
 * What decides an organization's people limit: the plan of a paid period covering now, else of an
 * active trial. Neither means `plan: null`.
 */
export interface Standing {
  readonly plan: B.Plan | null;
  readonly unlimited: boolean;
  /** On the standing Free plan (behind `TALKTO_FREE_PLAN_ENABLED`), with no paid plan or trial. */
  readonly free: boolean;
}
/** Expected platform failures, with safe public messages. */
export class Failure extends Schema.TaggedError<Failure>()("PlatformFailure", {
  code: Schema.Literals([
    "invalid_input",
    "not_found",
    "forbidden",
    "people_limit_reached",
    "starter_unavailable",
    "server_limit_reached",
    "idempotency_conflict",
    "storage_unavailable",
    "identity_unavailable",
    "unauthenticated",
  ]),
  message: Schema.String,
}) {}
/**
 * An invitation send or resend was refused by its email budget before the identity provider was
 * called, so nothing was sent. `retryAt` is the earliest time every exceeded budget allows another.
 */
export class InvitationLimited extends Schema.TaggedError<InvitationLimited>()(
  "InvitationLimited",
  {
    scope: Envelope.InvitationLimitScope,
    retryAt: M.Timestamp,
    message: Schema.String,
  },
) {}
/** Single WorkOS event translated into application-owned facts. */
export const IdentityEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("membership"), id: Schema.String, member: P.Member }),
  Schema.Struct({
    kind: Schema.Literal("user_deleted"),
    id: Schema.String,
    userId: P.UserId,
    at: M.Timestamp,
  }),
  Schema.Struct({
    kind: Schema.Literal("organization_deleted"),
    id: Schema.String,
    organizationId: P.OrganizationId,
    at: M.Timestamp,
  }),
]);
/** Parsed identity event. */
export type IdentityEvent = typeof IdentityEvent.Type;
/** A Connect application the person authorized in WorkOS (an MCP agent app's sign-in). */
export const AuthorizedApplication = Schema.Struct({
  /** WorkOS's authorized application ID, `authorized_connect_app_…`. */
  id: Schema.String.check(Schema.isPattern(/^authorized_connect_app_[A-Za-z0-9]{1,64}$/)),
  /** The Connect application's own ID, `conn_app_…`, shared by every person who authorized it. */
  applicationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  clientId: McpClient.fields.clientId,
  name: Schema.String.check(Schema.isMaxLength(200)),
  /** When the person authorized it, if WorkOS says. */
  createdAt: Schema.NullOr(M.Timestamp),
});
/** Parsed authorized application. */
export interface AuthorizedApplication extends Schema.Schema.Type<typeof AuthorizedApplication> {}
/** Request facts the HTTP boundary vouches for; neither comes from the request body. */
export interface Evidence {
  /** The caller used the website's sealed session, not an API token. */
  readonly website: boolean;
  /** Cloudflare's connecting address, for observation only. */
  readonly network: string | null;
}
/** API tokens, scheduled work and tests carry no website session. */
export const noEvidence: Evidence = { website: false, network: null };
/** Construct a caller key from verified WorkOS identity. */
export const actor = (userId: P.UserId): Actor => ({
  userId,
  principalKey: Access.PrincipalKey.make(`workos:${userId}`),
});
