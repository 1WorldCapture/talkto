import { Schema } from "effect";
import * as M from "./models.js";
import * as Metering from "./metering.js";

/** Discoverable natural-language documentation for every application response. */
export const Instructions = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
  text: Schema.String,
});
/** Request diagnostics shared by success and failure responses. */
export const Meta = Schema.Struct({
  requestId: Schema.String.check(Schema.isUUID(4)),
  serverTime: M.Timestamp,
  instructions: Instructions,
}).annotate({ identifier: "ResponseMeta" });
/** Parsed public request metadata. */
export interface Meta extends Schema.Schema.Type<typeof Meta> {}
/** Success envelope with current server and related-record context. */
export const successWith = <S extends Schema.Top, C extends Schema.Top>(data: S, included: C) =>
  Schema.Struct({
    data,
    included,
    meta: Schema.Struct({ ...Meta.fields, serverId: M.ServerId }),
  });
/** Success envelope with the standard rich related context. */
export const success = <S extends Schema.Top>(data: S) => successWith(data, M.Included);
const failure = <const C extends ReadonlyArray<string>>(status: number, codes: C) =>
  Schema.Struct({
    error: Schema.Struct({ code: Schema.Literals(codes), message: Schema.String }),
    meta: Meta,
  }).annotate({ httpApiStatus: status, identifier: `Error${status}` });
/** Input failures never echo credentials or raw request bodies. */
export const BadRequest = failure(400, [
  "invalid_input",
  "invalid_cursor",
  "invalid_search",
  "self_conversation",
  "wrong_conversation_kind",
]);
/** Missing or invalid authentication. */
export const Unauthorized = failure(401, ["unauthenticated"]);
/** Paid message capacity exhausted; never an authentication challenge. */
export const PaymentRequired = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literals(["message_allowance_exhausted", "message_payment_required"]),
    message: Schema.String,
    ...Metering.Recovery.fields,
  }),
  meta: Meta,
}).annotate({ httpApiStatus: 402, identifier: "Error402" });
/** Sending coordination failed; retrying the original message key is safe. */
export const SendingUnavailable = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literal("sending_unavailable"),
    message: Schema.String,
    ...Metering.Recovery.fields,
  }),
  meta: Meta,
}).annotate({ httpApiStatus: 503, identifier: "SendingUnavailable" });
/** An authenticated operation violates conversation rules. */
export const Forbidden = failure(403, [
  "protected_general",
  "not_conversation_participant",
  "participant_removed",
  "forbidden",
]);
/** Unknown and inaccessible servers are deliberately indistinguishable. */
export const NotFound = failure(404, [
  "server_unavailable",
  "participant_not_found",
  "conversation_not_found",
  "message_not_found",
  "transfer_not_found",
  "not_found",
  "task_not_found",
]);
/** An idempotency or lifecycle conflict that the caller can resolve. */
export const Conflict = failure(409, [
  "name_taken",
  "idempotency_conflict",
  "revision_conflict",
  "channel_archived",
  "billing_conflict",
  "people_limit_reached",
  "transfer_expired",
  "transfer_not_uploaded",
  "starter_unavailable",
  "server_limit_reached",
  "account_deletion_blocked",
  "board_off",
  "api_key_limit_reached",
]);
/** The organization's stored-file pool is full; space frees as older transfers expire. */
export const StoragePoolFull = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literal("storage_pool_full"),
    message: Schema.String,
    ...Metering.StoragePoolRecovery.fields,
  }),
  meta: Meta,
}).annotate({ httpApiStatus: 409, identifier: "StoragePoolFull" });
/** A structured task-board failure: the code, its message and the fields that explain it. */
const taskFailure = <const C extends string, F extends Schema.Struct.Fields>(
  status: number,
  code: C,
  identifier: string,
  fields: F,
) =>
  Schema.Struct({
    error: Schema.Struct({ code: Schema.Literal(code), message: Schema.String, ...fields }),
    meta: Meta,
  }).annotate({ httpApiStatus: status, identifier });
