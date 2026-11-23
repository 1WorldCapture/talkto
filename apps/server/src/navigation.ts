import { Effect, Encoding, Schema, Result } from "effect";
import * as M from "@talkto/api/models";
import * as I from "@talkto/api/inputs";
import * as U from "@talkto/api/updates";
import * as D from "@talkto/api/dashboard";
import { InvalidCursor, InvalidSearch } from "@talkto/api/errors";

const scope = { version: Schema.Literal(1), serverId: M.ServerId };
/** Opaque directory traversal with immutable sort keys and original filters. */
export const DirectoryCursor = Schema.Union([
  Schema.Struct({
    ...scope,
    kind: Schema.Literal("participants"),
    name: Schema.NullOr(M.Name),
    query: Schema.optionalKey(Schema.String),
    state: Schema.optionalKey(I.ParticipantState),
    after: M.Name,
  }),
  Schema.Struct({
    ...scope,
    kind: Schema.Literal("channels"),
    state: I.ChannelState,
    query: Schema.optionalKey(Schema.String),
    after: M.Name,
  }),
  Schema.Struct({
    ...scope,
    kind: Schema.Literal("directs"),
    withParticipantId: Schema.NullOr(M.ParticipantId),
    after: M.ConversationId,
  }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed directory cursor variants. */
export type DirectoryCursor = typeof DirectoryCursor.Type;
/** Stable append-only history or search traversal; no database-side cursor state. */
export const MessageCursor = Schema.Struct({
  ...scope,
  kind: Schema.Literals(["history", "search", "feed", "shares"]),
  conversationId: Schema.NullOr(M.ConversationId),
  senderId: Schema.NullOr(M.ParticipantId),
  afterTime: Schema.NullOr(M.Timestamp),
  beforeTime: Schema.NullOr(M.Timestamp),
  boundary: M.Count,
  ceiling: M.Count,
  direction: Schema.Literals(["older", "newer"]),
  query: Schema.NullOr(I.SearchQuery),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed stable message cursor. */
export interface MessageCursor extends Schema.Schema.Type<typeof MessageCursor> {}
/** Stable sender counts and tie ordering within one authorized server and time window. */
export const TimelineSendersCursor = Schema.Struct({
  ...scope,
  kind: Schema.Literal("timeline_senders"),
  window: D.TimelineSendersWindow,
  ceiling: M.Count,
  after: Schema.Struct({ id: M.ParticipantId, messageCount: M.Count }),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed sender ranking continuation. */
export type TimelineSendersCursor = typeof TimelineSendersCursor.Type;
/** Newest-first transfer listing: the last row's expiry and ID on this server. */
export const TransferCursor = Schema.Struct({
  ...scope,
  kind: Schema.Literal("transfers"),
  expiresAt: M.Timestamp,
  id: M.TransferId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed transfer listing continuation. */
export interface TransferCursor extends Schema.Schema.Type<typeof TransferCursor> {}
const updatesScope = {
  ...scope,
  generation: U.Generation,
  participantId: M.ParticipantId,
  selection: U.Selection,
  boundary: M.Count,
};
/** Distinct durable checkpoint and fixed-snapshot continuation variants. */
export const UpdatesCursor = Schema.Union([
  Schema.Struct({ ...updatesScope, kind: Schema.Literal("updates_checkpoint") }),
  Schema.Struct({ ...updatesScope, kind: Schema.Literal("updates_page"), ceiling: M.Count }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed updates recovery state, never an authorization credential. */
export type UpdatesCursor = typeof UpdatesCursor.Type;
/** A position in a server's history archive: inside one archive object, after a sequence. */
export const ArchiveCursor = Schema.Struct({
  ...scope,
  kind: Schema.Literal("archive"),
  key: Schema.String.check(Schema.isMaxLength(256)),
  after: M.Count,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed archive continuation. */
export type ArchiveCursor = typeof ArchiveCursor.Type;
/**
 * What one feed page reads, for its weight (`reads.ts`): `search` scans the search index, `window`
 * every message in a time window (a timeline selection, read through the creation-time index and
 * sorted), and `page` at most one page of rows walked in order on the primary key or the
 * conversation index, like a history page: the first page, older pages, the live check and one
 * conversation's pages. A continuation keeps its first page's search and window. Only weighs the
 * read; the feed still validates the cursor before reading anything, so a cursor that does not
 * decode reads nothing and weighs as a page.
 */
export const feedReach = (input: D.FeedInput): "page" | "search" | "window" => {
  if (!("cursor" in input))
    return input.query !== undefined ? "search" : input.start !== undefined ? "window" : "page";
  const decoded = Encoding.decodeBase64UrlString(input.cursor);
  if (Result.isFailure(decoded)) return "page";
  const state = Schema.decodeUnknownResult(Schema.fromJsonString(MessageCursor))(decoded.success);
  if (Result.isFailure(state)) return "page";
  return state.success.query !== null
    ? "search"
    : state.success.afterTime !== null || state.success.beforeTime !== null
      ? "window"
      : "page";
};
/** Serialize a trusted cursor using base64url UTF-8, never credentials. */
export const encodeCursor = (
  value:
    | DirectoryCursor
    | MessageCursor
    | UpdatesCursor
    | TimelineSendersCursor
    | TransferCursor
    | ArchiveCursor,
): M.Cursor => M.Cursor.make(Encoding.encodeBase64Url(JSON.stringify(value)));
/** Parse and bind a cursor to the current authorized server. */
export const parseCursor = Effect.fn("Navigation.parseCursor")(function* <
  S extends Schema.ConstraintDecoder<unknown>,
>(schema: S, token: M.Cursor): Effect.fn.Return<S["Type"], InvalidCursor, S["DecodingServices"]> {
  const decoded = Encoding.decodeBase64UrlString(token);
  if (Result.isFailure(decoded))
    return yield* new InvalidCursor({ message: "The continuation token is malformed." });
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(decoded.success).pipe(
    Effect.mapError(
      () =>
        new InvalidCursor({ message: "The continuation token has an invalid shape or version." }),
    ),
  );
});
/** Compile literal AND terms, without accepting user-authored FTS operators. */
export const searchExpression = Effect.fn("Navigation.searchExpression")(function* (query: string) {
  const terms = query.trim().split(/\s+/u);
  if (terms.length > 16 || terms.some((term) => !/[\p{L}\p{N}]/u.test(term))) {
    return yield* new InvalidSearch({
      message: "Use 1–16 search terms, each containing a letter or number.",
    });
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
});
/** Select whole messages within the shared response body budget. */
export function boundedMessages(
  messages: ReadonlyArray<M.Message>,
  limit: number,
  budget = 65536,
): ReadonlyArray<M.Message> {
  const selected: M.Message[] = [];
  let bytes = 0;
  for (const message of messages) {
    const size = new TextEncoder().encode(message.body).length;
    if (selected.length >= limit || bytes + size > budget) break;
    bytes += size;
    selected.push(message);
  }
  return selected;
}
