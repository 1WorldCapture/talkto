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
/** Structural fields a tagged failure may carry; each is kept only when identifier-shaped. */
const failureFields = (cause: unknown) => ({
  failure: failureTag(cause),
  code: Predicate.hasProperty(cause, "code") ? Result.getOrNull(decodeName(cause.code)) : null,
  operation: Predicate.hasProperty(cause, "operation")
    ? Result.getOrNull(decodeName(cause.operation))
    : null,
});
/**
 * Safe log fields for an unexpected failure: its tag or name and identifier-shaped `code` and
 * `operation` fields, one `cause` deep. Never an error's message: messages can quote request
 * content, message text, file names or credentials, and request logs are not the place for them.
 * The client still sees only `internal_error`.
 */
export const describeFailure = (cause: unknown) => ({
  ...failureFields(cause),
  cause: Predicate.isError(cause) && cause.cause !== undefined ? failureFields(cause.cause) : null,
});
