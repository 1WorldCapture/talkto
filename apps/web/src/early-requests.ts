import { Option, Schema } from "effect";
import { Preferences } from "./message-preferences.js";

/*
  Dashboard reads started before the dashboard code loads. A cold load spends several hundred
  milliseconds loading and starting that code before its first request; these reads run meanwhile.
  Only the session check starts at once. The other reads start after it succeeds, so they carry a
  refreshed session cookie and never refresh the session in parallel. The first matching GET from
  the API client takes each response (see `request` in api.ts); unclaimed ones expire unread.
*/

const lifetime = 10_000;
const started = new Map<string, { readonly response: Promise<Response>; readonly at: number }>();
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const accountRoute = new RegExp(`^/app/accounts/(${uuid})(?:/([a-z]+)(?:/(${uuid}))?)?/?$`);

const start = (path: string) => {
  const response = fetch(path, { headers: { accept: "application/json" } });
  // A read nobody claims must not report an unhandled rejection; a claimant still sees it.
  response.catch(() => undefined);
  started.set(path, { response, at: performance.now() });
  return response;
};

/** Home asks for 50 feed items unless this browser saved another size for someone. */
const defaultFeedSize = () => {
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key === null || !key.startsWith("talkto:message-display:")) continue;
      const saved = Schema.decodeUnknownOption(Schema.fromJsonString(Preferences))(
        localStorage.getItem(key),
      );
      if (Option.isSome(saved) && saved.value.size !== 50) return false;
    }
    return true;
  } catch {
    return false;
  }
};

/** The reads the dashboard makes first for this location, after the session check. */
const firstReads = (pathname: string, search: string) => {
  if (pathname === "/app" || pathname === "/app/")
    return ["/v1/accounts?limit=20", "/v1/onboarding", "/v1/shared"];
  const match = accountRoute.exec(pathname);
  if (match === null) return [];
  const [, account, view, server] = match;
  const reads = [`/v1/accounts/${account}`];
  if (view === undefined && !new URLSearchParams(search).has("billing")) {
    reads.push(`/v1/accounts/${account}/starter`);
    if (defaultFeedSize()) reads.push(`/v1/accounts/${account}/dashboard?limit=50`);
  } else if (view === "servers" && server !== undefined)
    reads.push(`/v1/accounts/${account}/servers/${server}`);
  return reads;
};

/** Start the session check, then this location's first reads once it succeeds. */
export function startEarlyRequests(location: Location) {
  const reads = firstReads(location.pathname, location.search);
  void start("/v1/me").then(
    (response) => {
      if (response.ok) for (const path of reads) start(path);
    },
    () => undefined,
  );
}

/** Claim an early response for a same-origin GET, once, while it is fresh. */
export function takeEarlyResponse(url: string, method: string): Promise<Response> | undefined {
  if (method !== "GET" || started.size === 0) return undefined;
  const parsed = new URL(url, location.href);
  if (parsed.origin !== location.origin) return undefined;
  const key = parsed.pathname + parsed.search;
  const entry = started.get(key);
  if (entry === undefined) return undefined;
  started.delete(key);
  return performance.now() - entry.at <= lifetime ? entry.response : undefined;
}
