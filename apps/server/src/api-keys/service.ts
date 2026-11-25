import { Clock, DateTime, Effect, Encoding } from "effect";
import * as K from "@talkto/api/api-keys";
import * as M from "@talkto/api/models";
import * as P from "@talkto/api/platform";
import * as Model from "../platform/model.js";
import * as Guard from "./guard.js";
import * as Store from "./store.js";

/*
  Personal API keys (docs/dashboard-api.md, "API keys"): making, listing and revoking them, and
  turning a key into its person at the Worker boundary. A key resolves to exactly the WorkOS user
  who made it (`Model.actor`), so every server's grant check and the agent-ownership check see the
  same caller as that person's sign-in. What a key may reach is narrowed by `permits`.
*/

/** How often a key's last-used time is written. */
export const usedInterval = 5 * 60_000;
const day = 86_400_000;

const iso = (millis: number) => M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(millis)));
const failure = (code: Model.Failure["code"], message: string) =>
  new Model.Failure({ code, message });

/** SHA-256 of a secret, lowercase hex. */
export const hash = (secret: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))).pipe(
    Effect.map((digest) => Encoding.encodeHex(new Uint8Array(digest))),
  );

const view = (row: Store.Row): K.ApiKey => ({
  id: K.ApiKeyId.make(row.id),
  name: row.name,
  prefix: row.prefix,
  access: row.access,
  accountId: row.accountId === null ? null : P.AccountId.make(row.accountId),
  createdAt: iso(row.createdAt),
  lastUsedAt: row.lastUsedAt === null ? null : iso(row.lastUsedAt),
  expiresAt: row.expiresAt === null ? null : iso(row.expiresAt),
});

/** The person's unrevoked keys. */
export const list = Effect.fn("ApiKeys.list")(function* (actor: Model.Actor) {
  const store = yield* Store.Store;
  const rows = yield* store.active(actor.userId);
  return { items: rows.map(view), max: K.maxKeys } satisfies K.ApiKeys;
});

/**
 * Make a key. Website session only: a key, a device token or an agent can never make another key,
 * so a leaked credential cannot mint a longer-lived one.
 */
export const create = Effect.fn("ApiKeys.create")(function* (
  actor: Model.Actor,
  input: K.CreateApiKey,
  evidence: Model.Evidence,
) {
  if (!evidence.website)
    return yield* failure(
      "forbidden",
      "Make API keys on TalkTo's website, under Account → API keys. Keys and agents cannot make keys.",
    );
  const store = yield* Store.Store;
  // The same answer for an organization that does not exist and one the person is not in.
  if (input.accountId !== undefined && !(yield* store.member(actor.userId, input.accountId)))
    return yield* failure("not_found", "The organization is unavailable.");
  const now = yield* Clock.currentTimeMillis;
  const value = yield* (yield* Guard.Guard).mint;
  const row: Store.NewKey = {
    id: crypto.randomUUID(),
    userId: actor.userId,
    name: input.name,
    prefix: value.slice(0, K.secretPrefix.length + 8),
    secretHash: yield* hash(value),
    access: input.access,
    accountId: input.accountId ?? null,
    createdAt: now,
    expiresAt: input.expiresInDays === undefined ? null : now + input.expiresInDays * day,
  };
  if (!(yield* store.insert(row, K.maxKeys)))
    return yield* failure(
      "api_key_limit_reached",
      `You have ${K.maxKeys} API keys, the most one person may have. Revoke one first.`,
    );
  return {
    key: view({ ...row, lastUsedAt: null, revokedAt: null }),
    secret: value,
  } satisfies K.CreatedApiKey;
});

/** Revoke one of the person's keys. Any of the person's credentials may, including the key. */
export const revoke = Effect.fn("ApiKeys.revoke")(function* (actor: Model.Actor, id: K.ApiKeyId) {
  const store = yield* Store.Store;
  const now = yield* Clock.currentTimeMillis;
  const at = yield* store.revoke(actor.userId, id, now);
  if (at === null) return yield* failure("not_found", "There is no such API key.");
  Guard.forgetKey(id);
  return { id, revokedAt: iso(at) } satisfies K.RevokedApiKey;
});

/** A verified key: its person, and what it may reach. */
export interface Verified {
  readonly actor: Model.Actor;
  readonly key: Store.Row;
  /** Whether this request should record the key's last use. */
  readonly record: boolean;
}

const refused = () =>
  failure("unauthenticated", "The API key is unknown, revoked or expired. Make a new one.");

