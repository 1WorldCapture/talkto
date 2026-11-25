import { Clock, Effect, Encoding, Result } from "effect";
import * as AI from "@talkto/api/agent-invites";
import * as Starter from "../starter/inbox.js";
import * as WakeCrypto from "../wakes/crypto.js";

/*
  Invite codes (`tki_`) and invited agents' keys (`tka_`) name their server and carry an HMAC tag
  made with `TALKTO_API_KEY_SECRET` under their own labels, like personal API keys
  (api-keys/guard.ts): a made-up code or key is refused before any hash, D1 read or server object
  call, and the server's ID routes a key with no D1 read at all (KEY_DECISIONS: no D1 on sends or
  reads). Without the secret, codes and keys are fully random and every check reaches storage.
  Failed checks count against `SIGNAL_FAILURES` per network under an `invite:` prefix, and every
  redeem and request check under `invite-use:`; over either limit, that network gets 429 for a
  minute.
*/

const secretBytes = 32;
const tagBytes = 16;
const blockedMs = 60_000;
const remembered = 10_000;
const blockedUntil = new Map<string, number>();
const block = (network: string, until: number) => {
  blockedUntil.delete(network);
  blockedUntil.set(network, until);
  if (blockedUntil.size <= remembered) return;
  const oldest = blockedUntil.keys().next();
  if (oldest.done !== true) blockedUntil.delete(oldest.value);
};

type Kind = "code" | "key";
const prefixes: Readonly<Record<Kind, string>> = { code: AI.codePrefix, key: AI.keyPrefix };
const labels: Readonly<Record<Kind, string>> = {
  code: "talkto-agent-invite-v1",
  key: "talkto-invited-agent-v1",
};
const credentialPattern = /^tk[ia]_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

let loaded: { readonly raw: string; readonly key: Promise<CryptoKey> } | null = null;
const tagKey = (raw: string | undefined): Promise<CryptoKey> | null => {
  if (raw === undefined) return null;
  if (loaded?.raw === raw) return loaded.key;
  const bytes = WakeCrypto.parseKey(raw);
  if (bytes === null) return null;
  const key = crypto.subtle.importKey(
    "raw",
    new Uint8Array(bytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  loaded = { raw, key };
  return key;
};
const tag = (key: Promise<CryptoKey>, kind: Kind, serverId: string, nonce: Uint8Array) =>
  Effect.promise(async () => {
    const message = `${labels[kind]}:${serverId}:${Encoding.encodeBase64Url(nonce)}`;
    const mac = await crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(message));
    return new Uint8Array(mac).slice(0, tagBytes);
  });

/** A new code or key for a server: tagged when the deployment has the secret. */
export const mint = Effect.fn("InviteGuard.mint")(function* (
  env: Env,
  kind: Kind,
  serverId: string,
) {
  const key = tagKey(env.TALKTO_API_KEY_SECRET);
  const bytes = crypto.getRandomValues(new Uint8Array(secretBytes));
  if (key !== null)
    bytes.set(
      yield* tag(key, kind, serverId, bytes.slice(0, secretBytes - tagBytes)),
      secretBytes - tagBytes,
    );
  return `${prefixes[kind]}${serverId}.${Encoding.encodeBase64Url(bytes)}`;
});

/** The server a code or key names, when this deployment could have made it; else null. */
export const genuine = Effect.fn("InviteGuard.genuine")(function* (
  env: Env,
  kind: Kind,
  value: string,
) {
  const match = credentialPattern.exec(value);
  if (match === null || !value.startsWith(prefixes[kind])) return null;
  const serverId = match[1] ?? "";
  const key = tagKey(env.TALKTO_API_KEY_SECRET);
  if (key === null) return serverId;
  const decoded = Encoding.decodeBase64Url(match[2] ?? "");
  if (Result.isFailure(decoded) || decoded.success.byteLength !== secretBytes) return null;
  const expected = yield* tag(
    key,
    kind,
    serverId,
    decoded.success.slice(0, secretBytes - tagBytes),
  );
  const given = decoded.success.slice(secretBytes - tagBytes);
  let difference = 0;
  for (let index = 0; index < tagBytes; index++)
    difference |= (expected[index] ?? 0) ^ (given[index] ?? 0);
  return difference === 0 ? serverId : null;
});

/** SHA-256 of a code, key or pickup secret, lowercase hex. */
export const hash = (secret: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))).pipe(
    Effect.map((digest) => Encoding.encodeHex(new Uint8Array(digest))),
  );

/** A pickup secret: 32 random bytes, base64url. Only its hash is stored. */
export const pickup = () =>
  Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(secretBytes)));

// Edge-supplied, never a client header: Cloudflare overwrites cf-connecting-ip.
const networkOf = (request: Request) => {
  const address = request.headers.get("cf-connecting-ip");
  return address === null || address === "" ? null : Starter.network(address);
};

/** Seconds until this request's network may try again; null when it is not refused. */
export const retryAfter = Effect.fn("InviteGuard.retryAfter")(function* (request: Request) {
  const network = networkOf(request);
  const now = yield* Clock.currentTimeMillis;
  const until = network === null ? 0 : (blockedUntil.get(network) ?? 0);
  return until > now ? Math.max(1, Math.ceil((until - now) / 1000)) : null;
});

/** Count a wrong code, key or pickup secret against this request's network. */
export const failed = Effect.fn("InviteGuard.failed")(function* (env: Env, request: Request) {
  const network = networkOf(request);
  const limiter = env.SIGNAL_FAILURES;
  if (network === null || limiter === undefined) return;
  const outcome = yield* Effect.promise(() =>
    limiter.limit({ key: `invite:${network}` }).catch(() => ({ success: true })),
  );
  if (outcome.success) return;
  block(network, (yield* Clock.currentTimeMillis) + blockedMs);
});

/**
 * Count every redeem and request check against this request's network, valid or not, under its
 * own key: a network that redeems or polls too fast gets 429 for a minute, as for wrong secrets.
 */
export const used = Effect.fn("InviteGuard.used")(function* (env: Env, request: Request) {
  const network = networkOf(request);
  const limiter = env.SIGNAL_FAILURES;
  if (network === null || limiter === undefined) return true;
  const outcome = yield* Effect.promise(() =>
    limiter.limit({ key: `invite-use:${network}` }).catch(() => ({ success: true })),
  );
  if (outcome.success) return true;
  block(network, (yield* Clock.currentTimeMillis) + blockedMs);
  return false;
});
