import { Effect, Option, Schema } from "effect";
import { createRemoteJWKSet, decodeJwt, errors, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import * as P from "@talkto/api/platform";
import * as Model from "./platform/model.js";

/**
 * `client_id` and `sid` are optional so tokens without them still work; they only feed signed-in
 * computers. A malformed value rejects the token like any other malformed claim. An `org_id` claim
 * is ignored: server access is the boundary, so one connection reaches every server its person
 * was granted, in any organization.
 */
const claims = Schema.Struct({
  sub: P.UserId,
  iat: Schema.Number,
  client_id: Schema.optionalKey(Model.McpClient.fields.clientId),
  sid: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
});
const aliasList = Schema.fromJsonString(
  Schema.Array(Schema.String.check(Schema.isPattern(/^https:\/\/[^/]+$/))).check(
    Schema.isMaxLength(4),
  ),
);
/** Verified Connect resource token boundary, separate from AuthKit session authentication. */
export interface Authentication {
  /** The one authorization server TalkTo advertises; aliases are accepted, never advertised. */
  readonly issuer: string;
  readonly verify: (request: Request) => Effect.Effect<Model.Actor, Model.Failure>;
}
/**
 * Extra Connect issuers accepted while AuthKit moves to a new hostname, from
 * `WORKOS_MCP_ISSUER_ALIASES`. A malformed value accepts no extra issuer rather than
 * disabling MCP sign-in: the primary issuer keeps working, and the production preflight
 * rejects that value before a deploy.
 */
export const issuerAliases = (
  configured: string | undefined,
  issuer: string,
): ReadonlyArray<string> => {
  if (configured === undefined) return [];
  return Option.match(Schema.decodeUnknownOption(aliasList)(configured), {
    onNone: () => {
      console.warn("TalkTo ignored an invalid WORKOS_MCP_ISSUER_ALIASES value");
      return [];
    },
    onSome: (aliases) => [...new Set(aliases)].filter((alias) => alias !== issuer),
  });
};
const remoteKeys = (issuer: string): JWTVerifyGetKey =>
  createRemoteJWKSet(new URL(`${issuer}/oauth2/jwks`));
/**
 * Validate issuer, resource audience, signing algorithm and expiry without a provider call per
 * message. Each accepted issuer has its own key set. The unverified `iss` only selects one, and
 * verification then requires that exact issuer, so no other host's key set is ever fetched.
 */
export const verifier = (
  issuer: string,
  aliases: ReadonlyArray<string>,
  resource: string,
  keys: (issuer: string) => JWTVerifyGetKey = remoteKeys,
) => {
  const keySets = new Map([issuer, ...aliases].map((allowed) => [allowed, keys(allowed)]));
  return Effect.fn("McpAuth.verify")(function* (request: Request) {
    const rejected = () =>
      new Model.Failure({
        code: "unauthenticated",
        message: "A valid TalkTo MCP resource token is required.",
      });
    const token = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (token === undefined || token.length > 16384) return yield* rejected();
    const claimed = yield* Effect.try({ try: () => decodeJwt(token).iss, catch: rejected });
    const jwks = claimed === undefined ? undefined : keySets.get(claimed);
    if (claimed === undefined || jwks === undefined) return yield* rejected();
    const verified = yield* Effect.tryPromise({
      try: () =>
        jwtVerify(token, jwks, {
          issuer: claimed,
          audience: resource,
          algorithms: ["RS256"],
          requiredClaims: ["sub", "iat", "exp", "aud"],
        }),
      catch: (error) =>
        error instanceof errors.JWTClaimValidationFailed ||
        error instanceof errors.JWTExpired ||
        error instanceof errors.JOSEAlgNotAllowed ||
        error instanceof errors.JOSENotSupported ||
        error instanceof errors.JWSInvalid ||
        error instanceof errors.JWTInvalid ||
        error instanceof errors.JWKSNoMatchingKey ||
        error instanceof errors.JWSSignatureVerificationFailed
          ? rejected()
          : new Model.Failure({
              code: "identity_unavailable",
              message: "The identity provider is temporarily unavailable.",
            }),
    });
    const parsed = yield* Schema.decodeUnknownEffect(claims)(verified.payload).pipe(
      Effect.mapError(rejected),
    );
    const actor = Model.actor(parsed.sub);
    if (parsed.client_id === undefined) return actor;
    const mcpClient: Model.McpClient =
      parsed.sid === undefined
        ? { clientId: parsed.client_id, issuedAt: parsed.iat }
        : { clientId: parsed.client_id, sid: parsed.sid, issuedAt: parsed.iat };
    return { ...actor, mcpClient };
  });
};
