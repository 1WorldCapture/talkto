import { Clock, Effect, Option, Schema } from "effect";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  errors,
  jwtVerify,
} from "jose";
import type { JWTVerifyGetKey } from "jose";
import * as P from "@talkto/api/platform";
import { describeFailure } from "./failure-log.js";
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
const base64url = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2048),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
/** One RS256 public signing key: only what verification reads. */
const publicKey = Schema.Struct({
  kty: Schema.Literal("RSA"),
  kid: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  alg: Schema.Literal("RS256"),
  use: Schema.optionalKey(Schema.Literal("sig")),
  n: base64url,
  e: base64url,
});
const fallbackList = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      keys: Schema.Array(publicKey).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
    }),
  ),
);
/**
 * Last known public keys for each accepted issuer, from `WORKOS_MCP_JWKS`: a JSON object from
 * issuer to that issuer's own `{ "keys": [...] }`. They answer only when the issuer's live key set
 * cannot be fetched, and the production preflight checks them against the live sets at deploy
 * time. An issuer outside `issuers` is ignored. A malformed value configures no fallback rather
 * than disabling MCP sign-in.
 */
export const fallbackKeys = (
  configured: string | undefined,
  issuers: ReadonlyArray<string>,
): ReadonlyMap<string, JWTVerifyGetKey> => {
  if (configured === undefined) return new Map();
  return Option.match(Schema.decodeUnknownOption(fallbackList)(configured), {
    onNone: () => {
      console.warn("TalkTo ignored an invalid WORKOS_MCP_JWKS value");
      return new Map();
    },
    onSome: (sets) =>
      new Map(
        issuers.flatMap((issuer) => {
          const set = Object.hasOwn(sets, issuer) ? sets[issuer] : undefined;
          return set === undefined ? [] : [[issuer, createLocalJWKSet({ keys: [...set.keys] })]];
        }),
      ),
  });
};
/** A key set response other than 200, carrying its status so the log can say which. */
class KeySetResponse extends Error {
  override readonly name = "KeySetResponse";
  readonly code: string;
  constructor(status: number) {
    super("The key set answered without 200 OK");
    this.code = `HTTP_${status}`;
  }
}
const remoteKeys = (issuer: string): JWTVerifyGetKey =>
  createRemoteJWKSet(new URL(`${issuer}/oauth2/jwks`), {
    [customFetch]: async (url, options) => {
      const response = await fetch(url, options);
      if (response.status === 200) return response;
      await response.body?.cancel();
      throw new KeySetResponse(response.status);
    },
  });
/** The key set itself failed (network, timeout, status, malformed set), not the token. */
class KeySetUnavailable extends Schema.TaggedError<KeySetUnavailable>()("KeySetUnavailable", {
  cause: Schema.Unknown,
}) {}
/** How long a fallback answers alone after the live key set failed, so each request is not slow. */
const fallbackWindowMillis = 60_000;
/**
 * Validate issuer, resource audience, signing algorithm and expiry without a provider call per
 * message. Each accepted issuer has its own key set. The unverified `iss` only selects one, and
 * verification then requires that exact issuer, so no other host's key set is ever fetched.
 *
 * When an issuer's live key set cannot be fetched, its own fallback keys (`fallbackKeys`) verify
 * the token instead, with the same checks, and keep answering for a minute before the live set is
 * tried again. A token those keys reject is still unauthenticated; a key ID they do not know stays
 * unavailable, because the live set might hold a newer key.
 */
export const verifier = (
  issuer: string,
  aliases: ReadonlyArray<string>,
  resource: string,
  fallbacks: ReadonlyMap<string, JWTVerifyGetKey> = new Map(),
  keys: (issuer: string) => JWTVerifyGetKey = remoteKeys,
) => {
  const keySets = new Map([issuer, ...aliases].map((allowed) => [allowed, keys(allowed)]));
  /** Until when each issuer's live key set is skipped for its fallback, after a failure. */
  const fallbackUntil = new Map<string, number>();
  return Effect.fn("McpAuth.verify")(function* (request: Request) {
    const rejected = () =>
      new Model.Failure({
        code: "unauthenticated",
        message: "A valid TalkTo MCP resource token is required.",
      });
    const unavailable = () =>
      new Model.Failure({
        code: "identity_unavailable",
        message: "The identity provider is temporarily unavailable.",
      });
    const token = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (token === undefined || token.length > 16384) return yield* rejected();
    const claimed = yield* Effect.try({ try: () => decodeJwt(token).iss, catch: rejected });
    const jwks = claimed === undefined ? undefined : keySets.get(claimed);
    if (claimed === undefined || jwks === undefined) return yield* rejected();
    const check = (keySet: JWTVerifyGetKey, fallback: boolean) =>
      Effect.tryPromise({
        try: () =>
          jwtVerify(token, keySet, {
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
          (error instanceof errors.JWKSNoMatchingKey && !fallback) ||
          error instanceof errors.JWSSignatureVerificationFailed
            ? rejected()
            : new KeySetUnavailable({ cause: error }),
      });
    // The cause's name and code only: never the token, its claims or an error message.
    const report = (event: string, failure: KeySetUnavailable) =>
      Effect.sync(() =>
        console.warn(event, { issuer: claimed, ...describeFailure(failure.cause) }),
      );
    const fallback = fallbacks.get(claimed);
    const now = yield* Clock.currentTimeMillis;
    const verifying =
      fallback !== undefined && now < (fallbackUntil.get(claimed) ?? 0)
        ? check(fallback, true)
        : check(jwks, false).pipe(
            Effect.catchTag("KeySetUnavailable", (failure) =>
              Effect.gen(function* () {
                yield* report("mcp-auth: key set unavailable", failure);
                if (fallback === undefined) return yield* unavailable();
                fallbackUntil.set(claimed, now + fallbackWindowMillis);
                return yield* check(fallback, true);
              }),
            ),
          );
    const verified = yield* verifying.pipe(
      Effect.catchTag("KeySetUnavailable", (failure) =>
        report("mcp-auth: fallback keys unavailable", failure).pipe(Effect.andThen(unavailable)),
      ),
    );
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
