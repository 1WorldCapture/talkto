/**
 * Account links that only someone holding BETTER_AUTH_SECRET can make (docs/self-host-better-auth.md,
 * "Account links"). Better Auth mode sends no email, so an address is never proven by itself. An
 * account link is the proof for the cases where an address may become an existing person, or
 * the first owner: `pnpm selfhost:link` (apps/server/tools/better-auth-link.mjs) makes one and
 * prints it, and nothing stores it.
 *
 * A code is `<address, base64url>.<expiry, Unix seconds>.<nonce, 32 hex>.<HMAC-SHA256, base64url>`.
 * The HMAC covers a fixed label, the address, the expiry and the nonce. The nonce is spent when an
 * account is created with the code, so each link works once.
 */

/** The longest a link may live, with a few minutes for clock drift. */
const longestSeconds = 7 * 24 * 60 * 60 + 300;
const label = "talkto better-auth account link v1";
const Code = /^([A-Za-z0-9_-]{4,400})\.([0-9]{9,11})\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;

/** A valid code, read but not yet spent. */
export interface Claim {
  readonly email: string;
  readonly expiresAt: number;
  readonly nonce: string;
}

const bytes = (value: string) => new TextEncoder().encode(value);
const fromBase64Url = (value: string) => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

/** The address a code names, to fill the form in. Null for anything that is not a code. */
export const addressOf = (code: string) => {
  const match = Code.exec(code);
  if (match === null) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      fromBase64Url(match[1] ?? ""),
    );
  } catch {
    return null;
  }
};

/**
 * Read a code for this address, or null when it is malformed, for another address, expired, too
 * long-lived, or not signed with this secret. The signature check is constant-time.
 */
export const read = async (
  code: string,
  email: string,
  secret: string,
  nowSeconds: number,
): Promise<Claim | null> => {
  const match = Code.exec(code);
  if (match === null) return null;
  const [, , expiry = "", nonce = "", mac = ""] = match;
  const named = addressOf(code);
  const expiresAt = Number(expiry);
  if (named === null || named !== email) return null;
  if (expiresAt <= nowSeconds || expiresAt > nowSeconds + longestSeconds) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = await crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(mac),
    bytes(`${label}\n${email}\n${expiry}\n${nonce}`),
  );
  return signed ? { email, expiresAt, nonce } : null;
};
