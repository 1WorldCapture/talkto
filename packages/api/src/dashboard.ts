import { DateTime, Schema } from "effect";
import * as M from "./models.js";
import * as I from "./inputs.js";

/** Dashboard feeds keep their row budget independent of directory page sizes. */
export const FeedLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));
/** Both bounds describe the same (start, end] interval used by timeline bars. */
export const feedWindowCheck = Schema.makeFilter(
  (value: { readonly start?: M.Timestamp | undefined; readonly end?: M.Timestamp | undefined }) =>
    (value.start === undefined && value.end === undefined) ||
    (value.start !== undefined && value.end !== undefined && value.start < value.end),
  { message: "Provide both start and end, with start earlier than end." },
);
/** A selected interval excludes its start and includes its end. */
export const FeedWindow = Schema.Struct({ start: M.Timestamp, end: M.Timestamp }).check(
  feedWindowCheck,
);
/** Parsed time selection. */
export type FeedWindow = typeof FeedWindow.Type;
/** Initial feed selection or an opaque continuation retaining the original scope. */
export const FeedInput = Schema.Union([
  Schema.Struct({
    query: Schema.optionalKey(I.SearchQuery),
    conversationId: Schema.optionalKey(M.ConversationId),
    limit: Schema.optionalKey(FeedLimit),
    start: Schema.optionalKey(M.Timestamp),
    end: Schema.optionalKey(M.Timestamp),
    /** Open history at this message sequence, with up to half a page of newer context. */
    around: Schema.optionalKey(M.Count),
  }).check(feedWindowCheck),
  Schema.Struct({ cursor: M.Cursor, limit: Schema.optionalKey(FeedLimit) }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed feed selection. */
export type FeedInput = typeof FeedInput.Type;
/** Full messages; history is descending and forward delivery is ascending.
 * A first page opened `around` an older message is not caught up until its live cursor is followed. */
export const Feed = Schema.Struct({
  items: Schema.Array(M.Message),
  nextCursor: Schema.NullOr(M.Cursor),
  liveCursor: M.Cursor,
  caughtUp: Schema.Boolean,
  /** Where this server's stored history begins, once an older page reaches it. */
  history: Schema.optionalKey(M.HistoryLimit),
});
/** Parsed server feed. */
export interface Feed extends Schema.Schema.Type<typeof Feed> {}
/** Counts refer to (windowStart, windowEnd], using the server clock. */
export const Activity = Schema.Struct({
  windowStart: M.Timestamp,
  windowEnd: M.Timestamp,
  messageCount: M.Count,
  lastMessageAt: Schema.NullOr(M.Timestamp),
});
/** Parsed rolling activity. */
export interface Activity extends Schema.Schema.Type<typeof Activity> {}
/** One bounded server card; totals remain authoritative even when samples are truncated. */
export const Summary = Schema.Struct({
  server: M.Server,
  participants: Schema.Array(M.Participant),
  channels: Schema.Array(M.Channel),
  activity: Activity,
});
/** Parsed server summary. */
export interface Summary extends Schema.Schema.Type<typeof Summary> {}

/** Preset windows keep activity aggregation and response size bounded. */
export const TimelineRange = Schema.Literals(["hour", "day", "week"]);
/** Optional window; the default is the last 24 hours. */
export const TimelineInput = Schema.Struct({
  range: Schema.optionalKey(TimelineRange),
  at: Schema.optionalKey(M.Timestamp),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
/** Parsed timeline request. */
export type TimelineInput = typeof TimelineInput.Type;
/** One interval contains sent messages, not polling or participant presence. */
export const TimelineBucket = Schema.Struct({
  start: M.Timestamp,
  end: M.Timestamp,
  messageCount: M.Count,
  participantCount: M.Count,
});
/** Message contributors, ranked within the selected window. */
export const TimelineSender = Schema.Struct({
  id: M.ParticipantId,
  name: M.Name,
  agentType: M.AgentType,
  messageCount: M.Count,
});
/** Sender lists use the same bounded interval as the chart, at most seven days. */
export const TimelineSendersWindow = FeedWindow.check(
  Schema.makeFilter(
    ({ start, end }) =>
      DateTime.toEpochMillis(DateTime.makeUnsafe(end)) -
        DateTime.toEpochMillis(DateTime.makeUnsafe(start)) <=
      604_800_000,
    { message: "The activity window cannot exceed seven days." },
  ),
);
/** Continue the original sender ranking without changing its window. */
export const TimelineSendersInput = Schema.Union([
  TimelineSendersWindow,
  Schema.Struct({ cursor: M.Cursor }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed sender list request. */
export type TimelineSendersInput = typeof TimelineSendersInput.Type;
/** At most fifty ranked agents per page. */
export const TimelineSenders = M.page(TimelineSender);
/** Parsed ranked sender page. */
export type TimelineSenders = typeof TimelineSenders.Type;
/** Complete server-wide counts for (windowStart, windowEnd], independent of feed pagination. */
export const Timeline = Schema.Struct({
  windowStart: M.Timestamp,
  windowEnd: M.Timestamp,
  bucketMillis: Schema.Int.check(Schema.isGreaterThan(0)),
  messageCount: M.Count,
  participantCount: M.Count,
  firstMessageAt: Schema.NullOr(M.Timestamp),
  lastMessageAt: Schema.NullOr(M.Timestamp),
  buckets: Schema.Array(TimelineBucket),
  senders: Schema.Array(TimelineSender),
});
/** Parsed activity timeline. */
export interface Timeline extends Schema.Schema.Type<typeof Timeline> {}

/** At most fifty stored files per page; the dashboard asks for 25. */
export const TransferLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));
/** A first page, newest first, or an opaque continuation of the same listing. */
export const ListTransfers = Schema.Union([
  Schema.Struct({ limit: Schema.optionalKey(TransferLimit) }),
  Schema.Struct({ cursor: M.Cursor, limit: Schema.optionalKey(TransferLimit) }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed transfer listing request. */
export type ListTransfers = typeof ListTransfers.Type;
/**
 * Where a stored file stands for a person: `available` to download, `expired` after its 30 days
 * (the bytes are gone), or `incomplete` when the sender prepared it but never sent the offer.
 */
export const TransferState = Schema.Literals(["available", "expired", "incomplete"]);
/** Parsed transfer state. */
export type TransferState = typeof TransferState.Type;
/**
 * One file or folder an agent sent on the server, from the server's own transfer ledger. The
 * conversation and message are null for an incomplete transfer, which was never posted, and when
 * the offer's message is no longer kept. Names come from `included`.
 */
export const ServerTransfer = Schema.Struct({
  id: M.TransferId,
  name: M.TransferName,
  kind: M.TransferKind,
  /** Size of the file, or of the packed folder. */
  bytes: M.TransferBytes,
  /** Files in a folder; null for a single file. */
  fileCount: Schema.NullOr(M.Count),
  senderId: M.ParticipantId,
  conversationId: Schema.NullOr(M.ConversationId),
  messageId: Schema.NullOr(M.MessageId),
  /** The offer message's sequence, for opening the conversation at that message. */
  messageSequence: Schema.NullOr(M.Count),
  createdAt: M.Timestamp,
  expiresAt: M.Timestamp,
  state: TransferState,
}).annotate({ identifier: "ServerTransfer" });
/** Parsed stored transfer. */
export interface ServerTransfer extends Schema.Schema.Type<typeof ServerTransfer> {}
/** Stored transfers, newest first. */
export const ServerTransfers = M.page(ServerTransfer);
/** Parsed transfer page. */
export type ServerTransfers = typeof ServerTransfers.Type;
/**
 * A short-lived link that downloads one available transfer as an attachment named `fileName`.
 * A folder downloads as the gzip-compressed tar archive the sender packed.
 */
export const TransferDownload = Schema.Struct({
  url: Schema.String,
  urlExpiresAt: M.Timestamp,
  fileName: Schema.String,
});
/** Parsed person download link. */
export interface TransferDownload extends Schema.Schema.Type<typeof TransferDownload> {}
