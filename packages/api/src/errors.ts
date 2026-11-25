import { Schema } from "effect";
import * as Metering from "./metering.js";
import * as M from "./models.js";

/** Sending is paused for a confirmed workspace billing reason; history and identity remain available. */
export class MessageAllowanceExhausted extends Schema.TaggedError<MessageAllowanceExhausted>()(
  "MessageAllowanceExhausted",
  {
    message: Schema.String,
    ...Metering.Recovery.fields,
  },
) {}
/** No current paid period has supplied message capacity. */
export class MessagePaymentRequired extends Schema.TaggedError<MessagePaymentRequired>()(
  "MessagePaymentRequired",
  {
    message: Schema.String,
    ...Metering.Recovery.fields,
  },
) {}
/** Coordination or outstanding capacity must recover before another new send. */
export class SendingUnavailable extends Schema.TaggedError<SendingUnavailable>()(
  "SendingUnavailable",
  {
    message: Schema.String,
    operation: Schema.String,
    ...Metering.Recovery.fields,
  },
) {}

/** The supplied input is invalid. */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  message: Schema.String,
}) {}

/** The server is unavailable. */
export class ServerAccessDenied extends Schema.TaggedError<ServerAccessDenied>()(
  "ServerAccessDenied",
  { message: Schema.String },
) {}

/** The participant does not exist. */
export class ParticipantNotFound extends Schema.TaggedError<ParticipantNotFound>()(
  "ParticipantNotFound",
  { message: Schema.String },
) {}

/** The conversation does not exist. */
export class ConversationNotFound extends Schema.TaggedError<ConversationNotFound>()(
  "ConversationNotFound",
  { message: Schema.String },
) {}

/** The message does not exist in the requested scope. */
export class MessageNotFound extends Schema.TaggedError<MessageNotFound>()("MessageNotFound", {
  message: Schema.String,
}) {}

/** That name is already registered. */
export class NameTaken extends Schema.TaggedError<NameTaken>()("NameTaken", {
  message: Schema.String,
}) {}

/** The request key was previously used with different input. */
export class IdempotencyConflict extends Schema.TaggedError<IdempotencyConflict>()(
  "IdempotencyConflict",
  { message: Schema.String },
) {}

/** The continuation token is invalid for this request. */
export class InvalidCursor extends Schema.TaggedError<InvalidCursor>()("InvalidCursor", {
  message: Schema.String,
}) {}

/** The search query or filters are invalid. */
export class InvalidSearch extends Schema.TaggedError<InvalidSearch>()("InvalidSearch", {
  message: Schema.String,
}) {}

/** A direct chat requires two different participants. */
export class SelfConversation extends Schema.TaggedError<SelfConversation>()("SelfConversation", {
  message: Schema.String,
}) {}

/** This operation requires a channel. */
export class WrongConversationKind extends Schema.TaggedError<WrongConversationKind>()(
  "WrongConversationKind",
  { message: Schema.String },
) {}

/** General cannot be archived. */
export class ProtectedGeneral extends Schema.TaggedError<ProtectedGeneral>()("ProtectedGeneral", {
  message: Schema.String,
}) {}

/** The channel revision has changed. Read it and try again. */
export class RevisionConflict extends Schema.TaggedError<RevisionConflict>()("RevisionConflict", {
  message: Schema.String,
}) {}

/** The channel is archived. */
export class ChannelArchived extends Schema.TaggedError<ChannelArchived>()("ChannelArchived", {
  message: Schema.String,
}) {}

/** Only the two participants can send into a direct chat. */
export class NotConversationParticipant extends Schema.TaggedError<NotConversationParticipant>()(
  "NotConversationParticipant",
  { message: Schema.String },
) {}

/** Expected storage availability failure, with safe operation context. */
export class StorageUnavailable extends Schema.TaggedError<StorageUnavailable>()(
  "StorageUnavailable",
  { message: Schema.String, operation: Schema.String },
) {}

/** File sharing is absent on this deployment, or its store did not complete the operation. Never carries a token. */
export class FilesUnavailable extends Schema.TaggedError<FilesUnavailable>()("FilesUnavailable", {
  message: Schema.String,
  operation: Schema.String,
  reason: Schema.Literals(["absent", "failed"]),
}) {}

/**
 * Swarm memory is off because the server's board is off (`off`), absent on this deployment
 * (`absent`), or its Git store did not complete the operation or memory is not set up yet
 * (`failed`). Never carries a token.
 */
export class MemoryUnavailable extends Schema.TaggedError<MemoryUnavailable>()(
  "MemoryUnavailable",
  {
    message: Schema.String,
    operation: Schema.String,
    reason: Schema.Literals(["off", "absent", "failed"]),
  },
) {}

/** A person's participant never acts in an agent operation, and a person's chat needs an agent. */
export class NotAnAgent extends Schema.TaggedError<NotAnAgent>()("NotAnAgent", {
  message: Schema.String,
}) {}

/**
 * An agent may rename only a registration made through its own person's access; TalkTo cannot tell
 * one of that person's agents from another, so any of them may rename the others.
 */
export class RenameNotAllowed extends Schema.TaggedError<RenameNotAllowed>()("RenameNotAllowed", {
  message: Schema.String,
}) {}