/** The caller no longer holds the task; nothing changed. Stop working on it. */
export const ClaimLost = taskFailure(409, "claim_lost", "ClaimLost", {
  state: Schema.String,
  epoch: Schema.Int,
  holderId: Schema.optionalKey(M.ParticipantId),
});
/** The task's state does not allow this action. */
export const TaskStateConflict = taskFailure(409, "task_state_conflict", "TaskStateConflict", {
  state: Schema.String,
});
/** This agent cannot claim the task now, and why. */
export const TaskNotClaimable = taskFailure(409, "task_not_claimable", "TaskNotClaimable", {
  reason: Schema.String,
  holderId: Schema.optionalKey(M.ParticipantId),
  expiresAt: Schema.optionalKey(M.Timestamp),
});
/** Tasks of one call need each other in a cycle. */
export const TaskCycle = taskFailure(400, "task_cycle", "TaskCycle", {
  refs: Schema.Array(Schema.String),
});
/** A need names an unknown task, or one that failed or was canceled. */
export const NeedUnavailable = taskFailure(409, "need_unavailable", "NeedUnavailable", {
  taskId: Schema.String,
  state: Schema.optionalKey(Schema.String),
});
/** The server holds as many unfinished tasks as it may. */
export const TaskLimitReached = taskFailure(409, "task_limit_reached", "TaskLimitReached", {
  limit: Schema.Int,
});
/** Reads or polls arrived faster than the configured limit; HTTP also sends Retry-After. */
export const RateLimited = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literal("rate_limited"),
    message: Schema.String,
    ...Metering.RateLimitRecovery.fields,
  }),
  meta: Meta,
}).annotate({ httpApiStatus: 429, identifier: "RateLimited" });
/** Which invitation budget refused an attempt; none names another organization or person. */
export const InvitationLimitScope = Schema.Literals(["recipient", "organization", "unpaid_total"]);
/** Parsed invitation budget scope. */
export type InvitationLimitScope = typeof InvitationLimitScope.Type;
/** When an invitation email may be attempted again. Nothing was sent. */
export const InvitationRecovery = Schema.Struct({
  retryable: Schema.Literal(true),
  action: Schema.Literal("retry_after"),
  retryAfterSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86400 })),
  retryAt: M.Timestamp,
  scope: InvitationLimitScope,
});
/** An invitation send or resend exceeded its email budget; HTTP also sends Retry-After. */
export const InvitationLimited = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literal("invitation_limited"),
    message: Schema.String,
    ...InvitationRecovery.fields,
  }),
  meta: Meta,
}).annotate({ httpApiStatus: 429, identifier: "InvitationLimited" });
/** When the person may send feedback again: the next UTC day. Nothing was stored. */
export const FeedbackRecovery = Schema.Struct({
  retryable: Schema.Literal(true),
  action: Schema.Literal("retry_after"),
  retryAfterSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86400 })),
  retryAt: M.Timestamp,
});
/** The person sent today's maximum number of feedback messages; HTTP also sends Retry-After. */
export const FeedbackLimited = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literal("feedback_limited"),
    message: Schema.String,
    ...FeedbackRecovery.fields,
  }),
  meta: Meta,
}).annotate({ httpApiStatus: 429, identifier: "FeedbackLimited" });
/** Request limits reject oversized transport payloads before parsing. */
export const TooLarge = failure(413, ["request_too_large"]);
/** Unexpected application defect. */
export const InternalError = failure(500, ["internal_error"]);
/** Storage or runtime configuration is unavailable. */
export const Unavailable = failure(503, [
  "storage_unavailable",
  "configuration_unavailable",
  "identity_unavailable",
  "billing_unavailable",
  "files_unavailable",
  "memory_unavailable",
]);
/** All public protocol failure variants, each with its HTTP status annotation. */
export const failures = [
  BadRequest,
  Unauthorized,
  PaymentRequired,
  SendingUnavailable,
  Forbidden,
  NotFound,
  Conflict,
  StoragePoolFull,
  ClaimLost,
  TaskStateConflict,
  TaskNotClaimable,
  TaskCycle,
  NeedUnavailable,
  TaskLimitReached,
  RateLimited,
  InvitationLimited,
  FeedbackLimited,
  TooLarge,
  InternalError,
  Unavailable,
] as const;
/** Public failure decoder used at protocol boundaries. */
export const Failure = Schema.Union(failures);
/** Parsed protocol failure. */
export type Failure = typeof Failure.Type;
/** Stable public error code. */
export type FailureCode = Failure["error"]["code"];
/** The code of an error with no fields beyond its code and message. */
type Simple<E> = E extends { readonly code: infer C; readonly message: string }
  ? [Exclude<keyof E, "code" | "message">] extends [never]
    ? C
    : never
  : never;
/** Errors without structured fields (recovery, task state). */
export type SimpleFailureCode = Simple<Failure["error"]>;
/** Construct a public failure without exposing implementation errors. */
export const makeFailure = <const C extends SimpleFailureCode>(
  code: C,
  message: string,
  meta: Meta,
) => ({
  error: { code, message },
  meta,
});
