import { Effect, Encoding, Redacted, Result, Schema } from "effect";

/*
  Unsubscribe tokens and suppression keys, both derived from TALKTO_EMAIL_SIGNING_SECRET.

  A token is the person's WorkOS user ID sealed with AES-256-GCM, so the link is opaque (it does
  not show the ID) and signed (GCM's tag fails on any change or a different secret). The IV comes
  from an HMAC of the plaintext, so one person's link is always the same string: a retried batch
  renders identical emails and keeps the provider's idempotency key valid. Equal links for the same
  person reveal nothing new. Rotating the secret ends every link already sent.
*/

const text = new TextEncoder();
const bytes = (value: Uint8Array) => new Uint8Array(value);
const version = 1;
/** Who a token unsubscribes, and from what. Only product updates can be unsubscribed. */
const Claims = Schema.Struct({
  v: Schema.Literal(version),
  u: Schema.String.check(Schema.isPattern(/^user_[A-Za-z0-9]{1,64}$/)),
  t: Schema.Literal("product_updates"),
});
const decodeClaims = Schema.decodeUnknownResult(Schema.fromJsonString(Claims));

interface Keys {
  readonly seal: CryptoKey;
  readonly iv: CryptoKey;
  readonly address: CryptoKey;
}
const cache = new Map<string, Promise<Keys>>();
/** Three independent keys from one secret, through HKDF-SHA-256 with distinct labels. */
const keys = (secret: Redacted.Redacted<string>) => {
  const raw = Redacted.value(secret);
  const found = cache.get(raw);
  if (found !== undefined) return found;
  const derived = (async () => {
    const base = await crypto.subtle.importKey("raw", text.encode(raw), "HKDF", false, [
      "deriveKey",
    ]);
    const derive = (
      label: string,
      algorithm: {
        readonly name: "AES-GCM" | "HMAC";
        readonly length: number;
        readonly hash?: string;
      },
    ) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: text.encode(label) },
        base,
        algorithm,
        false,
        algorithm.name === "AES-GCM" ? ["encrypt", "decrypt"] : ["sign"],
      );
    return {
      seal: await derive("talkto-email-unsubscribe-seal-v1", { name: "AES-GCM", length: 256 }),
      iv: await derive("talkto-email-unsubscribe-iv-v1", {
        name: "HMAC",
        hash: "SHA-256",
        length: 256,
      }),
      address: await derive("talkto-email-address-key-v1", {
        name: "HMAC",
        hash: "SHA-256",
        length: 256,
      }),
    };
  })();
  cache.set(raw, derived);
  return derived;
};

/** The opaque, signed token in a person's unsubscribe link. */
export const unsubscribeToken = (secret: Redacted.Redacted<string>, userId: string) =>
  Effect.promise(async () => {
    const { seal, iv } = await keys(secret);
    const plaintext = text.encode(JSON.stringify({ v: version, u: userId, t: "product_updates" }));
    const nonce = new Uint8Array(await crypto.subtle.sign("HMAC", iv, plaintext)).slice(0, 12);
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, seal, plaintext),
    );
    const token = new Uint8Array(1 + nonce.byteLength + sealed.byteLength);
    token.set([version], 0);
    token.set(nonce, 1);
    token.set(sealed, 1 + nonce.byteLength);
    return Encoding.encodeBase64Url(token);
  });

/** The user ID a token names, or null for anything altered, foreign or malformed. */
export const readUnsubscribeToken = (secret: Redacted.Redacted<string>, token: string) =>
  Effect.promise(async () => {
    if (!/^[A-Za-z0-9_-]{40,400}$/.test(token)) return null;
    const decoded = Encoding.decodeBase64Url(token);
    if (Result.isFailure(decoded) || decoded.success[0] !== version) return null;
    const { seal } = await keys(secret);
    const opened = await crypto.subtle
      .decrypt(
        { name: "AES-GCM", iv: bytes(decoded.success.slice(1, 13)) },
        seal,
        bytes(decoded.success.slice(13)),
      )
      .then(
        (plain) => new TextDecoder().decode(plain),
        () => null,
      );
    if (opened === null) return null;
    const claims = decodeClaims(opened);
    return Result.isSuccess(claims) ? claims.success.u : null;
  });

/** The suppression list's key for an address: an HMAC, so the table never holds the address. */
export const addressKey = (secret: Redacted.Redacted<string>, address: string) =>
  Effect.promise(async () => {
    const { address: key } = await keys(secret);
    const digest = await crypto.subtle.sign("HMAC", key, text.encode(address.trim().toLowerCase()));
    return Encoding.encodeHex(new Uint8Array(digest));
  });