/**
 * An agent operation named an agent registered through another person's access. Agents act only
 * as agents their own person registered; TalkTo cannot tell that person's agents apart, so any of
 * them may act as the others, but never as another person's agents.
 */
export class AgentNotOwned extends Schema.TaggedError<AgentNotOwned>()("AgentNotOwned", {
  message: Schema.String,
}) {}

/**
 * A person removed this agent from the server on the dashboard. Every agent operation that names
 * its participant ID is refused until a person restores it; its messages stay in history.
 */
export class ParticipantRemoved extends Schema.TaggedError<ParticipantRemoved>()(
  "ParticipantRemoved",
  { message: Schema.String },
) {}

/** No completed transfer with this ID exists on this server, or the caller did not start it. */
export class TransferNotFound extends Schema.TaggedError<TransferNotFound>()("TransferNotFound", {
  message: Schema.String,
}) {}
/** The transfer passed its retention date; the sender must send it again. */
export class TransferExpired extends Schema.TaggedError<TransferExpired>()("TransferExpired", {
  message: Schema.String,
}) {}
/** The upload is missing or does not match the size declared when it was prepared. */
export class TransferNotUploaded extends Schema.TaggedError<TransferNotUploaded>()(
  "TransferNotUploaded",
  { message: Schema.String },
) {}
/**
 * The organization's stored-file pool cannot hold this send. Every server the organization owns
 * shares the pool, and a reservation counts until it expires, so retrying now cannot succeed.
 */
export class StoragePoolFull extends Schema.TaggedError<StoragePoolFull>()("StoragePoolFull", {
  message: Schema.String,
  ...Metering.StoragePoolRecovery.fields,
}) {}
/** Too many reads or polls arrived too quickly; retrying after the delay is safe. */
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  message: Schema.String,
  ...Metering.RateLimitRecovery.fields,
}) {}

/** This server has no board, or its board is switched off. Nothing changed. */
export class BoardOff extends Schema.TaggedError<BoardOff>()("BoardOff", {
  message: Schema.String,
}) {}
/** No task with this ID or number exists on this server. */
export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()("TaskNotFound", {
  message: Schema.String,
}) {}
/**
 * The caller no longer holds the task: its lease ran out, a person canceled or released it, or
 * another claim took it. `state` and `epoch` are the task's now; nothing changed.
 */
export class ClaimLost extends Schema.TaggedError<ClaimLost>()("ClaimLost", {
  message: Schema.String,
  state: Schema.String,
  epoch: Schema.Int,
  holderId: Schema.optionalKey(M.ParticipantId),
}) {}
/** The task's state does not allow this; `state` is its state now. */
export class TaskStateConflict extends Schema.TaggedError<TaskStateConflict>()(
  "TaskStateConflict",
  { message: Schema.String, state: Schema.String },
) {}
/**
 * The task cannot be claimed by this agent now. `reason`: assigned_to_other, held_by_other,
 * waiting_on_needs or holding_too_many.
 */
export class TaskNotClaimable extends Schema.TaggedError<TaskNotClaimable>()("TaskNotClaimable", {
  message: Schema.String,
  reason: Schema.String,
  holderId: Schema.optionalKey(M.ParticipantId),
  expiresAt: Schema.optionalKey(M.Timestamp),
}) {}
/** The tasks of one call need each other in a cycle; `refs` names the tasks in it. */
export class TaskCycle extends Schema.TaggedError<TaskCycle>()("TaskCycle", {
  message: Schema.String,
  refs: Schema.Array(Schema.String),
}) {}
/** A need names no task on this server, or a task that failed or was canceled. */
export class NeedUnavailable extends Schema.TaggedError<NeedUnavailable>()("NeedUnavailable", {
  message: Schema.String,
  taskId: Schema.String,
  state: Schema.optionalKey(Schema.String),
}) {}
/** The server holds as many unfinished tasks as it may. */
export class TaskLimitReached extends Schema.TaggedError<TaskLimitReached>()("TaskLimitReached", {
  message: Schema.String,
  limit: Schema.Int,
}) {}

/**
 * The caller may not do this here: a person-only action from an agent or token, a change only
 * the server's creator may make, or archiving the board channel. Projects to `forbidden`.
 */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.String,
}) {}

/** Known failure union used only at protocol and runtime boundaries. */
export type Failure =
  | MessageAllowanceExhausted
  | MessagePaymentRequired
  | SendingUnavailable
  | InvalidInput
  | ServerAccessDenied
  | ParticipantNotFound
  | ConversationNotFound
  | MessageNotFound
  | NameTaken
  | IdempotencyConflict
  | InvalidCursor
  | InvalidSearch
  | SelfConversation
  | WrongConversationKind
  | ProtectedGeneral
  | RevisionConflict
  | ChannelArchived
  | NotConversationParticipant
  | StorageUnavailable
  | FilesUnavailable
  | MemoryUnavailable
  | NotAnAgent
  | RenameNotAllowed
  | AgentNotOwned
  | ParticipantRemoved
  | TransferNotFound
  | TransferExpired
  | TransferNotUploaded
  | StoragePoolFull
  | RateLimited
  | BoardOff
  | TaskNotFound
  | ClaimLost
  | TaskStateConflict
  | TaskNotClaimable
  | TaskCycle
  | NeedUnavailable
  | TaskLimitReached
  | Forbidden;