/**
 * The person a key acts as. Refused for a made-up, unknown, revoked or expired key, all in the same
 * words. A made-up key is refused before any hash or D1 read (`Guard.genuine`); a checked key is
 * reused per isolate for `Guard.cacheMs`. The caller records the use (`Store.used`) after the
 * response when `record` is true.
 */
export const verify = Effect.fn("ApiKeys.verify")(function* (credential: string) {
  if (!keyFormat.test(credential)) return yield* refused();
  const guard = yield* Guard.Guard;
  if (!(yield* guard.genuine(credential))) {
    yield* guard.failed;
    return yield* refused();
  }
  const digest = yield* hash(credential);
  const now = yield* Clock.currentTimeMillis;
  let key = Guard.cachedKey(digest, now);
  if (key === undefined) {
    // Without a tag secret, made-up keys reach D1, so an unavailable D1 counts as a failure too and
    // a flood during an outage is still limited. With one, forgeries never get here: counting would
    // only lock out people with real keys.
    key = yield* (yield* Store.Store)
      .bySecret(digest)
      .pipe(Effect.tapError(() => (guard.tagged ? Effect.void : guard.failed)));
    Guard.rememberKey(digest, key, now, guard.cacheMs);
  }
  if (key === null || (key.expiresAt !== null && key.expiresAt <= now)) {
    yield* guard.failed;
    return yield* refused();
  }
  return {
    actor: Model.actor(P.UserId.make(key.userId)),
    key,
    record: Guard.shouldRecord(key, now, usedInterval),
  } satisfies Verified;
});

const keyFormat = /^tk_[A-Za-z0-9_-]{43}$/;

/**
 * Whether this isolate already checked the key and it is still good, with no D1 read: such a key is
 * let through a network's block (`refusedNetwork`), so it keeps working through a D1 outage.
 */
export const remembered = Effect.fn("ApiKeys.remembered")(function* (credential: string) {
  if (!keyFormat.test(credential)) return false;
  const now = yield* Clock.currentTimeMillis;
  const key = Guard.cachedKey(yield* hash(credential), now);
  return key !== undefined && key !== null && (key.expiresAt === null || key.expiresAt > now);
});

/** POST routes that only read, which a `read` key may call. */
const readingPosts = [
  /^\/v1\/servers\/[^/]+\/updates$/,
  /^\/v1\/servers\/[^/]+\/files\/transfers\/[^/]+\/download$/,
  /^\/v1\/servers\/[^/]+\/files\/transfers\/[^/]+\/fetch$/,
];
/** Revoking one of the person's keys; the ID is the last segment. */
const keyRoute = /^\/v1\/me\/api-keys\/([^/]+)$/;
/**
 * Whether a key may make this request, before it reaches any handler. Billing changes and removing
 * an organization member are refused for every key in their handlers (`Model.refuseApiKey`), after
 * routing, so no spelling of the path gets past them. Here:
 * - `read` keys: GET, HEAD and the reading POSTs, and revoking themselves;
 * - organization-limited keys: anything their access allows under that organization and its
 *   servers; elsewhere only `GET /v1/me` and revoking themselves.
 * `serverAccount` reads which organization a server is in, remembered per isolate.
 */
export const permits = Effect.fn("ApiKeys.permits")(function* (
  key: Store.Row,
  method: string,
  path: string,
) {
  const reading =
    method === "GET" ||
    method === "HEAD" ||
    (method === "POST" && readingPosts.some((pattern) => pattern.test(path)));
  const revoked = method === "DELETE" ? path.match(keyRoute)?.[1] : undefined;
  const revokingItself = revoked === key.id;
  if (key.access === "read" && !reading && !revokingItself)
    return yield* failure(
      "forbidden",
      "This API key can only read, and can revoke only itself. Make a key with full access to change anything.",
    );
  if (key.accountId === null) return;
  const outside = () =>
    failure("forbidden", "This API key is limited to one organization, and this is outside it.");
  const account = path.match(/^\/v1\/accounts\/([^/]+)/)?.[1];
  if (account !== undefined) {
    if (account !== key.accountId) return yield* outside();
    return;
  }
  const server = path.match(/^\/v1\/servers\/([^/]+)/)?.[1];
  if (server !== undefined) {
    const store = yield* Store.Store;
    if ((yield* Guard.serverAccount(store, server)) !== key.accountId) return yield* outside();
    return;
  }
  if (revokingItself || ((method === "GET" || method === "HEAD") && path === "/v1/me")) return;
  return yield* outside();
});
