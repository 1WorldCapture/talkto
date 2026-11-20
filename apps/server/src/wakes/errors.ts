import { Schema } from "effect";

/**
 * The callback did not prove itself; nothing was stored. `reason` is the MCP events category the
 * client sees; `detail` (a delivery reason code) and `status` (the callback's HTTP status) are
 * for TalkTo's own log only.
 */
export class CallbackFailed extends Schema.TaggedError<CallbackFailed>()("CallbackFailed", {
  reason: Schema.String,
  detail: Schema.String,
  status: Schema.NullOr(Schema.Int),
}) {}
/** The participant already holds as many subscriptions or wakes as allowed. */
export class TargetLimit extends Schema.TaggedError<TargetLimit>()("TargetLimit", {
  max: Schema.Int,
}) {}
