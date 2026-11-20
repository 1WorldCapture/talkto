import { Effect, Redacted } from "effect";
import * as Model from "./model.js";

const googleDomains = new Set(["gmail.com", "googlemail.com"]);

/**
 * The mailbox an address delivers to, for one-time eligibility only; sign-in identities and stored
 * addresses are never changed. Case and any `+tag` are ignored for every domain. Gmail also ignores
 * dots and treats googlemail.com as gmail.com.
 */
export const canonical = (email: string) => {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0) return address;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const plus = local.indexOf("+");
  // A local part that starts with "+" has no mailbox left to compare; keep it as typed.
  const untagged = plus > 0 ? local.slice(0, plus) : local;
  return googleDomains.has(domain)
    ? `${untagged.replaceAll(".", "")}@gmail.com`
    : `${untagged}@${domain}`;
};

/**
 * The rule before November 16, 2026: only Gmail spellings were folded. Claims recorded then are
 * keyed by it, so admission compares this key too. Equal to `canonical` unless the address is a
 * non-Gmail one with a `+tag`.
 */
export const previous = (email: string) => {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0 || !googleDomains.has(address.slice(at + 1))) return address;
  const local = address.slice(0, at);
  const plus = local.indexOf("+");
  return `${(plus === -1 ? local : local.slice(0, plus)).replaceAll(".", "")}@gmail.com`;
};

/** Network block for observation: an IPv4 address, or the /64 an IPv6 address belongs to. */
export const network = (address: string) => {
  if (!address.includes(":")) return address;
  const [head = "", tail] = address.split("::");
  const groups = head === "" ? [] : head.split(":");
  const rest = tail === undefined || tail === "" ? [] : tail.split(":");
  const full = [
    ...groups,
    ...Array(Math.max(0, 8 - groups.length - rest.length)).fill("0"),
    ...rest,
  ];
  return `${full
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
};

/** Versioned HMAC so a key from one purpose can never be compared with another. */
export const key = (secret: Redacted.Redacted<string>, purpose: string, value: string) =>
  Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder();
      const material = await crypto.subtle.importKey(
        "raw",
        encoder.encode(Redacted.value(secret)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const digest = await crypto.subtle.sign(
        "HMAC",
        material,
        encoder.encode(`${purpose}:${value}`),
      );
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
    },
    catch: () => Model.unavailable("claim_key"),
  });
