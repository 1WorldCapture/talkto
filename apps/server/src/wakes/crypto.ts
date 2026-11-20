import { Context, Effect, Encoding, Result, Schema } from "effect";

/** A stored secret cannot be opened: the key changed, the row was moved, or it was altered. */
export class SealBroken extends Schema.TaggedError<SealBroken>()("SealBroken", {}) {}

/**
 * Runtime port that encrypts wake secrets at rest. `binding` names the row a secret belongs to
 * (server, wake ID and kind) and is authenticated with it, so a sealed value copied into another
 * row does not open.
 */
export class WakeSealer extends Context.Service<
  WakeSealer,
  {
    readonly seal: (plaintext: string, binding: string) => Effect.Effect<string, SealBroken>;
    readonly open: (sealed: string, binding: string) => Effect.Effect<string, SealBroken>;
  }
>()("@talkto/WakeSealer") {}

/** No key bound: nothing can be sealed or opened, and no wake is offered. */
export const unavailable = WakeSealer.of({
  seal: () => Effect.fail(new SealBroken()),
  open: () => Effect.fail(new SealBroken()),
});

const bytes = (value: Uint8Array) => new Uint8Array(value);
const text = new TextEncoder();
/** Parse a 32-byte key (`TALKTO_WAKE_KEY`, `TALKTO_SIGNAL_KEY`): base64 or base64url. Null for anything else. */
export const parseKey = (raw: string | undefined): Uint8Array | null => {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  const decoded = /[+/=]/.test(trimmed)
    ? Encoding.decodeBase64(trimmed)
    : Encoding.decodeBase64Url(trimmed);
  return Result.isSuccess(decoded) && decoded.success.byteLength === 32 ? decoded.success : null;
};
const version = "v1";
/**
 * AES-256-GCM with a fresh 96-bit IV per value: `v1.<iv>.<ciphertext+tag>`, base64url. The key
 * is imported once, non-extractable, the first time it is used.
 */
export const fromKey = (raw: Uint8Array): WakeSealer["Service"] => {
  let imported: Promise<CryptoKey> | null = null;
  const key = () =>
    (imported ??= crypto.subtle.importKey("raw", bytes(raw), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]));
  return WakeSealer.of({
    seal: (plaintext, binding) =>
      Effect.tryPromise({
        try: async () => {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const sealed = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, additionalData: text.encode(binding) },
            await key(),
            text.encode(plaintext),
          );
          return `${version}.${Encoding.encodeBase64Url(iv)}.${Encoding.encodeBase64Url(new Uint8Array(sealed))}`;
        },
        catch: () => new SealBroken(),
      }),
    open: (sealed, binding) =>
      Effect.tryPromise({
        try: async () => {
          const [tag, iv, body] = sealed.split(".");
          const ivBytes = Encoding.decodeBase64Url(iv ?? "");
          const bodyBytes = Encoding.decodeBase64Url(body ?? "");
          if (tag !== version || Result.isFailure(ivBytes) || Result.isFailure(bodyBytes))
            throw new Error("Malformed sealed value");
          const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: bytes(ivBytes.success), additionalData: text.encode(binding) },
            await key(),
            bytes(bodyBytes.success),
          );
          return new TextDecoder().decode(plain);
        },
        catch: () => new SealBroken(),
      }),
  });
};
/** The sealer a deployment's environment supports. */
export const fromEnv = (env: Env) => {
  const key = parseKey(env.TALKTO_WAKE_KEY);
  return key === null ? unavailable : fromKey(key);
};

/** Lowercase hex SHA-256 of a string. */
export const sha256 = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", text.encode(value))).pipe(
    Effect.map((digest) => Encoding.encodeHex(new Uint8Array(digest))),
  );
/** Fresh random bytes, base64url. */
export const random = (length: number) =>
  Effect.sync(() => Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(length))));

/**
 * Decode a Standard Webhooks secret: `whsec_` and the base64 of 24–64 random bytes. Clients
 * disagree on standard versus URL-safe base64, so both are accepted.
 */
export const webhookKey = (secret: string): Uint8Array | null => {
  if (!secret.startsWith("whsec_")) return null;
  const body = secret.slice("whsec_".length);
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(body)) return null;
  const decoded = /[-_]/.test(body)
    ? Encoding.decodeBase64Url(body.replace(/=+$/, ""))
    : Encoding.decodeBase64(body);
  if (Result.isFailure(decoded)) return null;
  const length = decoded.success.byteLength;
  return length >= 24 && length <= 64 ? decoded.success : null;
};
/**
 * Standard Webhooks signature: `v1,` and the base64 HMAC-SHA256 of `{id}.{timestamp}.{body}`,
 * signed over the exact body bytes that are sent.
 */
export const signWebhook = (key: Uint8Array, id: string, timestamp: number, body: string) =>
  Effect.promise(async () => {
    const imported = await crypto.subtle.importKey(
      "raw",
      bytes(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      imported,
      text.encode(`${id}.${timestamp}.${body}`),
    );
    return `v1,${Encoding.encodeBase64(new Uint8Array(signature))}`;
  });
/** Compare two strings without an early exit on the first difference. */
export const sameText = (left: string, right: string) => {
  const a = text.encode(left);
  const b = text.encode(right);
  let difference = a.byteLength ^ b.byteLength;
  for (let index = 0; index < Math.max(a.byteLength, b.byteLength); index++)
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
};
