import { Effect, Random } from "effect";
import { runtimeFlags, type RuntimeFlags } from "./failure-log.js";

/*
  One more try for a read whose Durable Object call failed in a way Cloudflare marks transient
  (`retryable`, and not `overloaded`, so a struggling object gets no extra load). Only reads: a
  mutation may have committed before its call failed, so it is never sent twice. The second try
  goes through a fresh stub, since Cloudflare may break a stub after a failure. Sentry issue
  TALKTO-SERVER-Z (November 26, 2026): agents got internal_error from get_updates when one
  transient failure would have passed on a second try.
*/

/** Whether Cloudflare marks a failure transient and the object not overloaded. */
export const retryable = (flags: RuntimeFlags) =>
  flags.retryable === true && flags.overloaded !== true;

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
 * Run `attempt`; if it fails transiently, pause and run it once more on a fresh stub (`fresh`).
 * Any other failure, at either try, fails as before.
 */
export const twice = <A>(
  attempt: (fresh: boolean) => Effect.Effect<A>,
  wait: Effect.Effect<void> = pause,
): Effect.Effect<Retried<A>> => {
  const answered = (value: A): Retried<A> => ({ kind: "answered", value });
  return attempt(false).pipe(
    Effect.map(answered),
    Effect.catchDefect((first) =>
      retryable(runtimeFlags(first))
        ? wait.pipe(
            Effect.andThen(attempt(true)),
            Effect.map(answered),
            Effect.catchDefect((second): Effect.Effect<Retried<A>> =>
              retryable(runtimeFlags(second))
                ? Effect.succeed({ kind: "unavailable", defect: second })
                : Effect.die(second),
            ),
          )
        : Effect.die(first),
    ),
  );
};

/** What an agent is told when a read failed transiently twice: try again, nothing is wrong. */
export const unavailableMessage =
  "The server is briefly unavailable. Nothing was lost: call again in a few seconds.";
