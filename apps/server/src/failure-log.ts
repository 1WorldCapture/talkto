/** What an unexpected failure may put in a log line: its shape, never its free text. */
import { Predicate, Result, Schema } from "effect";

/** Identifier-shaped text only: a tag, class name, code or operation, never free text. */
const SafeName = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.]{0,100}$/));
const decodeName = Schema.decodeUnknownResult(SafeName);
/** `value` when it is identifier-shaped text, otherwise null. Safe to log. */
export const safeName = (value: string) => Result.getOrNull(decodeName(value));
/** The tag or class name of a failure, when it is identifier-shaped. */
const failureTag = (cause: unknown) =>
  (Predicate.hasProperty(cause, "_tag") ? Result.getOrNull(decodeName(cause._tag)) : null) ??
  (Predicate.isError(cause) ? Result.getOrNull(decodeName(cause.name)) : null) ??
  "unknown";

/** Boolean properties Cloudflare sets on a runtime error, such as a Durable Object call's. */
const runtimeFlagNames = ["retryable", "overloaded", "remote"] as const;
/** Cloudflare's runtime flags on a failure. */
export type RuntimeFlags = Partial<Record<(typeof runtimeFlagNames)[number], boolean>>;
/** The Cloudflare runtime flags a failure carries, each only when it is a boolean. */
export const runtimeFlags = (cause: unknown): RuntimeFlags =>
  Object.fromEntries(
    runtimeFlagNames.flatMap((name) =>
      Predicate.hasProperty(cause, name) && Predicate.isBoolean(cause[name])
        ? [[name, cause[name]]]
        : [],
    ),
  );

/** Which step of a call to a server object failed: fixed words, never caller data. */
export type Step = "invoke" | "watch" | "first_read";
const steps = new WeakMap<object, Step>();
/** Record the step a rejection came from, without changing it. The innermost step is kept. */
export const atStep = (cause: unknown, step: Step) => {
  if (Predicate.isObjectKeyword(cause) && !steps.has(cause)) steps.set(cause, step);
};
/** The step `atStep` recorded for a failure, or null. */
export const stepOf = (cause: unknown): Step | null =>
  Predicate.isObjectKeyword(cause) ? (steps.get(cause) ?? null) : null;

/** Structural fields a tagged failure may carry; each is kept only when identifier-shaped. */
const failureFields = (cause: unknown) => ({
  failure: failureTag(cause),
  code: Predicate.hasProperty(cause, "code") ? Result.getOrNull(decodeName(cause.code)) : null,
  operation: Predicate.hasProperty(cause, "operation")
    ? Result.getOrNull(decodeName(cause.operation))
    : null,
  ...runtimeFlags(cause),
});
type FailureFields = ReturnType<typeof failureFields>;
/** The log fields `describeFailure` gives. */
type Described = FailureFields & { readonly cause: FailureFields | null; step?: Step };
/**
 * Safe log fields for an unexpected failure: its tag or name, identifier-shaped `code` and
 * `operation` fields and Cloudflare's boolean `retryable`, `overloaded` and `remote` flags, one
 * `cause` deep, and the server-object call step it failed at. Never an error's message: messages
 * can quote request content, message text, file names or credentials, and request logs are not
 * the place for them. The client still sees only `internal_error`.
 */
export const describeFailure = (cause: unknown) => {
  const described: Described = {
    ...failureFields(cause),
    cause:
      Predicate.isError(cause) && cause.cause !== undefined ? failureFields(cause.cause) : null,
  };
  const step = stepOf(cause);
  if (step !== null) described.step = step;
  return described;
};
