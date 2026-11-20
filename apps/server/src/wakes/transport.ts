import { Context, Effect, Predicate, Schema } from "effect";
import * as W from "@talkto/api/wake";
import * as Policy from "./policy.js";
import { sameText } from "./crypto.js";

/** One outbound POST. The policy travels with it so the allowlist is checked at send time too. */
export interface Request {
  readonly policy: Policy.Policy;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
/** How a POST ended. Nothing from the response body is ever kept. */
export type Outcome =
  | { readonly _tag: "Delivered" }
  /** No answer in time: the host may or may not have started a run. */
  | { readonly _tag: "Uncertain" }
  | {
      readonly _tag: "Retry";
      readonly reason: Policy.Reason;
      readonly retryAfterMs: number | null;
    }
  | { readonly _tag: "Refused"; readonly reason: Policy.Reason };
/** How a verification challenge ended. `status` is the callback's HTTP status, when it answered. */
export type Verification =
  | { readonly _tag: "Verified" }
  | { readonly _tag: "Failed"; readonly reason: Policy.Reason; readonly status: number | null };

/** Runtime port for outbound wake requests; tests and local runs substitute their own. */
export class WakeTransport extends Context.Service<
  WakeTransport,
  {
    readonly post: (request: Request) => Effect.Effect<Outcome>;
    /** POST a signed challenge and require `{"challenge": <same value>}` back. */
    readonly verify: (request: Request, challenge: string) => Effect.Effect<Verification>;
  }
>()("@talkto/WakeTransport") {}

const maxRetryAfterMs = 3_600_000;
/** `Retry-After` as seconds or an HTTP date, bounded to an hour. */
const retryAfter = (value: string | null, now: number): number | null => {
  if (value === null) return null;
  if (/^\d{1,7}$/.test(value)) return Math.min(Number(value) * 1000, maxRetryAfterMs);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.min(Math.max(0, at - now), maxRetryAfterMs);
};
/** Classify a status code. Redirects are refused: TalkTo never follows one. */
export const classify = (status: number, retryAfterHeader: string | null, now: number): Outcome => {
  if (status >= 200 && status < 300) return { _tag: "Delivered" };
  if (status >= 300 && status < 400) return { _tag: "Refused", reason: "redirect" };
  if (status === 401 || status === 403) return { _tag: "Refused", reason: "unauthorized" };
  if (status === 404) return { _tag: "Refused", reason: "not_found" };
  if (status === 410) return { _tag: "Refused", reason: "gone" };
  if (status === 413) return { _tag: "Refused", reason: "too_large" };
  if (status === 429)
    return {
      _tag: "Retry",
      reason: "rate_limited",
      retryAfterMs: retryAfter(retryAfterHeader, now),
    };
  if (status === 408) return { _tag: "Retry", reason: "timeout", retryAfterMs: null };
  if (status === 425) return { _tag: "Retry", reason: "rejected", retryAfterMs: null };
  if (status >= 500) return { _tag: "Retry", reason: "server_error", retryAfterMs: null };
  return { _tag: "Refused", reason: "rejected" };
};
const isTimeout = (cause: unknown) =>
  Predicate.hasProperty(cause, "name") &&
  (cause.name === "TimeoutError" || cause.name === "AbortError");
const Challenge = Schema.fromJsonString(Schema.Struct({ challenge: Schema.String }));
/** Read at most `limit` bytes of a body, then stop reading. */
const boundedText = async (response: Response, limit: number) => {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
};

/**
 * The deployed transport: HTTPS POST to an allowlisted host only, no redirects followed, a short
 * timeout, and the response body discarded unread (a challenge answer is read up to 4 KiB).
 */
export const fromFetch = (fetcher: typeof fetch) => {
  const send = async (request: Request) => {
    const checked = W.checkUrl(request.policy, request.url);
    if (checked._tag === "Refused") return null;
    return fetcher(checked.url.href, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(Policy.timeoutMs),
    });
  };
  return WakeTransport.of({
    post: (request) =>
      Effect.promise(async (): Promise<Outcome> => {
        try {
          const response = await send(request);
          if (response === null) return { _tag: "Refused", reason: "not_allowed" };
          await response.body?.cancel().catch(() => undefined);
          return classify(response.status, response.headers.get("retry-after"), Date.now());
        } catch (cause) {
          return isTimeout(cause)
            ? { _tag: "Uncertain" }
            : { _tag: "Retry", reason: "connection", retryAfterMs: null };
        }
      }),
    verify: (request, challenge) =>
      Effect.promise(async (): Promise<Verification> => {
        try {
          const response = await send(request);
          if (response === null) return { _tag: "Failed", reason: "not_allowed", status: null };
          if (response.status < 200 || response.status >= 300) {
            await response.body?.cancel().catch(() => undefined);
            const outcome = classify(response.status, null, Date.now());
            return {
              _tag: "Failed",
              reason:
                outcome._tag === "Retry" || outcome._tag === "Refused"
                  ? outcome.reason
                  : "rejected",
              status: response.status,
            };
          }
          const body = await boundedText(response, 4096);
          const answer = body === null ? null : Schema.decodeUnknownOption(Challenge)(body);
          return answer !== null &&
            answer._tag === "Some" &&
            sameText(answer.value.challenge, challenge)
            ? { _tag: "Verified" }
            : { _tag: "Failed", reason: "challenge_failed", status: response.status };
        } catch (cause) {
          return {
            _tag: "Failed",
            reason: isTimeout(cause) ? "timeout" : "connection",
            status: null,
          };
        }
      }),
  });
};
