import { Context, DateTime, Effect, Encoding, Layer, Result, Schema } from "effect";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as I from "@talkto/api/inputs";
import * as D from "@talkto/api/dashboard";
import * as Model from "./model.js";
import * as Platform from "./service.js";
import * as Navigation from "../navigation.js";
import * as Search from "./activity-search.js";

/** An indexed reference selected under directory permissions; hydration rechecks the server grant. */
export const Reference = Schema.Struct({
  id: M.Count,
  serverId: M.ServerId,
  serverName: M.ServerName,
  messageId: M.MessageId,
});
/** Parsed indexed message reference. */
export interface Reference extends Schema.Schema.Type<typeof Reference> {}
/** Cursor is bound to the caller, account and original search. Delivery order captures late arrivals. */
export const Cursor = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("account-activity"),
  userId: P.UserId,
  accountId: P.AccountId,
  query: Schema.NullOr(I.SearchQuery),
  boundary: M.Count,
  ceiling: M.Count,
  direction: Schema.Literals(["older", "newer"]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed aggregate continuation. */
export interface Cursor extends Schema.Schema.Type<typeof Cursor> {}
/**
 * A search continuation, bound to the caller, account and query. Searches run inside each
 * server, so the cursor records a merge position (older pages) or each server's newest sequence
 * (live pages) instead of a shared index position. `since` is when the search began; a server
 * with no recorded sequence counts only messages created after it.
 */
export const SearchCursor = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("account-search"),
  userId: P.UserId,
  accountId: P.AccountId,
  query: I.SearchQuery,
  since: M.Timestamp,
  direction: Schema.Literals(["older", "newer"]),
  position: Schema.NullOr(Search.Position),
  heads: Schema.Array(Schema.Tuple([M.ServerId, M.Count])),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed search continuation. */
export interface SearchCursor extends Schema.Schema.Type<typeof SearchCursor> {}
type Operation<A> = Effect.Effect<A, Model.Failure>;
/** Cohesive read port for the derived account index. */
export class Index extends Context.Service<
  Index,
  {
    readonly head: (actor: Model.Actor, accountId: P.AccountId) => Operation<number>;
    readonly select: (state: Cursor, limit: number) => Operation<ReadonlyArray<Reference>>;
    /**
     * Servers an account search asks: the caller's readable servers, most recently active first,
     * at most `limit`, and how many readable servers there are in all.
     */
    readonly searchServers: (
      actor: Model.Actor,
      accountId: P.AccountId,
      limit: number,
    ) => Operation<{
      readonly total: number;
      readonly servers: ReadonlyArray<{
        readonly serverId: M.ServerId;
        readonly serverName: typeof M.ServerName.Type;
      }>;
    }>;
    readonly freshness: (
      actor: Model.Actor,
      accountId: P.AccountId,
    ) => Operation<P.ActivityFreshness>;
    readonly rank: (
      actor: Model.Actor,
      accountId: P.AccountId,
      start: M.Timestamp,
      end: M.Timestamp,
    ) => Operation<{
      readonly selection: P.Dashboard["serverSelection"];
      readonly servers: ReadonlyArray<{
        readonly serverId: M.ServerId;
        readonly createdBy: P.UserId;
        readonly count: number;
        readonly lastMessageAt: M.Timestamp | null;
      }>;
    }>;
  }
>()("@talkto/platform/ActivityIndex") {}
/** Only private, authorized RPC reads are used to hydrate indexed references. */
export class Servers extends Context.Service<
  Servers,
  {
    readonly read: (
      actor: Model.Actor,
      serverId: M.ServerId,
      ids: ReadonlyArray<M.MessageId>,
    ) => Operation<M.Outcome<ReadonlyArray<M.Message>> | null>;
    readonly summary: (
      actor: Model.Actor,
      serverId: M.ServerId,
    ) => Operation<M.Outcome<D.Summary> | null>;
    /** One server's part of an account search. An unreachable server answers `unavailable`. */
    readonly search: (
      actor: Model.Actor,
      serverId: M.ServerId,
      request: Search.Request,
    ) => Effect.Effect<Search.Answer>;
  }
>()("@talkto/platform/ActivityServers") {}
/** Dashboard application operations, separate from index storage and HTTP. */
export class Service extends Context.Service<
  Service,
  {
    readonly feed: (
      actor: Model.Actor,
      accountId: P.AccountId,
      input: P.ActivityInput,
    ) => Operation<P.AccountFeed>;
    readonly home: (
      actor: Model.Actor,
      accountId: P.AccountId,
      input: P.DashboardInput,
    ) => Operation<P.Dashboard>;
  }
>()("@talkto/platform/Activity") {}
const invalid = () =>
  new Model.Failure({
    code: "invalid_input",
    message: "The activity continuation is invalid for this organization or caller.",
  });
const encode = (value: Cursor) => M.Cursor.make(Encoding.encodeBase64Url(JSON.stringify(value)));
/** Cursors are bounded; a live cursor too long to carry every server's sequence counts by time. */
const encodeSearch = (value: SearchCursor) => {
  const token = Encoding.encodeBase64Url(JSON.stringify(value));
  return M.Cursor.make(
    token.length <= 4096
      ? token
      : Encoding.encodeBase64Url(JSON.stringify({ ...value, heads: [] })),
  );
};
const AnyCursor = Schema.Union([Cursor, SearchCursor]);

/** Compose bounded index reads with authoritative server hydration. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const index = yield* Index;
    const servers = yield* Servers;
    const directory = yield* Platform.Directory;
    const identity = yield* Platform.Identity;
    const authorize = Effect.fn("Activity.authorize")(function* (
      actor: Model.Actor,
      id: P.AccountId,
    ) {
      const found = yield* Platform.accountMembership(directory, identity, actor, id);
      const member = found?.membership ?? null;
      if (member === null || member.status !== "active")
        return yield* new Model.Failure({
          code: "not_found",
          message: "The organization is unavailable.",
        });
      yield* directory.recordMembership(member);
    });
    /** The unfiltered feed, from the shared index of message IDs and times. */
    const indexFeed = Effect.fn("Activity.indexFeed")(function* (
      actor: Model.Actor,
      state: Cursor,
      limit: number,
      candidates: ReadonlyArray<Reference>,
      freshness: P.ActivityFreshness,
    ) {
      // A page can hydrate at most ten objects, even when every event belongs to another server.
      const selected: Reference[] = [];
      const groups = new Map<M.ServerId, M.MessageId[]>();
      for (const item of candidates) {
        if (selected.length >= limit || (!groups.has(item.serverId) && groups.size === 10)) break;
        const group = groups.get(item.serverId) ?? [];
        group.push(item.messageId);
        groups.set(item.serverId, group);
        selected.push(item);
      }
      const hydrated = yield* Effect.forEach(
        [...groups],
        ([serverId, ids]) =>
          servers.read(actor, serverId, ids).pipe(Effect.map((result) => ({ serverId, result }))),
        { concurrency: 5 },
      );
      const values = new Map(hydrated.map((h) => [h.serverId, h.result]));
      const items: P.AccountFeed["items"][number][] = [];
      let bytes = 0;
      let boundary = state.boundary;
      let consumed = 0;
      for (const ref of selected) {
        const message = values.get(ref.serverId)?.data.find((m) => m.id === ref.messageId);
        if (message !== undefined) {
          const size = new TextEncoder().encode(message.body).length;
          if (bytes + size > 65536) break;
          bytes += size;
          items.push({ serverId: ref.serverId, serverName: ref.serverName, message });
        }
        boundary = ref.id;
        consumed++;
      }
      const more = consumed < candidates.length;
      const included = hydrated
        .filter((h) => h.result !== null && items.some((i) => i.serverId === h.serverId))
        .flatMap((h) =>
          h.result === null ? [] : [{ serverId: h.serverId, ...h.result.included }],
        );
      return P.AccountFeed.make({
        items,
        included,
        nextCursor: more ? encode({ ...state, boundary }) : null,
        liveCursor: encode({
          ...state,
          direction: "newer",
          boundary: state.direction === "newer" && more ? boundary : state.ceiling,
        }),
        caughtUp: state.direction === "older" || !more,
        freshness,
      });
    });
    /**
     * One index page, with its reads in parallel. A live page is capped by the head (the newest
     * visible event); it is selected without that cap and trimmed to it, which yields the same rows
     * because a live page reads oldest first. The first page has no cap: its ceiling is the newest
     * event it saw or the head, whichever is higher.
     */
    const indexPage = Effect.fn("Activity.indexPage")(function* (
      actor: Model.Actor,
      accountId: P.AccountId,
      state: Cursor,
      limit: number,
      kind: "older" | "newer" | "first",
    ) {
      const uncapped =
        kind === "older"
          ? state
          : {
              ...state,
              ceiling: Number.MAX_SAFE_INTEGER,
              boundary: kind === "first" ? Number.MAX_SAFE_INTEGER : state.boundary,
            };
      const [head, selected, freshness] = yield* Effect.all(
        [
          kind === "older" ? Effect.succeed(state.ceiling) : index.head(actor, accountId),
          index.select(uncapped, limit + 1),
          index.freshness(actor, accountId),
        ],
        { concurrency: "unbounded" },
      );
      if (kind === "first") {
        const ceiling = Math.max(head, selected[0]?.id ?? 0);
        return yield* indexFeed(
          actor,
          { ...state, boundary: ceiling + 1, ceiling },
          limit,
          selected,
          freshness,
        );
      }
      const ceiling = Math.max(state.ceiling, head);
      return yield* indexFeed(
        actor,
        { ...state, ceiling },
        limit,
        selected.filter((item) => item.id <= ceiling),
        freshness,
      );
    });
    /**
     * A search asks each readable server's own database, at most `Search.serverLimit` servers,
     * and merges their matches. A server that does not answer is counted, not hidden.
     */
    const searchFeed = Effect.fn("Activity.searchFeed")(function* (
      actor: Model.Actor,
      accountId: P.AccountId,
      state: SearchCursor,
      limit: number,
    ) {
      const selection = yield* index.searchServers(actor, accountId, Search.serverLimit);
      const heads = new Map(state.heads);
      const bound = (serverId: M.ServerId): Search.Bound | null => {
        if (state.direction === "older") return Search.olderBound(serverId, state.position);
        const head = heads.get(serverId);
        return head === undefined
          ? { kind: "time", time: state.since, inclusive: false }
          : { kind: "sequence", sequence: head };
      };
      const answers = yield* Effect.forEach(
        selection.servers,
        (server) =>
          servers
            .search(actor, server.serverId, {
              query: state.query,
              direction: state.direction,
              bound: bound(server.serverId),
              limit,
            })
            .pipe(Effect.map((answer) => ({ ...server, answer }))),
        { concurrency: Search.concurrency },
      );
      const answered = answers.flatMap(({ serverId, serverName, answer }) =>
        answer.kind === "results" ? [{ serverId, serverName, ...answer }] : [],
      );
      const { matches, more } = Search.merge(answered, state.direction, limit);
      const last = matches.at(-1);
      let next: SearchCursor;
      if (state.direction === "older") {
        next = {
          ...state,
          position: last === undefined ? state.position : Search.positionOf(last),
        };
      } else {
        // Each server's matches were consumed in order, so its newest consumed sequence is exact.
        // A server whose every match was consumed is caught up to the head it reported.
        const advanced = new Map<M.ServerId, number>();
        for (const match of matches) advanced.set(match.serverId, match.message.sequence);
        const live = new Map<M.ServerId, number>();
        for (const part of answered) {
          const consumed = matches.filter((m) => m.serverId === part.serverId).length;
          const previous = heads.get(part.serverId);
          const reached =
            !part.more && consumed === part.items.length
              ? part.head
              : (advanced.get(part.serverId) ?? previous);
          if (reached !== undefined) live.set(part.serverId, Math.max(reached, previous ?? 0));
        }
        // Keep the recorded sequence of a server that did not answer this time.
        for (const { serverId, answer } of answers) {
          const previous = heads.get(serverId);
          if (answer.kind === "unavailable" && previous !== undefined) live.set(serverId, previous);
        }
        next = { ...state, heads: [...live] };
      }
      const liveCursor: SearchCursor =
        state.direction === "newer"
          ? next
          : {
              ...state,
              direction: "newer",
              position: null,
              // The first page records each server's head; later pages count from the start time.
              heads:
                state.position === null
                  ? answered.map((part): readonly [M.ServerId, number] => [
                      part.serverId,
                      part.head,
                    ])
                  : [],
            };
      const included = answered
        .filter((part) => matches.some((m) => m.serverId === part.serverId))
        .map((part) => ({ serverId: part.serverId, ...part.included }));
      return P.AccountFeed.make({
        items: matches,
        included,
        nextCursor: more ? encodeSearch(next) : null,
        liveCursor: encodeSearch(liveCursor),
        caughtUp: state.direction === "older" || !more,
        freshness: yield* index.freshness(actor, accountId),
        search: {
          serverLimit: Search.serverLimit,
          searchedServers: answered.length,
          unavailableServers: answers.filter(({ answer }) => answer.kind === "unavailable").length,
          notSearchedServers: Math.max(0, selection.total - selection.servers.length),
        },
      });
    });
    const readFeed = Effect.fn("Activity.readFeed")(function* (
      actor: Model.Actor,
      accountId: P.AccountId,
      input: P.ActivityInput,
    ) {
      const limit = input.limit ?? 50;
      if ("cursor" in input) {
        const raw = Encoding.decodeBase64UrlString(input.cursor);
        if (Result.isFailure(raw)) return yield* invalid();
        const state = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AnyCursor))(
          raw.success,
        ).pipe(Effect.mapError(invalid));
        if (state.userId !== actor.userId || state.accountId !== accountId) return yield* invalid();
        if (state.kind === "account-search")
          return yield* searchFeed(actor, accountId, state, limit);
        // Index cursors never carry a search: searches run inside each server.
        if (state.query !== null || state.boundary > state.ceiling) return yield* invalid();
        // A revoked server can lower the visible head. Keep the old ceiling but filter every read again.
        return yield* indexPage(actor, accountId, state, limit, state.direction);
      }
      if (input.query !== undefined) {
        yield* Navigation.searchExpression(input.query).pipe(Effect.mapError(() => invalid()));
        return yield* searchFeed(
          actor,
          accountId,
          {
            version: 1,
            kind: "account-search",
            userId: actor.userId,
            accountId,
            query: input.query,
            since: M.Timestamp.make(DateTime.formatIso(yield* DateTime.now)),
            direction: "older",
            position: null,
            heads: [],
          },
          limit,
        );
      }
      return yield* indexPage(
        actor,
        accountId,
        {
          version: 1,
          kind: "account-activity",
          userId: actor.userId,
          accountId,
          query: null,
          boundary: 0,
          ceiling: 0,
          direction: "older",
        },
        limit,
        "first",
      );
    });
    return Service.of({
      feed: Effect.fn("Activity.feed")(function* (actor, accountId, input) {
        yield* authorize(actor, accountId);
        return yield* readFeed(actor, accountId, input);
      }),
      home: Effect.fn("Activity.home")(function* (actor, accountId, input) {
        yield* authorize(actor, accountId);
        const end = yield* DateTime.now;
        const windowEnd = M.Timestamp.make(DateTime.formatIso(end));
        const windowStart = M.Timestamp.make(
          DateTime.formatIso(DateTime.subtract(end, { minutes: 30 })),
        );
        // The server cards and the feed are independent reads; neither waits for the other.
        const cardsAndRank = Effect.gen(function* () {
          const ranked = yield* index.rank(actor, accountId, windowStart, windowEnd);
          const cards = yield* Effect.forEach(
            ranked.servers,
            (rank) =>
              servers.summary(actor, rank.serverId).pipe(
                Effect.map((result) =>
                  result === null
                    ? []
                    : [
                        {
                          summary: result.data,
                          permissions: {
                            readMessages: true,
                            manageAccess: rank.createdBy === actor.userId,
                            resume: false,
                          },
                          activity: {
                            windowStart,
                            windowEnd,
                            messageCount: rank.count,
                            lastMessageAt: rank.lastMessageAt,
                          },
                        },
                      ],
                ),
              ),
            { concurrency: 5 },
          );
          return { selection: ranked.selection, cards: cards.flat() };
        });
        const [home, feed] = yield* Effect.all([cardsAndRank, readFeed(actor, accountId, input)], {
          concurrency: 2,
        });
        return P.Dashboard.make({
          serverSelection: home.selection,
          servers: home.cards,
          windowStart,
          windowEnd,
          feedLimit: input.limit ?? 50,
          feed,
        });
      }),
    });
  }),
);
