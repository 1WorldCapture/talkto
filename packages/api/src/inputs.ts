import { Schema } from "effect";
import * as M from "./models.js";

const strict = { onExcessProperty: "error" } as const;
/** Registration request. Optional context is omitted, never explicitly null. */
export const RegisterParticipant = Schema.Struct({
  requestKey: M.RequestKey,
  name: M.Name,
  agentType: M.AgentType,
  workingDirectory: Schema.optionalKey(M.WorkingDirectory),
  joinedNote: Schema.optionalKey(M.JoinedNote),
}).annotate({ parseOptions: strict });
/** Parsed registration. */
export interface RegisterParticipant extends Schema.Schema.Type<typeof RegisterParticipant> {}
/** Creation of a named channel by a registered participant. */
export const CreateChannel = Schema.Struct({
  participantId: M.ParticipantId,
  requestKey: M.RequestKey,
  name: M.Name,
  description: Schema.optionalKey(M.ChannelDescription),
}).annotate({ parseOptions: strict });
/** Parsed channel creation. */
export interface CreateChannel extends Schema.Schema.Type<typeof CreateChannel> {}
/** Revision-checked channel state change. */
export const SetChannelArchived = Schema.Struct({
  participantId: M.ParticipantId,
  archived: Schema.Boolean,
  expectedRevision: M.Count,
}).annotate({ parseOptions: strict });
/** Parsed archive or reopen request. */
export interface SetChannelArchived extends Schema.Schema.Type<typeof SetChannelArchived> {}
/** Opening a direct chat is naturally idempotent by its participant pair. */
export const OpenDirectConversation = Schema.Struct({
  participantId: M.ParticipantId,
  recipientId: M.ParticipantId,
}).annotate({ parseOptions: strict });
/** Parsed direct-chat request. */
export interface OpenDirectConversation extends Schema.Schema.Type<typeof OpenDirectConversation> {}
/** Message attribution, body, retry identity, and optional delivery priority (default normal). */
export const SendMessage = Schema.Struct({
  participantId: M.ParticipantId,
  requestKey: M.RequestKey,
  body: M.MessageBody,
  priority: Schema.optionalKey(M.Priority),
}).annotate({ parseOptions: strict });
/** Parsed send request. */
export interface SendMessage extends Schema.Schema.Type<typeof SendMessage> {}
/**
 * A signed-in person opens, or reopens, their direct chat with one agent. The sender is always the
 * caller's own person participant, derived from the sign-in; no request names it.
 */
export const OpenPersonDirectChat = Schema.Struct({
  agentId: M.ParticipantId,
  requestKey: M.RequestKey,
}).annotate({ parseOptions: strict });
/** Parsed person direct-chat request. */
export interface OpenPersonDirectChat extends Schema.Schema.Type<typeof OpenPersonDirectChat> {}
/**
 * A signed-in person sends into their own direct chat with an agent, or into a channel. Priority
 * defaults to normal; urgent is for direct chats only.
 */
export const SendPersonMessage = Schema.Struct({
  conversationId: M.ConversationId,
  requestKey: M.RequestKey,
  body: M.MessageBody,
  priority: Schema.optionalKey(M.Priority),
}).annotate({ parseOptions: strict });
/** Parsed person send. */
export interface SendPersonMessage extends Schema.Schema.Type<typeof SendPersonMessage> {}
/** History anchor. All explicit boundaries exclude their anchor. */
export const Position = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("latest") }),
  Schema.Struct({ kind: Schema.Literal("beforeMessage"), messageId: M.MessageId }),
  Schema.Struct({ kind: Schema.Literal("afterMessage"), messageId: M.MessageId }),
  Schema.Struct({ kind: Schema.Literal("beforeTime"), time: M.TimestampInput }),
  Schema.Struct({ kind: Schema.Literal("afterTime"), time: M.TimestampInput }),
  Schema.Struct({ kind: Schema.Literal("cursor"), cursor: M.Cursor }),
]).annotate({ parseOptions: strict });
/** Parsed history anchor. */
export type Position = typeof Position.Type;
const limit = Schema.optionalKey(M.Limit);
/** Bounded literal substring for directory names and context. */
export const DirectoryQuery = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const continuation = Schema.Struct({ cursor: M.Cursor, limit });
/**
 * Which participants a listing returns: `active` (the default) leaves out agents a person removed,
 * `removed` returns only those, `all` both. An exact `name` lookup defaults to `all`, so a removed
 * agent recovering its identity learns that it was removed.
 */
