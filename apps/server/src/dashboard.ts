import { DateTime, Effect } from "effect";
import * as D from "@talkto/api/dashboard";
import * as M from "@talkto/api/models";
import * as E from "@talkto/api/errors";
import * as Navigation from "./navigation.js";
import * as History from "./history/model.js";
import type * as Store from "./persistence.js";

/** Build a server card from one authorized transaction and one clock reading. */
export const summary = Effect.fn("Dashboard.summary")(function* (tx: Store.Session, at: number) {
  const windowStart = M.Timestamp.make(
    DateTime.formatIso(DateTime.makeUnsafe(Math.max(0, at - 1800000))),
  );
  const windowEnd = M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(at)));
  return D.Summary.make({
    server: yield* tx.server(),
    participants: yield* tx.recentParticipants(12),
    channels: yield* tx.channels("active", null, 3),
    activity: {
      windowStart,
      windowEnd,
      messageCount: yield* tx.activityCount(windowStart, windowEnd),
      lastMessageAt: (yield* tx.latestMessage())?.createdAt ?? null,
    },
  });
});

/** Stable history snapshots and forward catch-up share the server's immutable sequence. */
export const feed = Effect.fn("Dashboard.feed")(function* (
  tx: Store.Session,
  serverId: M.ServerId,
  input: D.FeedInput,
) {
  const head = (yield* tx.latestMessage())?.sequence ?? 0;
  let state: Navigation.MessageCursor;
  if ("cursor" in input) {
    state = yield* Navigation.parseCursor(Navigation.MessageCursor, input.cursor);
    if (
      state.kind !== "feed" ||
      state.serverId !== serverId ||
      state.ceiling > head ||
      state.boundary > state.ceiling ||
      state.senderId !== null ||
      (state.afterTime === null) !== (state.beforeTime === null) ||
      (state.afterTime !== null && state.beforeTime !== null && state.afterTime >= state.beforeTime)
    )
      return yield* new E.InvalidCursor({
        message: "The feed continuation does not match this server.",
      });
    if (state.direction === "newer") state = { ...state, ceiling: head };
  } else {
    state = {
      version: 1,
      serverId,
      kind: "feed",
      conversationId: input.conversationId ?? null,
      senderId: null,
      afterTime: input.start ?? null,
      beforeTime: input.end ?? null,
      boundary: head + 1,
      ceiling: head,
      direction: "older",
      query: input.query ?? null,
    };
  }
  if (state.conversationId !== null && (yield* tx.conversation(state.conversationId)) === null)
    return yield* new E.ConversationNotFound({
      message: "The conversation does not exist in this server.",
    });
  const search = state.query === null ? null : yield* Navigation.searchExpression(state.query);
  const limit = input.limit ?? 50;
  const around = "cursor" in input ? undefined : input.around;
  const context = Math.floor(limit / 2);
  if (around !== undefined && around < head && context > 0) {
    // The selected message lands inside its page, after up to half a page of newer context.
    const newer = yield* tx.messages({
      ...state,
      direction: "newer",
      boundary: around,
      beforeTime: null,
      throughTime: state.beforeTime,
      search,
      limit: context,
    });
    const ceiling = newer.length < context ? head : (newer.at(-1)?.sequence ?? head);
    state = { ...state, boundary: ceiling + 1, ceiling };
  }
  const rows = yield* tx.messages({
    ...state,
    beforeTime: null,
    throughTime: state.beforeTime,
    search,
    limit: limit + 1,
  });
  const items = Navigation.boundedMessages(rows, limit);
  const more = rows.length > items.length;
  const boundary = items.at(-1)?.sequence ?? state.boundary;
  const nextCursor = more ? Navigation.encodeCursor({ ...state, boundary }) : null;
  const liveBoundary = state.direction === "newer" && more ? boundary : state.ceiling;
  // An older page that found nothing more reached where this server's stored history begins.
  const start = state.direction === "older" && !more ? yield* tx.historyLimit() : null;
  const page = {
    items,
    nextCursor,
    liveCursor: Navigation.encodeCursor({ ...state, direction: "newer", boundary: liveBoundary }),
    caughtUp: state.direction === "older" ? "cursor" in input || state.ceiling === head : !more,
  };
  return D.Feed.make(start === null ? page : { ...page, history: History.describe(start) });
});

/** Aggregate only the selected indexed time range; never fetch message bodies for a chart. */
export const timeline = Effect.fn("Dashboard.timeline")(function* (
  tx: Store.Session,
  input: D.TimelineInput,
  at: number,
) {
  const range = input.range ?? "day";
  const end = input.at === undefined ? at : DateTime.toEpochMillis(DateTime.makeUnsafe(input.at));
  const duration = range === "hour" ? 3_600_000 : range === "day" ? 86_400_000 : 604_800_000;
  const bucketMillis = range === "hour" ? 60_000 : range === "day" ? 900_000 : 3_600_000;
  const start = Math.max(0, end - duration);
  const stamp = (ms: number) => M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(ms)));
  const windowStart = stamp(start);
  const windowEnd = stamp(end);
  const counts = yield* tx.activityBuckets(windowStart, windowEnd, bucketMillis);
  const indexed = new Map(counts.map((row) => [row.bucket, row]));
  const totals = yield* tx.activityTotals(windowStart, windowEnd);
  const senders = yield* tx.activitySenders(windowStart, windowEnd, { limit: 6 });
  return D.Timeline.make({
    windowStart,
    windowEnd,
    bucketMillis,
    ...totals,
    senders,
    buckets: Array.from({ length: Math.ceil((end - start) / bucketMillis) }, (_, i) => ({
      start: stamp(start + i * bucketMillis),
      end: stamp(Math.min(end, start + (i + 1) * bucketMillis)),
      messageCount: indexed.get(i)?.messageCount ?? 0,
      participantCount: indexed.get(i)?.participantCount ?? 0,
    })),
  });
});

/** Page ranked senders against a fixed message sequence so arrivals cannot reorder later pages. */
export const timelineSenders = Effect.fn("Dashboard.timelineSenders")(function* (
  tx: Store.Session,
  serverId: M.ServerId,
  input: D.TimelineSendersInput,
) {
  const head = (yield* tx.latestMessage())?.sequence ?? 0;
  const selection =
    "cursor" in input
      ? yield* Navigation.parseCursor(Navigation.TimelineSendersCursor, input.cursor)
      : { serverId, window: input, ceiling: head, after: undefined };
  if (selection.serverId !== serverId || selection.ceiling > head)
    return yield* new E.InvalidCursor({
      message: "The sender continuation does not match this server.",
    });
  const { window, ceiling, after } = selection;
  const limit = 50;
  const rows = yield* tx.activitySenders(window.start, window.end, {
    limit: limit + 1,
    ceiling,
    after,
  });
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return D.TimelineSenders.make({
    items,
    nextCursor:
      rows.length > limit && last
        ? Navigation.encodeCursor({
            version: 1,
            kind: "timeline_senders",
            serverId,
            window,
            ceiling,
            after: { id: last.id, messageCount: last.messageCount },
          })
        : null,
  });
});
