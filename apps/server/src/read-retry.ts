import { Effect, Random } from "effect";
import { runtimeFlags, type RuntimeFlags } from "./failure-log.js";

/*
  Reads whose Durable Object call failed in a way Cloudflare marks as passing:
  - `overloaded`: the object is busy. Never tried again, so it gets no extra load; the agent is told
    the server is briefly unavailable (storage_unavailable), not internal_error.
  - `retryable` and not overloaded: one more try, through a fresh stub, since Cloudflare may break
    a stub after a failure. Overloaded, or retryable again, on that try: unavailable too.
  - Anything else fails as before.
  Only reads: a mutation may have committed before its call failed, so it is never sent twice.
  Sentry issue TALKTO-SERVER-Z (November 26, 2026): agents got internal_error from get_updates for
  a transient failure (03:27Z), then for an overloaded object (13:04Z).
*/

/** Whether Cloudflare marks a failure transient and the object not overloaded: worth one more try. */
export const retryable = (flags: RuntimeFlags) =>
  flags.retryable === true && flags.overloaded !== true;

/** Whether the object is busy: answered as unavailable, never tried again. */
export const overloaded = (flags: RuntimeFlags) => flags.overloaded === true;

/** MCP tools that only read, so a second try changes nothing an agent sees. */
export const readTools: ReadonlySet<string> = new Set([
  "get_updates",
  "read_messages",
  "read_tasks",
  "read_transfer",
]);

/** How a retried read ended: its answer, or a transient failure twice in a row. */
export type Retried<A> =
  | { readonly kind: "answered"; readonly value: A }
  | { readonly kind: "unavailable"; readonly defect: unknown };

/** A short jittered pause, so callers that failed together do not try again together. */
export const pause: Effect.Effect<void> = Random.nextIntBetween(100, 300).pipe(
  Effect.flatMap((millis) => Effect.sleep(millis)),
);

/**
 * Run `attempt`. An overloaded object is unavailable at once; a transient failure pauses and runs
 * it once more on a fresh stub (`fresh`), where overloaded or transient again is unavailable. Any
 * other failure, at either try, fails as before.
 */
export const twice = <A>(
  attempt: (fresh: boolean) => Effect.Effect<A>,
  wait: Effect.Effect<void> = pause,
): Effect.Effect<Retried<A>> => {
  const answered = (value: A): Retried<A> => ({ kind: "answered", value });
  return attempt(false).pipe(
    Effect.map(answered),
    Effect.catchDefect((first) => {
      const flags = runtimeFlags(first);
      if (overloaded(flags))
        return Effect.succeed<Retried<A>>({ kind: "unavailable", defect: first });
      if (!retryable(flags)) return Effect.die(first);
      return wait.pipe(
        Effect.andThen(attempt(true)),
        Effect.map(answered),
        Effect.catchDefect((second) => {
          const again = runtimeFlags(second);
          return overloaded(again) || retryable(again)
            ? Effect.succeed<Retried<A>>({ kind: "unavailable", defect: second })
            : Effect.die(second);
        }),
      );
    }),
  );
};

/** What an agent is told when a read is unavailable: try again, nothing is wrong. */
export const unavailableMessage =
  "The server is briefly unavailable. Nothing was lost: call again in a few seconds.";
