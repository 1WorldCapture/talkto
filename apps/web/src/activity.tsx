import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import { describeAgentType } from "@talkto/api/agent-types";
import * as D from "@talkto/api/dashboard";
import { request, denied, input } from "./api.js";
import { AppLink, Notice, ParticipantMark, Search } from "./components.js";
import {
  ConversationFooter,
  MessageAgent,
  SelectedConversation,
  usePersonId,
} from "./person-chat.js";
import { useHuman, useServices } from "./session.js";
import { useServerPath } from "./server-path.js";
import { MessageDialogue } from "./message-dialogue.js";
import { MessageBody } from "./message-body.js";
import { RemovedTag } from "./removed-tag.js";
import type { DashboardSearch } from "./router.js";
import { Preferences, readPreferences, writePreferences } from "./message-preferences.js";
import { formatCount, formatFeedTime } from "./format.js";

/** Home's initial page and the exact request size that produced its cursors. */
export interface InitialFeed {
  readonly feed: P.AccountFeed;
  readonly limit: number;
}

interface Row {
  readonly serverId: M.ServerId;
  readonly serverName: string;
  readonly message: M.Message;
  readonly included: M.Included;
}
interface Page {
  readonly rows: ReadonlyArray<Row>;
  readonly nextCursor: M.Cursor | null;
  readonly liveCursor: M.Cursor;
  readonly caughtUp: boolean;
  readonly freshness: P.ActivityFreshness | null;
  /** Which servers an organization search covered; null outside organization searches. */
  readonly search: P.SearchCoverage | null;
  /** Where the server's stored history begins, once an older page reached it. */
  readonly history: M.HistoryLimit | null;
}

function accountPage(feed: P.AccountFeed): Page {
  return {
    rows: feed.items.map((item) => ({
      ...item,
      included: feed.included.find((related) => related.serverId === item.serverId) ?? {
        participants: [],
        conversations: [],
      },
    })),
    nextCursor: feed.nextCursor,
    liveCursor: feed.liveCursor,
    caughtUp: feed.caughtUp,
    freshness: feed.freshness,
    search: feed.search ?? null,
    history: null,
  };
}
function serverPage(feed: D.Feed, included: M.Included, server: P.ServerContext): Page {
  return {
    rows: feed.items.map((message) => ({
      serverId: server.id,
      serverName: server.name,
      message,
      included,
    })),
    nextCursor: feed.nextCursor,
    liveCursor: feed.liveCursor,
    caughtUp: feed.caughtUp,
    freshness: null,
    search: null,
    history: feed.history ?? null,
  };
}

