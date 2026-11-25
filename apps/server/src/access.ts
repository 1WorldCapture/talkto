import { Schema } from "effect";
import * as M from "@talkto/api/models";

/** Trusted principal key produced by credential verification, never participant attribution. */
export const PrincipalKey = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,512}$/)).pipe(
  Schema.brand("PrincipalKey"),
);
/** Parsed authorization principal. */
export type PrincipalKey = typeof PrincipalKey.Type;
/** Verified authority carried separately from agent-controlled payloads. */
export const AccessContext = Schema.Struct({
  serverId: M.ServerId,
  grantId: M.GrantId,
  principalKey: PrincipalKey,
});
/** Parsed trusted access context. */
export interface AccessContext extends Schema.Schema.Type<typeof AccessContext> {}
/** Persisted access grant, including revocation retained for audit references. */
export const Grant = Schema.Struct({
  id: M.GrantId,
  principalKey: PrincipalKey,
  createdAt: M.Timestamp,
  revokedAt: Schema.NullOr(M.Timestamp),
});
/** Parsed access grant. */
export interface Grant extends Schema.Schema.Type<typeof Grant> {}
/**
 * Internal header the hosted Worker sets when a request was authenticated by the TalkTo website's
 * session cookie rather than a bearer token. Every ingress removes copies a caller sends.
 */
export const websiteHeader = "x-talkto-authenticated-by";
/** The value of `websiteHeader` for the website's session cookie. */
export const websiteSession = "website-session";
/**
 * The value of `websiteHeader` for a personal API key: the person, not an agent, so it may do what
 * the website does in a server (docs/dashboard-api.md, "API keys").
 */
export const apiKeySession = "api-key";
