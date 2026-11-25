import { Clock, Context, Effect, Encoding, Result } from "effect";
import * as K from "@talkto/api/api-keys";
import * as Starter from "../starter/inbox.js";
import * as WakeCrypto from "../wakes/crypto.js";
import type * as Store from "./store.js";

/*
  What keeps API keys off D1 on the hot path (KEY_DECISIONS: no D1 reads on sends, reads or held
  updates), the way signal links are kept off it:
  - with `TALKTO_API_KEY_SECRET` set, a key's secret carries an HMAC tag made with it, so a made-up
    key is refused before any hash or D1 read. Keys have their own secret, not the signal key, so
    rotating one never touches the other. Rotating `TALKTO_API_KEY_SECRET`, or setting it on a copy
    that already has keys, ends every existing key: people make new ones;
  - a checked key is remembered per isolate for `TALKTO_API_KEY_CACHE_SECONDS` (30 by default), so
    a revoked key can keep working that long on other isolates; 0 reads D1 on every request;
  - which organization a server is in is remembered for 10 minutes;
  - failed checks count against `SIGNAL_FAILURES` per network, under an `api-key:` prefix; over the
    limit, that network gets 429 with Retry-After for a minute, without a D1 read. A key this isolate
    already checked is reused before that block, so it keeps working. An unavailable D1 counts only
    without a tag secret: with one, forgeries never reach D1, and counting outages would only lock
    out people with real keys.
*/

/** Entries each isolate-local memory keeps; the oldest leaves first. */
const remembered = 10_000;
const secretBytes = 32;
const tagBytes = 16;
/** How long a network stays refused after going over the failure limit. */
const blockedMs = 60_000;
const serverFoundMs = 10 * 60_000;
const serverMissingMs = 60_000;
/** How long a checked key is reused when the deployment does not say. */
export const defaultCacheSeconds = 30;

const keys = new Map<string, { readonly key: Store.Row | null; readonly until: number }>();
const servers = new Map<string, { readonly accountId: string | null; readonly until: number }>();
const recorded = new Map<string, number>();
const blockedUntil = new Map<string, number>();
/** Insertion order is age: refresh moves an entry to the end, overflow drops the oldest. */
const remember = <V>(memory: Map<string, V>, key: string, value: V) => {
  memory.delete(key);
  memory.set(key, value);
  if (memory.size <= remembered) return;
  const oldest = memory.keys().next();
  if (oldest.done !== true) memory.delete(oldest.value);
};

/** The HMAC key in `TALKTO_API_KEY_SECRET`, imported once per isolate the first time it is used. */
type TagKey = () => Promise<CryptoKey>;
let loaded: { readonly raw: string; readonly key: TagKey } | null = null;
/** 32 random bytes, base64 or base64url; null when unset or malformed (keys are then untagged). */
const tagKey = (raw: string | undefined): TagKey | null => {
  if (raw === undefined) return null;
  if (loaded?.raw === raw) return loaded.key;
  const bytes = WakeCrypto.parseKey(raw);
  if (bytes === null) return null;
  let imported: Promise<CryptoKey> | null = null;
  const key: TagKey = () =>
    (imported ??= crypto.subtle.importKey(
      "raw",
      new Uint8Array(bytes),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ));
  loaded = { raw, key };
  return key;
};
/** The first 16 bytes of HMAC-SHA-256 over the secret's random half, under the API key label. */
const tag = (key: TagKey, nonce: Uint8Array) =>
  Effect.promise(async () => {
    const message = `talkto-api-key-v1:${Encoding.encodeBase64Url(nonce)}`;
    const mac = await crypto.subtle.sign("HMAC", await key(), new TextEncoder().encode(message));
    return new Uint8Array(mac).slice(0, tagBytes);
  });

/** The deployment's guard for API keys. */
export class Guard extends Context.Service<
  Guard,
  {
    /** A new secret: tagged when the deployment has `TALKTO_API_KEY_SECRET`, else fully random. */
    readonly mint: Effect.Effect<K.Secret>;
    /** Whether the deployment tags secrets, so a made-up key never reaches D1. */
    readonly tagged: boolean;
    /** Whether this deployment could have made the secret; always true without a tag secret. */
    readonly genuine: (secret: string) => Effect.Effect<boolean>;
    /** How long a checked key is reused, in milliseconds. */
    readonly cacheMs: number;
    /** Seconds until this request's network may try again; null when it is not refused. */
    readonly retryAfter: Effect.Effect<number | null>;
    /** Count a failed check against this request's network. */
    readonly failed: Effect.Effect<void>;
  }
>()("@talkto/api-keys/Guard") {}