function HistoryTrigger({
  enabled,
  load,
}: {
  readonly enabled: boolean;
  readonly load: () => void;
}) {
  const marker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = marker.current;
    if (!element || !enabled || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load();
      },
      { root: element.closest(".ops-log-body, .ops-dialogue"), rootMargin: "80px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, load]);
  return <div ref={marker} className="ops-history-trigger" aria-hidden="true" />;
}

const planNames: Record<M.HistoryPlan, string> = {
  free: "Free",
  shop: "Shop",
  studio: "Studio",
  factory: "Factory",
};
/** Where this server's stored history begins, under the organization's plan. */
export function historyStartText(limit: M.HistoryLimit) {
  const plan = planNames[limit.plan];
  return limit.archived
    ? `Older messages are in the history archive. The ${plan} plan keeps ${formatCount(limit.days, "day")} here and archives the rest.`
    : `Older messages were deleted. The ${plan} plan keeps ${formatCount(limit.days, "day")} of history.`;
}
function HistoryStart({ limit }: { readonly limit: M.HistoryLimit }) {
  return (
    <p className="ops-history-start" role="note">
      {historyStartText(limit)}
    </p>
  );
}

type HistoryControl = "mode" | "size" | "latest" | "older";
/** History navigation remounts this view; the control that caused it keeps keyboard focus. */
let pendingFocus: HistoryControl | null = null;

/** Cursor-bound message history with per-user display preferences and explicit live refresh. */
export function Activity({
  accountId,
  server,
  query,
  cursor,
  channel,
  around,
  navigate,
  initialFeed,
  window,
  conversationSearch,
  files = false,
}: {
  readonly accountId: P.AccountId;
  readonly server?: P.ServerContext | undefined;
  readonly query: string;
  readonly cursor?: string | undefined;
  readonly channel?: string | undefined;
  /** Message sequence a conversation opens at, from a feed row's "Open conversation". */
  readonly around?: number | undefined;
  readonly initialFeed?: InitialFeed | undefined;
  readonly window?: D.FeedWindow | undefined;
  readonly conversationSearch?: DashboardSearch | undefined;
  /** Whether this server offers Git sharing; share chips link its Files view only then. */
  readonly files?: boolean | undefined;
  readonly navigate: (search: {
    readonly query?: string | undefined;
    readonly cursor?: string | undefined;
    readonly channel?: string | undefined;
  }) => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const client = useQueryClient();
  const [preferences, setPreferences] = useState(() => readPreferences(user.id));
  // A later preference change must fetch a fresh page, not restore the original Home snapshot.
  const initialPreferences = useRef(preferences);
  const log = useRef<HTMLDivElement>(null);
  const historyNav = useRef<HTMLElement>(null);
  const restoreFocus = useRef(pendingFocus);
  useEffect(() => {
    pendingFocus = null;
  }, []);
  // Narrow screens fold the history settings behind a button; keep them open when a settings
  // change remounts the log and returns focus to one of them.
  const [historyOpen, setHistoryOpen] = useState(() => pendingFocus !== null);
  const historyId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  // The conversation reader starts at the newest message, so it starts at the bottom.
  const [atBottom, setAtBottom] = useState(true);
  const dialogue = !!server && !!channel;
  const shown = useContext(SelectedConversation)?.conversation;
  const self = usePersonId(accountId, server?.id, shown !== undefined);
  // In the person's own chat with an agent, the agent needs no "Message" shortcut.
  const own: ReadonlyArray<M.ParticipantId> =
    shown?.kind === "direct" && self !== null && shown.participantIds.includes(self)
      ? shown.participantIds
      : [];
  const inspecting = dialogue || hovered || focused || expanded || scrolled;
  const fetchPage = async (
    continuation: string | undefined,
    signal: AbortSignal,
  ): Promise<Page> => {
    if (server) {
      const selection: D.FeedInput = continuation
        ? { cursor: M.Cursor.make(continuation), limit: preferences.size }
        : input(D.FeedInput, {
            query,
            conversationId: channel,
            limit: preferences.size,
            ...window,
            around,
          });
      const result = await request(
        api.server.serverFeed({ params: { serverId: server.id }, query: selection }),
        signal,
      );
      return serverPage(result.data, result.included, server);
    }
    const selection: P.ActivityInput = continuation
      ? { cursor: M.Cursor.make(continuation), limit: preferences.size }
      : input(P.ActivityInput, { query, limit: preferences.size });
    return accountPage(
      (await request(api.platform.activity({ params: { accountId }, query: selection }), signal))
        .data,
    );
  };
  const prefix = [
    "human",
    user.id,
    accountId,
    server?.id ?? "aggregate",
    "feed",
    query,
    channel,
    window?.start,
    window?.end,
    around,
    preferences.size,
    preferences.mode,
  ];
  const queryKey = [...prefix, cursor];
  const snapshot = useInfiniteQuery({
    queryKey,
    initialPageParam: cursor,
    initialData: () =>
      !server &&
      !cursor &&
      !query &&
      !channel &&
      initialFeed &&
      preferences === initialPreferences.current &&
      preferences.size === initialFeed.limit
        ? { pages: [accountPage(initialFeed.feed)], pageParams: [cursor] }
        : undefined,
    queryFn: ({ pageParam, signal }) => fetchPage(pageParam, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const head = snapshot.data?.pages[0];
  // A conversation opened at an older message is history until its newer messages are loaded.
  const pinned = !!cursor || (around !== undefined && head?.caughtUp === false);
  const updates = useQuery({
    queryKey: [...prefix, "updates", head?.liveCursor],
    enabled: !window && !pinned && !!head && !denied(snapshot.error),
    queryFn: ({ signal }) => fetchPage(head?.liveCursor, signal),
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (result) => (result.state.data?.rows.length ? false : 3000),
  });
  /** New messages join the conversation in place; the reader keeps every older page. */
  const appendUpdates = useCallback(() => {
    const arrived = updates.data;
    if (!arrived?.rows.length) return;
    client.setQueryData<InfiniteData<Page, string | undefined>>(queryKey, (previous) => {
      const [first, ...rest] = previous?.pages ?? [];
      return previous && first
        ? {
            ...previous,
            pages: [
              {
                ...first,
                rows: [...arrived.rows, ...first.rows],
                liveCursor: arrived.liveCursor,
                caughtUp: arrived.caughtUp,
              },
              ...rest,
            ],
          }
        : previous;
    });
  }, [client, queryKey, updates.data]);
  useEffect(() => {
    if (dialogue && !pinned && atBottom && !query && !snapshot.isFetching) appendUpdates();
  }, [dialogue, pinned, atBottom, query, snapshot.isFetching, appendUpdates]);
  useEffect(() => {
    if (
      !cursor &&
      !dialogue &&
      !inspecting &&
      snapshot.data?.pages.length === 1 &&
      updates.data?.rows.length &&
      !snapshot.isFetching &&
      !snapshot.error
    )
      void snapshot.refetch();
  }, [
    cursor,
    dialogue,
    inspecting,
    updates.data,
    snapshot.data,
    snapshot.isFetching,
    snapshot.error,
    snapshot.refetch,
  ]);
  const error = snapshot.error ?? updates.error;
  const blocked = denied(error);
  const rows = useMemo(() => {
    if (blocked) return [];
    const unique = new Map<string, Row>();
    for (const page of snapshot.data?.pages ?? [])
      for (const row of page.rows) unique.set(`${row.serverId}:${row.message.id}`, row);
    return [...unique.values()];
  }, [blocked, snapshot.data]);
  const delivered = useMemo(() => new Set(rows.map((row) => row.message.id)), [rows]);
  // Newest first: a read-only conversation offers to message the agents who spoke last.
  const senders = useMemo(() => {
    const found = new Map<string, M.Participant>();
    for (const row of rows) {
      const sender = row.included.participants.find((p) => p.id === row.message.senderId);
      if (sender && sender.kind !== "person") found.set(sender.id, sender);
    }
    return [...found.values()];
  }, [rows]);
  const loadMore = useCallback(() => {
    if (snapshot.hasNextPage && !snapshot.isFetching && !blocked)
      void snapshot.fetchNextPage({ cancelRefetch: false });
  }, [snapshot.hasNextPage, snapshot.isFetching, snapshot.fetchNextPage, blocked]);
  const refresh = () => {
    // A deliberate refresh returns to the newest page, retaining that page on a transient error.
    client.setQueryData<InfiniteData<Page, string | undefined>>(queryKey, (previous) =>
      previous ? { pages: previous.pages.slice(0, 1), pageParams: [cursor] } : previous,
    );
    void snapshot.refetch().then((result) => {
      if (!result.error) {
        setHovered(false);
        setFocused(false);
        setExpanded(false);
        setScrolled(false);
        if (log.current) log.current.scrollTop = 0;
      }
    });
  };
  useEffect(() => {
    const name = restoreFocus.current;
    if (!name || snapshot.isPending) return;
    const controls = historyNav.current;
    const target = controls?.querySelector<HTMLElement>(`[data-history="${name}"]:enabled`);
    (target ?? controls?.querySelector<HTMLElement>('[data-history="mode"]'))?.focus({
      preventScroll: true,
    });
    restoreFocus.current = null;
  });
  const changePreferences = (value: typeof Preferences.Type, control: HistoryControl) => {
    // Returning to a saved setting starts at the newest page, not an old cached scroll session.
    client.removeQueries({
      queryKey: [
        "human",
        user.id,
        accountId,
        server?.id ?? "aggregate",
        "feed",
        query,
        channel,
        window?.start,
        window?.end,
        value.size,
        value.mode,
        undefined,
      ],
      exact: true,
    });
    setPreferences(value);
    writePreferences(user.id, value);
    if (log.current) log.current.scrollTop = 0;
    setScrolled(false);
    if (cursor) {
      pendingFocus = control;
      navigate({ query, channel });
    }
  };
  const empty = snapshot.isPending
    ? "Loading messages…"
    : blocked
      ? "Messages are unavailable."
      : snapshot.error
        ? "Messages could not be loaded."
        : query || window
          ? "No matching messages."
          : "No messages yet.";
  const automatic = preferences.mode === "scroll";
  const history = (
    <nav className="ops-pagination" aria-label="Message history" ref={historyNav}>
      <span role="status">
        {window ? "Selected range" : pinned ? "History" : "Latest"} · {rows.length.toLocaleString()}{" "}
        shown
      </span>
      <button
        type="button"
        className="ops-history-toggle"
        aria-expanded={historyOpen}
        aria-controls={historyId}
        onClick={() => setHistoryOpen(!historyOpen)}
      >
        <span className="sr-only">History settings</span>
      </button>
      <div id={historyId} className="ops-history-controls" data-open={historyOpen || undefined}>
        <select
          aria-label="Message loading"
          data-history="mode"
          value={preferences.mode}
          onChange={(event) =>
            changePreferences(
              input(Preferences, { ...preferences, mode: event.target.value }),
              "mode",
            )
          }
        >
          <option value="scroll">Scroll</option>
          <option value="pages">Pages</option>
        </select>
        <select
          aria-label={automatic ? "Messages per load" : "Messages per page"}
          data-history="size"
          value={preferences.size}
          onChange={(event) =>
            changePreferences(
              input(Preferences, { ...preferences, size: Number(event.target.value) }),
              "size",
            )
          }
        >
          {[10, 25, 50].map((size) => (
            <option key={size} value={size}>
              {size} / {automatic ? "load" : "page"}
            </option>
          ))}
        </select>
        {(pinned || (snapshot.data?.pages.length ?? 0) > 1) && (
          <button
            data-history="latest"
            onClick={() => {
              if (!pinned) return refresh();
              pendingFocus = "older";
              navigate({ query, channel });
            }}
          >
            Latest
          </button>
        )}
        <button
          data-history="older"
          disabled={!snapshot.hasNextPage || blocked || snapshot.isFetching}
          onClick={() => {
            if (automatic) return loadMore();
            if (!head?.nextCursor) return;
            pendingFocus = "older";
            navigate({ query, channel, cursor: head.nextCursor });
          }}
        >
          {snapshot.isFetchingNextPage
            ? "Loading…"
            : snapshot.isFetchNextPageError
              ? "Retry older"
              : !snapshot.hasNextPage && rows.length
                ? "Start of history"
                : automatic
                  ? "Load older"
                  : "← Older messages"}
        </button>
      </div>
    </nav>
  );
  const limit = snapshot.hasNextPage ? null : (snapshot.data?.pages.at(-1)?.history ?? null);
  const marker = (
    <>
      {limit && rows.length > 0 && <HistoryStart limit={limit} />}
      {automatic && (
        <HistoryTrigger
          load={loadMore}
          enabled={!!snapshot.hasNextPage && !snapshot.isFetching && !snapshot.error && !blocked}
        />
      )}
    </>
  );
  return (
    <>
      <section
        className={`ops-log${server ? " ops-log-single" : ""}${dialogue ? " ops-conversation-log" : ""}`}
        aria-label={dialogue ? "Conversation messages" : "Message activity"}
      >
        <header className="ops-log-toolbar">
          <h2>Messages</h2>
          {!!updates.data?.rows.length && !pinned && (
            <button
              data-ops-refresh
              disabled={snapshot.isFetching || blocked}
              onClick={dialogue && !query ? appendUpdates : refresh}
            >
              {snapshot.isFetching
                ? "Updating…"
                : dialogue && !query && updates.data.caughtUp
                  ? `${formatCount(updates.data.rows.length, "new message")} ↓`
                  : "New messages"}
            </button>
          )}
          <Search
            label="Find messages"
            value={query}
            onChange={(value) => navigate({ query: value, channel })}
          />
        </header>
        <Notice
          error={error}
          stale={!!head && !blocked}
          retry={snapshot.isFetchNextPageError ? loadMore : refresh}
        />
        {dialogue && history}
        {dialogue ? (
          <MessageDialogue
            rows={rows}
            position={query ? "search" : pinned ? "history" : "latest"}
            target={around}
            empty={empty}
            history={marker}
            onBottom={setAtBottom}
            self={self}
            files={files}
            senderAction={(sender) =>
              server && sender.kind !== "person" && !own.includes(sender.id) ? (
                <MessageAgent accountId={accountId} serverId={server.id} agent={sender} />
              ) : null
            }
          />
        ) : (
          <>
            <div className="ops-columns" aria-hidden="true">
              <span>Time</span>
              {!server && <span className="ops-entry-server">Server</span>}
              <span>From</span>
              <span>To</span>
              <span className="ops-preview">Message</span>
            </div>
            <div
              className="ops-log-body"
              ref={log}
              role="region"
              aria-label="Message log, newest first"
              tabIndex={0}
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => setHovered(false)}
              onFocus={() => setFocused(true)}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
              }}
              onScroll={() => setScrolled((log.current?.scrollTop ?? 0) > 0)}
              onToggle={() => setExpanded(!!log.current?.querySelector("details[open]"))}
            >
              {rows.map((row) => (
                <MessageRow
                  key={`${row.serverId}:${row.message.id}`}
                  row={row}
                  showServer={!server}
                  accountId={accountId}
                  conversationSearch={conversationSearch}
                />
              ))}
              {rows.length === 0 && <p className="ops-empty">{empty}</p>}
              {marker}
            </div>
          </>
        )}
        {dialogue && server && (
          <ConversationFooter
            accountId={accountId}
            serverId={server.id}
            senders={senders}
            delivered={delivered}
            onSent={() => {
              setAtBottom(true);
              void updates.refetch();
              // The heading's message count and last-message time follow the send.
              void client.invalidateQueries({
                queryKey: ["human", user.id, accountId, server.id, "conversation", channel],
              });
            }}
          />
        )}
        {!dialogue && history}
        {!query && head?.freshness && head.freshness.pendingServers > 0 && (
          <p className="feed-freshness">
            Activity is catching up · {head.freshness.pendingServers} servers pending.
          </p>
        )}
        {query && head?.search && <SearchCoverage coverage={head.search} />}
      </section>
    </>
  );
}

/** Says which servers a search left out, so missing matches are never read as none. */
function SearchCoverage({ coverage }: { readonly coverage: P.SearchCoverage }) {
  if (coverage.unavailableServers === 0 && coverage.notSearchedServers === 0) return null;
  return (
    <p className="feed-freshness" role="status">
      {coverage.unavailableServers > 0 &&
        `${formatCount(coverage.unavailableServers, "server")} did not answer this search, so ${
          coverage.unavailableServers === 1 ? "its" : "their"
        } matches are missing. Search again to retry. `}
      {coverage.notSearchedServers > 0 &&
        `Search covers your ${coverage.serverLimit} most recently active servers; ${formatCount(
          coverage.notSearchedServers,
          "other server",
        )} ${coverage.notSearchedServers === 1 ? "was" : "were"} not searched. Open a server to search it.`}
    </p>
  );
}

function MessageRow({
  row,
  showServer,
  accountId,
  conversationSearch,
}: {
  readonly row: Row;
  readonly showServer: boolean;
  readonly accountId: P.AccountId;
  readonly conversationSearch?: DashboardSearch | undefined;
}) {
  const message = row.message;
  const path = useServerPath(accountId, row.serverId);
  const sender = row.included.participants.find(
    (participant) => participant.id === message.senderId,
  );
  const conversation = row.included.conversations.find(
    (item) => item.id === message.conversationId,
  );
  const recipient =
    conversation?.kind === "direct"
      ? row.included.participants.find(
          (participant) =>
            participant.id !== message.senderId &&
            conversation.participantIds.includes(participant.id),
        )
      : undefined;
  const from = sender?.name ?? "Unknown sender";
  const to =
    conversation?.kind === "channel"
      ? `# ${conversation.name}`
      : (recipient?.name ?? "Direct chat");
  return (
    <details className="ops-entry">
      <summary
        onClick={(event) => {
          // Finishing a text selection inside the row must not also toggle it.
          if (globalThis.getSelection()?.isCollapsed === false) event.preventDefault();
        }}
      >
        <time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>
          {formatFeedTime(message.createdAt)}
        </time>
        {showServer && (
          <span className="ops-entry-server" title={row.serverName}>
            {row.serverName}
          </span>
        )}
        <span
          className="ops-from"
          title={sender ? `${from} · ${describeAgentType(sender.agentType).label}` : from}
        >
          <ParticipantMark participant={sender} />
          <span>{from}</span>
          <RemovedTag participant={sender} />
        </span>
        <span
          className="ops-to"
          title={recipient ? `${to} · ${describeAgentType(recipient.agentType).label}` : to}
        >
          <small>→</small>
          {recipient && <ParticipantMark participant={recipient} />}
          <span>{to}</span>
        </span>
        <span className="ops-preview">{message.body}</span>
      </summary>
      <div className="ops-full-message">
        <MessageBody body={message.body} />
        <small>
          {from} → {to} · {new Date(message.createdAt).toLocaleString()} · #{message.sequence}
        </small>
        <AppLink
          path={path}
          search={{
            ...conversationSearch,
            channel: message.conversationId,
            cursor: undefined,
            message: message.sequence,
          }}
        >
          Open conversation
        </AppLink>
      </div>
    </details>
  );
}
