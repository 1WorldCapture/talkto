import { Effect } from "effect";
// The client entry exports the platform-neutral tracer without pulling Node runtime adapters into Workers.
import { SentryEffectTracer } from "@sentry/effect/client";

/** Attach Sentry's Effect v4 tracer; the platform SDK owns initialization, isolation and delivery. */
export function trace<A, E, R>(operation: Effect.Effect<A, E, R>) {
  return operation.pipe(Effect.withTracer(SentryEffectTracer));
}

/** Run an imperative Effect boundary under the surrounding Sentry request without changing its result. */
export function run<A, E>(
  operation: Effect.Effect<A, E>,
  options?: { readonly signal?: AbortSignal },
) {
  return Effect.runPromise(trace(operation), options);
}
