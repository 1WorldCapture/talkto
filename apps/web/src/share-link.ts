/*
  Carries a share link's code through sign-up (docs/share-links-spec.md). Any page that opens with
  `?ref=<code>` keeps the code in this browser for 30 days and removes it from the address bar.
  Sign-in is unchanged: the code never reaches WorkOS. The dashboard sends it once the person owns
  an organization. Kept free of React so the public pages stay small.
*/
import { Schema } from "effect";

const key = "talkto-share-ref";
const parameter = "ref";
const pattern = /^[A-Za-z0-9_-]{22}$/;
const lifetime = 30 * 86_400_000;

/**
 * The share code in an address, and the same address without it. Null when the address carries no
 * well-formed code; other parameters and the hash are kept.
 */
export function shareCodeIn(
  href: string,
): { readonly code: string; readonly cleaned: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const code = url.searchParams.get(parameter);
  if (code === null || !pattern.test(code)) return null;
  url.searchParams.delete(parameter);
  return { code, cleaned: `${url.pathname}${url.search}${url.hash}` };
}

const Stored = Schema.fromJsonString(
  Schema.Struct({ code: Schema.String.check(Schema.isPattern(pattern)), at: Schema.Number }),
);
const decodeStored = Schema.decodeUnknownOption(Stored);

/** A stored code, if it is well formed and younger than 30 days at `now`. */
export function storedCode(raw: string | null, now: number): string | null {
  if (raw === null) return null;
  const value = decodeStored(raw);
  if (value._tag === "None") return null;
  return now - value.value.at < lifetime ? value.value.code : null;
}

/** Keep the page's share code, if any, and take it out of the address bar. */
export function captureShareCode() {
  if (typeof location === "undefined") return;
  const found = shareCodeIn(location.href);
  if (found === null) return;
  try {
    localStorage.setItem(key, JSON.stringify({ code: found.code, at: Date.now() }));
  } catch {
    // Storage may be blocked; the link then simply does nothing.
  }
  try {
    history.replaceState(history.state, "", found.cleaned);
  } catch {
    // Leaving the code in the address bar is harmless.
  }
}

/** The kept share code, or null. */
export function readShareCode(): string | null {
  try {
    return storedCode(localStorage.getItem(key), Date.now());
  } catch {
    return null;
  }
}

/** Forget the kept share code. */
export function forgetShareCode() {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to forget.
  }
}