const cacheSeconds = (raw: string | undefined) => {
  const value = raw === undefined ? Number.NaN : Number(raw);
  // At most 30: the website promises a revoked key stops working within 30 seconds.
  return Number.isInteger(value) && value >= 0 && value <= defaultCacheSeconds
    ? value
    : defaultCacheSeconds;
};

/** The guard for one request; `request` is null when a key is made (nothing to count). */
export const make = (env: Env, request: Request | null) => {
  const key = tagKey(env.TALKTO_API_KEY_SECRET);
  // Edge-supplied, never a client header: Cloudflare overwrites cf-connecting-ip.
  const address = request?.headers.get("cf-connecting-ip") ?? null;
  const network = address === null || address === "" ? null : Starter.network(address);
  const limiter = env.SIGNAL_FAILURES;
  return Guard.of({
    tagged: key !== null,
    mint: Effect.gen(function* () {
      if (key === null)
        return K.Secret.make(
          `${K.secretPrefix}${Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(secretBytes)))}`,
        );
      const nonce = crypto.getRandomValues(new Uint8Array(secretBytes - tagBytes));
      const bytes = new Uint8Array(secretBytes);
      bytes.set(nonce);
      bytes.set(yield* tag(key, nonce), secretBytes - tagBytes);
      return K.Secret.make(`${K.secretPrefix}${Encoding.encodeBase64Url(bytes)}`);
    }),
    genuine: Effect.fn("ApiKeyGuard.genuine")(function* (secret: string) {
      if (key === null) return true;
      const decoded = Encoding.decodeBase64Url(secret.slice(K.secretPrefix.length));
      if (Result.isFailure(decoded) || decoded.success.byteLength !== secretBytes) return false;
      const expected = yield* tag(key, decoded.success.slice(0, secretBytes - tagBytes));
      const given = decoded.success.slice(secretBytes - tagBytes);
      let difference = 0;
      for (let index = 0; index < tagBytes; index++)
        difference |= (expected[index] ?? 0) ^ (given[index] ?? 0);
      return difference === 0;
    }),
    cacheMs: cacheSeconds(env.TALKTO_API_KEY_CACHE_SECONDS) * 1000,
    retryAfter: Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        const until = network === null ? 0 : (blockedUntil.get(network) ?? 0);
        return until > now ? Math.max(1, Math.ceil((until - now) / 1000)) : null;
      }),
    ),
    failed: Effect.gen(function* () {
      if (network === null || limiter === undefined) return;
      const outcome = yield* Effect.promise(() =>
        limiter.limit({ key: `api-key:${network}` }).catch(() => ({ success: true })),
      );
      if (outcome.success) return;
      remember(blockedUntil, network, (yield* Clock.currentTimeMillis) + blockedMs);
    }),
  });
};

/** The remembered key for a secret hash; undefined when this isolate must read D1. */
export const cachedKey = (digest: string, now: number) => {
  const entry = keys.get(digest);
  return entry !== undefined && entry.until > now ? entry.key : undefined;
};
/** Remember a key (or its absence) for `cacheMs`; 0 remembers nothing. */
export const rememberKey = (
  digest: string,
  key: Store.Row | null,
  now: number,
  cacheMs: number,
) => {
  if (cacheMs > 0) remember(keys, digest, { key, until: now + cacheMs });
};
/** Forget a revoked key in this isolate, so it stops here at once. */
export const forgetKey = (id: string) => {
  for (const [digest, entry] of keys) if (entry.key?.id === id) keys.delete(digest);
  recorded.delete(id);
};
/** Forget every key of a person in this isolate, when their account deletion begins. */
export const forgetPerson = (userId: string) => {
  for (const [digest, entry] of keys) if (entry.key?.userId === userId) keys.delete(digest);
};
/** Whether this use should be written as the key's last use: at most once per `interval`. */
export const shouldRecord = (key: Store.Row, now: number, interval: number) => {
  const last = Math.max(recorded.get(key.id) ?? 0, key.lastUsedAt ?? 0);
  if (last > now - interval) return false;
  remember(recorded, key.id, now);
  return true;
};
/**
 * The organization a server is in, remembered per isolate; null for an unknown server. A server
 * never changes organization today. If moving servers between organizations is ever added, this
 * memory must be cleared or shortened with it, or an organization-limited key could reach a moved
 * server for up to 10 minutes.
 */
export const serverAccount = Effect.fn("ApiKeyGuard.serverAccount")(function* (
  store: Store.Store["Service"],
  serverId: string,
) {
  const now = yield* Clock.currentTimeMillis;
  const cached = servers.get(serverId);
  if (cached !== undefined && cached.until > now) return cached.accountId;
  const accountId = yield* store.serverAccount(serverId);
  remember(servers, serverId, {
    accountId,
    until: now + (accountId === null ? serverMissingMs : serverFoundMs),
  });
  return accountId;
});