export const ParticipantState = Schema.Literals(["active", "removed", "all"]);
/** Parsed participant state filter. */
export type ParticipantState = typeof ParticipantState.Type;
/** Exact name filter or continuation; filters cannot change midway through a traversal. */
export const ListParticipants = Schema.Union([
  Schema.Struct({
    name: Schema.optionalKey(M.Name),
    query: Schema.optionalKey(DirectoryQuery),
    state: Schema.optionalKey(ParticipantState),
    limit,
  }),
  continuation,
]).annotate({ parseOptions: strict });
/** Parsed participant listing. */
export type ListParticipants = typeof ListParticipants.Type;
/** Channel lifecycle filter. */
export const ChannelState = Schema.Literals(["active", "archived", "all"]);
/** Channel listing or continuation. */
export const ListChannels = Schema.Union([
  Schema.Struct({
    state: Schema.optionalKey(ChannelState),
    query: Schema.optionalKey(DirectoryQuery),
    limit,
  }),
  continuation,
]).annotate({ parseOptions: strict });
/** Parsed channel listing. */
export type ListChannels = typeof ListChannels.Type;
/** Optional participant filter provides the own-chats view. */
export const ListDirectConversations = Schema.Union([
  Schema.Struct({ withParticipantId: Schema.optionalKey(M.ParticipantId), limit }),
  continuation,
]).annotate({ parseOptions: strict });
/** Parsed direct-chat listing. */
export type ListDirectConversations = typeof ListDirectConversations.Type;
/** Newest-first file share listing or its continuation. */
export const ListShares = Schema.Union([Schema.Struct({ limit }), continuation]).annotate({
  parseOptions: strict,
});
/** Parsed share listing. */
export type ListShares = typeof ListShares.Type;
/** Bounded history retrieval. */
export const ReadMessages = Schema.Struct({
  position: Schema.optionalKey(Position),
  limit,
}).annotate({ parseOptions: strict });
/** Parsed history request. */
export interface ReadMessages extends Schema.Schema.Type<typeof ReadMessages> {}
/** Literal search text; the service interprets terms without exposing FTS syntax. */
export const SearchQuery = Schema.Trim.check(
  Schema.makeFilter(
    (s) =>
      s.isWellFormed() &&
      !s.includes("\0") &&
      s.length > 0 &&
      new TextEncoder().encode(s).length <= 256,
  ),
);
/** Search filters or a continuation retaining the original filters. */
export const SearchMessages = Schema.Union([
  Schema.Struct({
    query: SearchQuery,
    conversationId: Schema.optionalKey(M.ConversationId),
    senderId: Schema.optionalKey(M.ParticipantId),
    afterTime: Schema.optionalKey(M.TimestampInput),
    beforeTime: Schema.optionalKey(M.TimestampInput),
    limit,
  }),
  continuation,
]).annotate({ parseOptions: strict });
/** Parsed search request. */
export type SearchMessages = typeof SearchMessages.Type;
/** Number of neighbors on each side of a context anchor. */
export const GetMessageContext = Schema.Struct({
  before: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 }))),
  after: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 }))),
}).annotate({ parseOptions: strict });
/** Parsed context request. */
export interface GetMessageContext extends Schema.Schema.Type<typeof GetMessageContext> {}
