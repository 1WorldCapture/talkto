import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import * as M from "./models.js";
import * as P from "./platform.js";
import * as Envelope from "./envelope.js";
import { Authorization } from "./security.js";

/*
  Personal API keys: a long-lived credential a person makes for scripts and services that call the
  HTTP API (`/v1`). A key acts as the person who made it, through the same access grants, limits
  and budgets as their sign-in; it is never an identity of its own. Keys never work on `/mcp`, which
  keeps the client's own OAuth sign-in. Only the website makes keys; any of the person's
  credentials can list or revoke them. The secret is shown once, when the key is made, and TalkTo
  stores only its SHA-256.
*/

/** The prefix every key starts with, so a leaked key is recognisable. */
export const secretPrefix = "tk_";
/** A key's secret: `tk_` and 43 base64url characters (256 random bits). */
export const Secret = Schema.String.check(Schema.isPattern(/^tk_[A-Za-z0-9_-]{43}$/)).pipe(
  Schema.brand("ApiKeySecret"),
);
/** Parsed key secret. */
export type Secret = typeof Secret.Type;
/** Whether a bearer credential is shaped like an API key rather than a WorkOS token. */
export const looksLikeKey = (credential: string) => credential.startsWith(secretPrefix);

/** A key's TalkTo ID. */
export const ApiKeyId = Schema.String.check(Schema.isUUID(4)).pipe(Schema.brand("ApiKeyId"));
/** Parsed key ID. */
export type ApiKeyId = typeof ApiKeyId.Type;

/**
 * What a key may do. `read`: reads only (GET, the read-only POSTs `updates` and a transfer's
 * download), and revoking itself. `full`: everything the person can do on the website, except
 * deleting the account or an organization, making keys, billing changes and removing an
 * organization member.
 */
export const Access = Schema.Literals(["read", "full"]);
/** Parsed key access. */
export type Access = typeof Access.Type;

/** At most this many unrevoked keys per person. */
export const maxKeys = 20;
/** A key lives at most this long; omit `expiresInDays` for a key that never expires. */
export const maxLifetimeDays = 365;

/** A key as its person sees it. Never the secret. */
export const ApiKey = Schema.Struct({
  id: ApiKeyId,
  name: Schema.String,
  /** The first characters of the secret, to recognise a key: `tk_` and 8 characters. */
  prefix: Schema.String,
  access: Access,
  /** The one organization the key is limited to, or null for every organization of the person. */
  accountId: Schema.NullOr(P.AccountId),
  createdAt: M.Timestamp,
  /** The most recent request with the key, to within 5 minutes; null if never used. */
  lastUsedAt: Schema.NullOr(M.Timestamp),
  /** When the key stops working, or null for never. */
  expiresAt: Schema.NullOr(M.Timestamp),
});
/** Parsed API key. */
export interface ApiKey extends Schema.Schema.Type<typeof ApiKey> {}

/** The person's unrevoked keys, newest first, expired ones included until revoked. */
export const ApiKeys = Schema.Struct({
  items: Schema.Array(ApiKey),
  max: Schema.Number,
});
/** Parsed key list. */
export interface ApiKeys extends Schema.Schema.Type<typeof ApiKeys> {}

/** Make a key. Website session only. */
export const CreateApiKey = Schema.Struct({
  name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  access: Access,
  /** Limit the key to one organization the person belongs to. */
  accountId: Schema.optionalKey(P.AccountId),
  expiresInDays: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: maxLifetimeDays })),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed key request. */
export interface CreateApiKey extends Schema.Schema.Type<typeof CreateApiKey> {}

/** The new key and its secret. The secret is shown only here, once. */
export const CreatedApiKey = Schema.Struct({ key: ApiKey, secret: Secret });
/** Parsed new key. */
export interface CreatedApiKey extends Schema.Schema.Type<typeof CreatedApiKey> {}

/** A revoked key. Revoking a key that is already revoked or not the caller's is `not_found`. */
export const RevokedApiKey = Schema.Struct({ id: ApiKeyId, revokedAt: M.Timestamp });
/** Parsed revocation. */
export interface RevokedApiKey extends Schema.Schema.Type<typeof RevokedApiKey> {}

/** The signed-in person's own API keys. No MCP surface. */
export const Api = HttpApi.make("talkto-api-keys").add(
  HttpApiGroup.make("apiKeys")
    .add(
      HttpApiEndpoint.get("list", "/v1/me/api-keys", {
        success: P.response(ApiKeys),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("create", "/v1/me/api-keys", {
        payload: CreateApiKey,
        success: P.response(CreatedApiKey),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.delete("revoke", "/v1/me/api-keys/:id", {
        params: { id: ApiKeyId },
        success: P.response(RevokedApiKey),
        error: Envelope.failures,
      }),
    )
    .middleware(Authorization),
);
