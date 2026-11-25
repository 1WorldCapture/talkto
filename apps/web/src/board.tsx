import { memo, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  skipToken,
  type QueryClient,
} from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as T from "@talkto/api/tasks";
import * as I from "@talkto/api/inputs";
import { ApiError, input, request, type Client } from "./api.js";
import { AgentIcon, AppLink, Dialog, Notice, ParticipantMark } from "./components.js";
import { MessageBody } from "./message-body.js";
import { TransferChip } from "./message-dialogue.js";
import { TaskResult } from "./task-result.js";
import { useHuman, useServices } from "./session.js";
import { useServerPath } from "./server-path.js";
import { formatFeedTime } from "./format.js";
import {
  agentSummary,
  eventResult,
  resultCount,
  attemptLabel,
  barSegments,
  heldShown,
  nameParts,
  refsShown,
  silenceFor,
  chosenTab,
  countFilter,
  countWord,
  exceptionRows,
  isFinished,
  listInput,
  moreCount,
  refreshesItself,
  retriedNotice,
  attemptsUsed,
  retryEffect,
  retryPlan,
  rowWorkers,
  rowState,
  showsFilters,
  silenceLabel,
  tabsFor,
  taskName,
  updatedLabel,
  type ListFilter,
  type StateFilter,
  type Tab,
} from "./board-model.js";
import "./board.css";

/*
  The swarm server's Board (docs/swarm-server-spec.md, 9.2 and 9.3), phase 1: the summary, Stalled
  and Failed, the task list, and a read-only task page with Cancel, and Retry for failed tasks. Needs you and every decision
  come in phase 2; the Board leaves their place above Stalled and Failed.
*/

/** The Board's top as the dashboard keeps it: a changed reply with the agents its rows name. */
export type BoardTop = Extract<T.Board, { readonly changed: true }> & {
  readonly participants: ReadonlyArray<M.Participant>;
};

/** How often the Board's top is read while the page is visible (spec 9.2, Refresh). */
const refreshEvery = 5000;
/** Task list page size. */
const pageSize = 50;

const boardKey = (userId: P.UserId, accountId: P.AccountId, serverId: M.ServerId) =>
  ["human", userId, accountId, serverId, "board"] as const;

/** Read the Board's top again only when it changed: an unchanged board keeps the last reply. */
async function readBoard(
  api: Client,
  queries: QueryClient,
  key: ReturnType<typeof boardKey>,
  serverId: M.ServerId,
  signal: AbortSignal,
): Promise<BoardTop> {
  const previous = queries.getQueryData<BoardTop>(key);
  const reply = await request(
    api.server.getBoard({
      params: { serverId },
      query: input(T.BoardInput, { after: previous?.after }),
    }),
    signal,
  );
  if (reply.data.changed) return { ...reply.data, participants: reply.included.participants };
  if (previous) return previous;
  // An unchanged answer to a first read cannot happen; read the whole top instead.
  const whole = await request(api.server.getBoard({ params: { serverId }, query: {} }), signal);
  if (!whole.data.changed)
    throw new ApiError("internal_error", "The board could not be read. Try again.");
  return { ...whole.data, participants: whole.included.participants };
}

/** The Board's top, refreshed every 5 seconds while the page is visible. */
export function useBoard(accountId: P.AccountId, serverId: M.ServerId, enabled = true) {
  const { api, queries } = useServices();
  const user = useHuman();
  const key = boardKey(user.id, accountId, serverId);
  return useQuery({
    queryKey: key,
    enabled,
    queryFn: ({ signal }) => readBoard(api, queries, key, serverId, signal),
    refetchInterval: refreshEvery,
    refetchIntervalInBackground: false,
  });
}

/** Whether this deployment offers task boards; the session read already carries it. */
export function useBoardsOffered() {
  const { api } = useServices();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: ({ signal }) => request(api.platform.currentUser(), signal),
  });
  return session.data?.data.connection.boards === true;
}

const decoded = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: string | undefined,
): S["Type"] | undefined =>
  value === undefined
    ? undefined
    : Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));

/** The Board tab of a swarm server. */
export function Board({
  accountId,
  server,
}: {
  readonly accountId: P.AccountId;
  readonly server: P.ServerContext;
}) {
  const board = useBoard(accountId, server.id);
  const user = useHuman();
  const creator = server.createdBy === user.id;
  const top = board.data;
  if (!top) {
    if (board.error instanceof ApiError && board.error.code === "board_off")
      return (
        <div className="board-empty-state">
          <p>{board.error.message}</p>
          {creator && server.permissions.manageAccess && (
            <SettingsLink accountId={accountId} serverId={server.id}>
              Open Settings
            </SettingsLink>
          )}
        </div>
      );
    return (
      <>
        <Notice error={board.error} retry={() => void board.refetch()} />
        {board.isPending && (
          <p className="ops-empty" role="status">
            Loading board…
          </p>
        )}
      </>
    );
  }
  return (
    <div className="board">
      <Notice error={board.error} stale />
      {!top.enabled && (
        <p className="board-off" role="status">
          The board is off. Tasks stay as they were, read-only.{" "}
          {creator && server.permissions.manageAccess ? (
            <SettingsLink accountId={accountId} serverId={server.id}>
              Turn it on in Settings.
            </SettingsLink>
          ) : (
            "The person who created this server can turn it on in Settings."
          )}
        </p>
      )}
      <Summary accountId={accountId} serverId={server.id} top={top} />
      {top.total > 0 && (
        <>
          {/* Needs you (phase 2) goes here, above Stalled and Failed. */}
          <Exceptions accountId={accountId} serverId={server.id} top={top} />
          <TaskList accountId={accountId} serverId={server.id} top={top} />
        </>
      )}
    </div>
  );
}

function SettingsLink({
  accountId,
  serverId,
  children,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly children: ReactNode;
}) {
  return (
    <AppLink path={useServerPath(accountId, serverId)} search={{ tab: "settings" }}>
      {children}
    </AppLink>
  );
}

/** Navigate the task list's filters; they live in the URL so a filtered Board can be shared. */
function useListNavigation(accountId: P.AccountId, serverId: M.ServerId) {
  const navigate = useNavigate();
  const path = useServerPath(accountId, serverId);
  return (filter: Partial<ListFilter>) =>
    void navigate({
      to: "/app/$",
      params: { _splat: path },
      search: {
        tab: "board",
        list: filter.tab,
        state: filter.state,
        agent: filter.agentId,
        label: filter.label,
        query: filter.q,
      },
      replace: true,
      resetScroll: false,
    });
}

/** "86 of 200 tasks done", the bar, one count per state and the agent line. */
export function Summary({
  accountId,
  serverId,
  top,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly top: BoardTop;
}) {
  const segments = barSegments(top.counts);
  const go = useListNavigation(accountId, serverId);
  const path = useServerPath(accountId, serverId);
  return (
    <section className="board-panel board-summary" aria-label="Progress">
      <div className="board-summary-top">
        <h2>
          {top.total === 0
            ? "No tasks yet"
            : `${top.counts.completed.toLocaleString()} of ${top.total.toLocaleString()} ${top.total === 1 ? "task" : "tasks"} done`}
        </h2>
        {top.total > 0 && <p>{top.finishedLastHour.toLocaleString()} finished in the last hour</p>}
      </div>
      {top.total === 0 ? (
        <p className="board-summary-empty">
          Agents add tasks with create_tasks. They show here as agents claim and finish them.
        </p>
      ) : (
        <div
          className="board-bar"
          role="img"
          aria-label={segments
            .map((part) => `${part.count} ${countWord(part.key, part.count)}`)
            .join(", ")}
        >
          {segments.map((part) => (
            <span key={part.key} className={`k-${part.key}`} style={{ flexGrow: part.share }} />
          ))}
        </div>
      )}
      <div className="board-counts">
        {segments.map((part) => (
          <button
            key={part.key}
            type="button"
            className={part.key === "needs" ? "board-count you" : "board-count"}
            onClick={() => go(countFilter(part.key))}
            aria-label={`Show ${part.count} ${countWord(part.key, part.count)}`}
          >
            <i className={`k-${part.key}`} aria-hidden="true" />
            <b>{part.count.toLocaleString()}</b> {countWord(part.key, part.count)}
          </button>
        ))}
        <span className="board-agents">
          {agentSummary(top.agents)}
          <AppLink path={path} search={{ tab: "agents" }}>
            Agents <span aria-hidden="true">→</span>
          </AppLink>
        </span>
      </div>
    </section>
  );
}

/** Names and marks of the agents the Board's rows name. */
type Agents = ReadonlyMap<string, M.Participant>;

/** A finished task no agent worked on: a dash, read as "No agent". */
const noAgent = (
  <>
    <span aria-hidden="true">—</span>
    <span className="sr-only">No agent</span>
  </>
);

/** An agent's name as the Board shows it; a removed agent says so. */
const agentName = (agent: M.Participant | undefined) =>
  agent === undefined
    ? "An agent"
    : agent.removedAt === undefined
      ? agent.name
      : `${agent.name} (removed)`;

/**
 * A name as the Board shows it: a long one shortens in the middle, so names that differ only at
 * the end still differ; a removed agent says so after the name, never cut off.
 */
function AgentName({
  agent,
  fallback = "An agent",
}: {
  readonly agent: M.Participant | undefined;
  readonly fallback?: string;
}) {
  const removed = agent?.removedAt !== undefined;
  // "(removed)" takes room, so a removed agent's name keeps a shorter end.
  const [head, tail] = nameParts(agent?.name ?? fallback, removed ? 4 : 8);
  return (
    <span className="board-name">
      <span className={tail ? "board-name-head is-cut" : "board-name-head"}>{head}</span>
      {tail && <span className="board-name-tail">{tail}</span>}
      {removed && <span className="board-name-note"> (removed)</span>}
    </span>
  );
}

function Who({
  agents,
  id,
  empty = "Any worker",
}: {
  readonly agents: Agents;
  readonly id: string | null;
  readonly empty?: ReactNode;
}) {
  if (id === null) return <span className="board-muted">{empty}</span>;
  const agent = agents.get(id);
  return (
    <span className="board-who" title={agentName(agent)}>
      <ParticipantMark participant={agent} />
      <AgentName agent={agent} />
    </span>
  );
}

/** One task list row's inputs. `minute` changes once a minute, so Updated stays current. */
interface TaskRowProps {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly row: T.BoardRow;
  readonly agents: Agents;
  readonly minute: number;
}

/** The agents one row names. */
const rowAgentIds = (row: T.BoardRow) => [
  row.holderId,
  row.assigneeId,
  row.finishedById,
  ...(row.earlierHolderIds ?? []),
];

/**
 * A row renders again only when its task, one of its agents or the minute changed, so loading
 * another page of a deep list renders that page, not every row above it.
 */
const sameRow = (before: TaskRowProps, after: TaskRowProps) =>
  before.row === after.row &&
  before.minute === after.minute &&
  before.accountId === after.accountId &&
  before.serverId === after.serverId &&
  rowAgentIds(after.row).every(
    (id) => id === undefined || before.agents.get(id) === after.agents.get(id),
  );

/**
 * One task: the title is the row's link, stretched over the row. "+N" is a button above it that
 * shows the first five other agents that held a finished task, and links to the task page for
 * the rest; hovering shows them all.
 */
const TaskRow = memo(function TaskRow({ accountId, serverId, row, agents }: TaskRowProps) {
  const [open, setOpen] = useState(false);
  const list = useId();
  const state = rowState(row);
  const workers = rowWorkers(row);
  const finished = isFinished(row.state);
  const others = workers.others;
  const shown = others.slice(0, heldShown);
  return (
    <li className={`board-tr${finished ? " is-finished" : ""}${open ? " is-open" : ""}`}>
      <span className="board-n">{taskName(row.number)}</span>
      <TaskLink
        accountId={accountId}
        serverId={serverId}
        number={row.number}
        className={`board-t board-row-link${resultCount(row) === "" ? "" : " has-result"}`}
      >
        {resultCount(row) === "" ? (
          row.title
        ) : (
          <>
            <span className="board-t-text">{row.title}</span>
            <span className="board-result-count"> · {resultCount(row)}</span>
          </>
        )}
      </TaskLink>
      <span className={`board-st ${state.tone}`}>
        <i className={`k-${state.swatch}`} aria-hidden="true" />
        {state.label}
      </span>
      <span className="board-agent">
        <span className="board-agent-line">
          <Who agents={agents} id={workers.agent} empty={finished ? noAgent : "Any worker"} />
          {others.length > 0 && (
            <button
              type="button"
              className="board-held"
              aria-expanded={open}
              aria-controls={list}
              title={`Also held by ${others.map((id) => agentName(agents.get(id))).join(", ")}`}
              onClick={() => setOpen(!open)}
            >
              +{others.length}
              <span className="sr-only">
                {" "}
                {others.length === 1 ? "other agent held it" : "other agents held it"}
              </span>
            </button>
          )}
        </span>
        {others.length > 0 && (
          <ul id={list} className="board-held-list" aria-label="Also held by" hidden={!open}>
            {shown.map((id) => (
              <li key={id}>
                <Who agents={agents} id={id} />
              </li>
            ))}
            {others.length > shown.length && (
              <li>
                <TaskLink
                  accountId={accountId}
                  serverId={serverId}
                  number={row.number}
                  className="board-held-more"
                >
                  and {(others.length - shown.length).toLocaleString()} more
                </TaskLink>
              </li>
            )}
          </ul>
        )}
      </span>
      <span className="board-lb" title={row.label}>
        {row.label ?? ""}
      </span>
      <span className="board-u">
        {row.state === "waiting"
          ? "waiting on needs"
          : updatedLabel(row.finishedAt ?? row.lastNoteAt ?? row.updatedAt, new Date())}
      </span>
    </li>
  );
}, sameRow);

/** Stalled and Failed, three rows each, or one line when both are empty. */
export function Exceptions({
  accountId,
  serverId,
  top,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly top: BoardTop;
}) {
  const go = useListNavigation(accountId, serverId);
  const agents: Agents = new Map(top.participants.map((item) => [item.id, item]));
  const now = Date.now();
  const [retrying, setRetrying] = useState<number | null>(null);
  const [retried, setRetried] = useState<string | null>(null);
  const notice = retried && (
    <p className="notice board-notice" role="status">
      {retried}
    </p>
  );
  if (top.stalled.total === 0 && top.failed.total === 0)
    return (
      <>
        {notice}
        <p className="board-calm">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="m3 8.5 3 3 7-7" />
          </svg>
          Nothing stalled or failed
        </p>
      </>
    );
  const stalled = top.stalled.items.slice(0, exceptionRows);
  const failed = top.failed.items.slice(0, exceptionRows);
  return (
    <>
      {notice}
      <div className="board-pair">
        <section className="board-mini" aria-labelledby="board-stalled">
          <div className="board-section-head">
            <h3 id="board-stalled">Stalled</h3>
            <span>{top.stalled.total.toLocaleString()}</span>
            <small>Longest silence first</small>
          </div>
          <ul className="board-panel board-rows">
            {stalled.length === 0 && <li className="board-none">Nothing stalled</li>}
            {stalled.map((row) => {
              // Silent past its lease: "No update 21 h". A retry within its lease: "Attempt 2 of 3".
              const quiet = silenceLabel(row, now);
              const holder = agentName(agents.get(row.holderId ?? ""));
              return (
                <li key={row.id}>
                  <TaskLink accountId={accountId} serverId={serverId} number={row.number}>
                    <span className="board-row-title">
                      {row.title}
                      <small title={holder}>
                        {taskName(row.number)}
                        {quiet.silent ? ` · ${attemptLabel(row)}` : ""} · {holder}
                      </small>
                    </span>
                    <span className={quiet.silent ? "board-bad" : "board-quiet"}>{quiet.text}</span>
                  </TaskLink>
                </li>
              );
            })}
            <More
              count={moreCount(top.stalled.total, stalled.length)}
              show={() => go({ tab: "open", state: "stalled" })}
            />
          </ul>
        </section>
        <section className="board-mini" aria-labelledby="board-failed">
          <div className="board-section-head">
            <h3 id="board-failed">Failed</h3>
            <span>{top.failed.total.toLocaleString()}</span>
            <small>Latest first</small>
          </div>
          <ul className="board-panel board-rows">
            {failed.length === 0 && <li className="board-none">Nothing failed</li>}
            {failed.map((row) => (
              <li key={row.id} className={top.enabled ? "board-row-action" : undefined}>
                <TaskLink accountId={accountId} serverId={serverId} number={row.number}>
                  <span className="board-row-title">
                    {row.title}
                    {resultCount(row) === "" ? (
                      <small>
                        {taskName(row.number)}
                        {row.summary ? ` · ${row.summary}` : ""}
                      </small>
                    ) : (
                      // The result count stays whole; the reason shortens first.
                      <small className="has-result">
                        <span className="board-row-note">
                          {taskName(row.number)}
                          {row.summary ? ` · ${row.summary}` : ""}
                        </span>
                        <span className="board-result-count"> · {resultCount(row)}</span>
                      </small>
                    )}
                  </span>
                  <time dateTime={row.finishedAt ?? row.updatedAt}>
                    {updatedLabel(row.finishedAt ?? row.updatedAt, new Date(now))}
                  </time>
                </TaskLink>
                {top.enabled && (
                  <button
                    type="button"
                    className="ops-new"
                    aria-label={`Retry ${taskName(row.number)}`}
                    onClick={() => {
                      setRetried(null);
                      setRetrying(row.number);
                    }}
                  >
                    Retry
                  </button>
                )}
              </li>
            ))}
            <More
              count={moreCount(top.failed.total, failed.length)}
              show={() => go({ tab: "failed" })}
            />
          </ul>
        </section>
      </div>
      {retrying !== null && (
        <RetryTaskDialog
          accountId={accountId}
          serverId={serverId}
          number={retrying}
          close={() => setRetrying(null)}
          done={setRetried}
        />
      )}
    </>
  );
}

function More({ count, show }: { readonly count: number; readonly show: () => void }) {
  if (count === 0) return null;
  return (
    <li className="board-more">
      <button type="button" className="text-button" onClick={show}>
        {count.toLocaleString()} more
      </button>
    </li>
  );
}

function TaskLink({
  accountId,
  serverId,
  number,
  className,
  children,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly number: number;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <AppLink
      className={className ?? "board-row"}
      path={`${useServerPath(accountId, serverId)}/board/${taskName(number)}`}
    >
      {children}
    </AppLink>
  );
}

const stateChoices: ReadonlyArray<{ readonly value: StateFilter; readonly label: string }> = [
  { value: "claimed", label: "Working" },
  { value: "stalled", label: "Stalled" },
  { value: "ready", label: "Ready" },
  { value: "waiting", label: "Waiting" },
  { value: "blocked", label: "Needs you" },
  { value: "completed", label: "Done" },
  { value: "failed", label: "Failed" },
  { value: "canceled", label: "Canceled" },
];

const tabLabels: Record<Tab, string> = { all: "All", open: "Open", done: "Done", failed: "Failed" };

/** A URL's state filter: a stored state, or stalled. */
const stateFilter = (value: string | undefined): StateFilter | undefined =>
  value === "stalled" ? "stalled" : decoded(T.State, value);

/** One list of every task: tabs, search, filters past one page, pages of 50 as it scrolls. */
export function TaskList({
  accountId,
  serverId,
  top,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly top: BoardTop;
}) {
  const { api } = useServices();
  const user = useHuman();
  const search = useSearch({ strict: false });
  const go = useListNavigation(accountId, serverId);
  const filter: ListFilter = {
    tab: chosenTab(search.list, top.counts),
    state: stateFilter(search.state),
    agentId: decoded(M.ParticipantId, search.agent),
    label: decoded(T.Label, search.label),
    q: search.query || undefined,
  };
  const filters = showsFilters(top.total);
  const [folded, setFolded] = useState(true);
  const list = useInfiniteQuery({
    queryKey: ["human", user.id, accountId, serverId, "board-tasks", listInput(filter)],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      request(
        api.server.listBoardTasks({
          params: { serverId },
          query: input(T.BoardTasksInput, {
            ...listInput(filter),
            cursor: pageParam,
            limit: pageSize,
          }),
        }),
        signal,
      ),
    getNextPageParam: (last) => last.data.nextCursor ?? undefined,
  });
  const labelList = useQuery({
    queryKey: ["human", user.id, accountId, serverId, "board-labels"],
    enabled: filters,
    queryFn: ({ signal }) => request(api.server.listBoardLabels({ params: { serverId } }), signal),
  });
  // Refresh the loaded pages when the summary reports a change; deep lists wait for the person.
  const [behind, setBehind] = useState(false);
  const version = useRef(top.after);
  const pages = list.data?.pages.length ?? 0;
  const refetch = list.refetch;
  useEffect(() => {
    if (version.current === top.after) return;
    version.current = top.after;
    if (refreshesItself(pages)) void refetch();
    else setBehind(true);
  }, [top.after, pages, refetch]);
  const rows = list.data?.pages.flatMap((page) => page.data.items) ?? [];
  const agents: Agents = new Map(
    [
      ...top.participants,
      ...(list.data?.pages.flatMap((page) => page.included.participants) ?? []),
    ].map((item) => [item.id, item]),
  );
  const labels = [
    ...new Set([...(labelList.data?.data.items ?? []), ...(filter.label ? [filter.label] : [])]),
  ].sort();
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !hasNextPage || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage)
          void fetchNextPage();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const tabs = tabsFor(top.counts);
  const narrowed =
    filter.state !== undefined ||
    filter.agentId !== undefined ||
    filter.label !== undefined ||
    filter.q !== undefined;
  const tabCount = tabs.find((tab) => tab.key === filter.tab)?.count ?? 0;
  const minute = Math.floor(Date.now() / 60_000);
  return (
    <section className="board-panel board-tasks" aria-labelledby="board-tasks-title">
      <div className="board-tool">
        <h3 id="board-tasks-title">Tasks</h3>
        <div className="board-tabs" role="group" aria-label="Task list">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              aria-pressed={filter.state === undefined && tab.key === filter.tab}
              onClick={() => go({ ...filter, tab: tab.key, state: undefined })}
            >
              {tabLabels[tab.key]}
              <b>{tab.count.toLocaleString()}</b>
            </button>
          ))}
        </div>
        <div className="board-find">
          <FindTasks value={filter.q ?? ""} change={(q) => go({ ...filter, q: q || undefined })} />
          {filters && (
            <button
              type="button"
              className="ops-new board-filter-button"
              aria-expanded={!folded}
              onClick={() => setFolded(!folded)}
            >
              Filter
            </button>
          )}
        </div>
        {filters && (
          <div className="board-filters" data-open={folded ? undefined : ""}>
            <select
              aria-label="State"
              value={filter.state ?? ""}
              onChange={(event) =>
                go({ ...filter, state: stateFilter(event.target.value || undefined) })
              }
            >
              <option value="">Any state</option>
              {stateChoices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
            <AgentFilter
              accountId={accountId}
              serverId={serverId}
              selected={filter.agentId === undefined ? undefined : agents.get(filter.agentId)}
              change={(agentId) => go({ ...filter, agentId })}
            />
            <select
              aria-label="Label"
              value={filter.label ?? ""}
              onChange={(event) => go({ ...filter, label: event.target.value || undefined })}
            >
              <option value="">Any label</option>
              {labels.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
              {labelList.data?.data.more && (
                <option disabled value="">
                  Only the first {T.maxBoardLabels} labels are listed
                </option>
              )}
            </select>
          </div>
        )}
      </div>
      {!filters && narrowed && (filter.state !== undefined || filter.agentId !== undefined) && (
        <p className="board-narrowed">
          Showing{" "}
          {stateChoices.find((choice) => choice.value === filter.state)?.label.toLowerCase() ??
            "some"}{" "}
          tasks.{" "}
          <button
            type="button"
            className="text-button"
            onClick={() => go({ tab: filter.tab, q: filter.q })}
          >
            Show all
          </button>
        </p>
      )}
      {behind && (
        <p className="board-narrowed" role="status">
          The board changed.{" "}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setBehind(false);
              void list.refetch();
            }}
          >
            Refresh the list
          </button>
        </p>
      )}
      <div className="board-cols" aria-hidden="true">
        <span>Task</span>
        <span>Title</span>
        <span>State</span>
        <span>Agent</span>
        <span>Label</span>
        <span>Updated</span>
      </div>
      <Notice error={list.error} retry={() => void list.refetch()} />
      {list.isPending && (
        <p className="board-list-note" role="status">
          Loading tasks…
        </p>
      )}
      {!list.isPending && rows.length === 0 && !list.isError && (
        <p className="board-list-note">
          {narrowed
            ? "No tasks match."
            : `No ${filter.tab === "all" ? "" : `${tabLabels[filter.tab].toLowerCase()} `}tasks.`}
        </p>
      )}
      <ul className="board-list">
        {rows.map((row) => (
          <TaskRow
            key={row.id}
            accountId={accountId}
            serverId={serverId}
            row={row}
            agents={agents}
            minute={minute}
          />
        ))}
      </ul>
      <div ref={sentinel} />
      {rows.length > 0 && (
        <div className="board-foot">
          <span>
            Showing {rows.length.toLocaleString()}
            {narrowed
              ? ""
              : ` of ${tabCount.toLocaleString()}${filter.tab === "all" ? "" : ` ${filter.tab}`}`}
            {list.hasNextPage ? " · scroll for more" : ""}
          </span>
          {list.hasNextPage ? (
            <button
              type="button"
              className="text-button"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {list.isFetchingNextPage ? "Loading…" : "Show more"}
            </button>
          ) : (
            <span>
              {filter.tab === "open" || filter.tab === "all"
                ? "Sorted by state, then priority"
                : "Latest first"}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The agent filter: type a name and pick one of the matching agents the server finds (removed
 * ones too), however many agents the server has. Clearing it shows every agent's tasks.
 */
function AgentFilter({
  accountId,
  serverId,
  selected,
  change,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly selected: M.Participant | undefined;
  readonly change: (agentId: string | undefined) => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const options = useId();
  const name = selected?.name ?? "";
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const [term, setTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTerm(draft.trim()), 250);
    return () => clearTimeout(timer);
  }, [draft]);
  const found = useQuery({
    queryKey: ["human", user.id, accountId, serverId, "board-agent-search", term],
    queryFn: ({ signal }) =>
      request(
        api.server.listParticipants({
          params: { serverId },
          query: input(I.ListParticipants, {
            query: term || undefined,
            state: "all",
            limit: 20,
          }),
        }),
        signal,
      ),
    placeholderData: keepPreviousData,
  });
  const agents = (found.data?.data.items ?? []).filter((item) => item.kind !== "person");
  return (
    <>
      <input
        type="search"
        className="board-agent-filter"
        aria-label="Agent"
        placeholder="Any agent"
        list={options}
        value={draft}
        maxLength={64}
        autoComplete="off"
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const wanted = text.trim().toLowerCase();
          if (wanted === "") change(undefined);
          else {
            const match = agents.find((item) => item.name.toLowerCase() === wanted);
            if (match) change(match.id);
          }
        }}
      />
      <datalist id={options}>
        {agents.map((item) => (
          <option key={item.id} value={item.name} />
        ))}
      </datalist>
    </>
  );
}

/** Search waits for a pause in typing; the server matches titles and task numbers. */
function FindTasks({
  value,
  change,
}: {
  readonly value: string;
  readonly change: (q: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const latest = useRef(change);
  useEffect(() => {
    latest.current = change;
  }, [change]);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft.trim() === value) return;
    const timer = setTimeout(() => latest.current(draft.trim()), 300);
    return () => clearTimeout(timer);
  }, [draft, value]);
  return (
    <input
      type="search"
      aria-label="Find tasks"
      placeholder="Find tasks"
      value={draft}
      maxLength={200}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
}

/** One task's page: header, thread and side panel, with Cancel as its one action (phase 1). */
/** One task's page, read as the person; the task page and Retry share it. */
function useBoardTask(accountId: P.AccountId, serverId: M.ServerId, number: number | null) {
  const { api } = useServices();
  const user = useHuman();
  return useQuery({
    queryKey: ["human", user.id, accountId, serverId, "board-task", number],
    enabled: number !== null,
    queryFn: ({ signal }) =>
      request(
        api.server.getBoardTask({ params: { serverId, task: number ?? 0 }, query: {} }),
        signal,
      ),
  });
}

export function TaskPage({
  accountId,
  server,
  number,
}: {
  readonly accountId: P.AccountId;
  readonly server: P.ServerContext;
  readonly number: number | null;
}) {
  const path = useServerPath(accountId, server.id);
  const board = useBoard(accountId, server.id);
  const detail = useBoardTask(accountId, server.id, number);
  // A Board change refreshes the open task too.
  const version = board.data?.after;
  const refetch = detail.refetch;
  const seen = useRef(version);
  useEffect(() => {
    if (seen.current === version) return;
    seen.current = version;
    void refetch();
  }, [version, refetch]);
  const [canceling, setCanceling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retried, setRetried] = useState<string | null>(null);
  const back = (
    <p className="task-crumb">
      <AppLink path={path} search={{ tab: "board" }}>
        Board
      </AppLink>
      <span aria-hidden="true">/</span>
      {number === null ? "Task" : taskName(number)}
    </p>
  );
  if (number === null)
    return (
      <>
        {back}
        <p className="ops-empty">This task link is not valid.</p>
      </>
    );
  const data = detail.data;
  if (!data)
    return (
      <>
        {back}
        <Notice error={detail.error} retry={() => void detail.refetch()} />
        {detail.isPending && (
          <p className="ops-empty" role="status">
            Loading task…
          </p>
        )}
      </>
    );
  const { task } = data.data;
  const people: Agents = new Map(data.included.participants.map((item) => [item.id, item]));
  // A removed agent says so here too, as on the list.
  const name = (id: string | undefined) => {
    const agent = id === undefined ? undefined : people.get(id);
    return agent === undefined ? undefined : agentName(agent);
  };
  const state = rowState({ state: task.state, stalled: false });
  const enabled = board.data?.enabled ?? true;
  const finished = isFinished(task.state);
  const lastNote = task.claim
    ? ([...data.data.thread.items]
        .reverse()
        .find((message) => message.senderId === task.claim?.holderId)?.createdAt ??
      task.claim.claimedAt)
    : undefined;
  const silent =
    lastNote !== undefined &&
    Date.now() - new Date(lastNote).getTime() > T.defaultLeaseSeconds * 1000;
  return (
    <div className="task-page">
      {back}
      <Notice error={detail.error} stale />
      <header className="task-head">
        <h2>
          <span className="task-number">{taskName(task.number)}</span>
          {task.title}
        </h2>
        {!finished && enabled && (
          <button type="button" className="ops-new" onClick={() => setCanceling(true)}>
            Cancel task
          </button>
        )}
        {task.state === "failed" && enabled && (
          <button
            type="button"
            className="ops-new"
            onClick={() => {
              setRetried(null);
              setRetrying(true);
            }}
          >
            Retry
          </button>
        )}
      </header>
      {retried && (
        <p className="notice board-notice" role="status">
          {retried}
        </p>
      )}
      <dl className="task-facts">
        <div>
          <dt>State</dt>
          <dd className={`board-st ${state.tone}`}>
            <i className={`k-${state.swatch}`} aria-hidden="true" />
            {state.label}
          </dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>{task.priority[0]?.toUpperCase() + task.priority.slice(1)}</dd>
        </div>
        <div>
          <dt>Labels</dt>
          <dd>{task.labels.length ? task.labels.join(", ") : "None"}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>
            <Person people={people} id={task.ownerId} />
          </dd>
        </div>
        <div>
          <dt>Assignee</dt>
          <dd>
            {task.assigneeId ? <Person people={people} id={task.assigneeId} /> : "Any worker"}
          </dd>
        </div>
        {task.claim && (
          <div>
            <dt>Holder</dt>
            <dd>
              <Person people={people} id={task.claim.holderId} />
            </dd>
          </div>
        )}
        {task.claim && lastNote !== undefined && (
          <div>
            <dt>Last update</dt>
            <dd className={silent ? "board-bad" : undefined}>
              {silent
                ? `No update ${silenceFor(Math.floor((Date.now() - new Date(lastNote).getTime()) / 60_000))}`
                : updatedLabel(lastNote, new Date())}
            </dd>
          </div>
        )}
      </dl>
      {task.outcome?.summary !== undefined && (
        <TaskResult
          serverId={server.id}
          outcome={{ ...task.outcome, summary: task.outcome.summary }}
          by={name(finisher(data.data.events, task.outcome.kind))}
          refresh={() => void detail.refetch()}
        />
      )}
      <div className="task-body">
        <section className="board-panel task-thread" aria-label="Thread, oldest first">
          {data.data.thread.nextCursor && (
            <p className="board-list-note">Older notes are not shown.</p>
          )}
          <ol>
            {data.data.thread.items.map((message) => (
              <li key={message.id}>
                <div className="task-message-head">
                  <ParticipantMark participant={people.get(message.senderId)} />
                  <span
                    className="task-sender"
                    title={people.get(message.senderId)?.name ?? "Someone"}
                  >
                    <AgentName agent={people.get(message.senderId)} fallback="Someone" />
                  </span>
                  {message.task && (
                    <span className="task-kind">{kindLabel(message.task.kind)}</span>
                  )}
                  <time dateTime={message.createdAt}>{formatFeedTime(message.createdAt)}</time>
                </div>
                <MessageBody body={message.body} />
                {message.transfer && <TransferChip transfer={message.transfer} />}
              </li>
            ))}
          </ol>
        </section>
        <aside className="task-side">
          <TaskRefs
            title="Needs"
            items={data.data.needs}
            accountId={accountId}
            serverId={server.id}
            empty="Nothing"
          />
          <TaskRefs
            title="Needed by"
            items={data.data.neededBy}
            accountId={accountId}
            serverId={server.id}
            empty="Nothing"
          />
          <section>
            <h3>Attempts</h3>
            <p>
              {attemptsUsed(task)} of {task.maxAttempts}
            </p>
          </section>
          {task.decision && (
            <section>
              <h3>Decision</h3>
              <p>
                {task.decision.kind[0]?.toUpperCase() + task.decision.kind.slice(1)} by{" "}
                {name(task.decision.byId) ?? "a person"}, {formatFeedTime(task.decision.at)}
              </p>
            </section>
          )}
          <section>
            <h3>Events</h3>
            {data.data.events.length >= T.taskEvents && (
              <p className="board-muted">The latest {T.taskEvents.toLocaleString()} events.</p>
            )}
            <ol className="task-events">
              {data.data.events.map((event) => (
                <li key={event.id}>
                  <span>
                    {eventText(event, name)}
                    {eventResult(event) === "" ? "" : ` · ${eventResult(event)}`}
                  </span>
                  <time dateTime={event.at}>{formatFeedTime(event.at)}</time>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
      {canceling && (
        <CancelTaskDialog
          accountId={accountId}
          serverId={server.id}
          task={task}
          holder={name(task.claim?.holderId)}
          close={() => setCanceling(false)}
        />
      )}
      {retrying && (
        <RetryTaskDialog
          accountId={accountId}
          serverId={server.id}
          number={task.number}
          close={() => setRetrying(false)}
          done={setRetried}
        />
      )}
    </div>
  );
}

function Person({ people, id }: { readonly people: Agents; readonly id: string }) {
  const item = people.get(id);
  return (
    <span className="board-who" title={agentName(item)}>
      {item ? <ParticipantMark participant={item} /> : <AgentIcon type="" />}
      <AgentName agent={item} />
    </span>
  );
}

function TaskRefs({
  title,
  items,
  accountId,
  serverId,
  empty,
}: {
  readonly title: string;
  readonly items: ReadonlyArray<T.TaskSummary>;
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly empty: string;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, refsShown);
  return (
    <section>
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="board-muted">{empty}</p>
      ) : (
        <ul>
          {shown.map((item) => {
            const state = rowState({ state: item.state, stalled: false });
            return (
              <li key={item.id}>
                <TaskLink
                  accountId={accountId}
                  serverId={serverId}
                  number={item.number}
                  className="task-ref"
                >
                  <span className="board-n">{taskName(item.number)}</span>
                  <span className="task-ref-title" title={item.title}>
                    {item.title}
                  </span>
                  <span className={`board-st ${state.tone}`}>
                    <i className={`k-${state.swatch}`} aria-hidden="true" />
                    {state.label}
                  </span>
                </TaskLink>
              </li>
            );
          })}
        </ul>
      )}
      {items.length > shown.length && (
        <button type="button" className="text-button" onClick={() => setAll(true)}>
          Show all {items.length.toLocaleString()}
        </button>
      )}
    </section>
  );
}

/** The agent whose event finished the task as `kind`: the latest such event's actor. */
function finisher(events: ReadonlyArray<T.TaskEvent>, kind: string) {
  for (let index = events.length - 1; index >= 0; index -= 1)
    if (events[index]?.kind === kind) return events[index]?.actor.participantId;
  return undefined;
}

/** Thread message kinds, as their tags read. */
const kindLabels = new Map([
  ["brief", "Brief"],
  ["note", "Note"],
  ["question", "Question"],
  ["answer", "Answer"],
  ["decision", "Decision"],
  ["result", "Result"],
  ["failure", "Failure"],
  ["cancel", "Canceled"],
]);
/** A thread message's kind, as its tag reads. */
export function kindLabel(kind: string) {
  return kindLabels.get(kind) ?? "Message";
}

/** Task event kinds, as the side panel's timeline reads them. */
const eventLabels = new Map([
  ["created", "Created"],
  ["ready", "Ready"],
  ["claimed", "Claimed"],
  ["released", "Released"],
  ["expired", "Lease ran out"],
  ["blocked", "Asked a person"],
  ["unblocked", "Answered"],
  ["completed", "Completed"],
  ["failed", "Failed"],
  ["canceled", "Canceled"],
  ["assigned", "Assigned"],
  ["reprioritized", "Priority changed"],
  ["reopened", "Retried"],
  ["batch_finished", "Batch finished"],
]);
/** A task event, as the side panel's timeline reads it. */
export function eventLabel(kind: string) {
  return eventLabels.get(kind) ?? kind;
}

/** System moves whose reason says more than their kind: "Canceled: a task it needs failed". */
const systemEvents = new Map([
  ["canceled:need_failed", "Canceled: a task it needs failed"],
  ["canceled:participant_removed", "Canceled: its agent was removed"],
  ["canceled:board_off", "Canceled: the board was turned off"],
  ["reopened:need_reopened", "Waiting again: a task it needs was retried"],
  ["failed:attempts_exhausted", "Failed: no attempts left"],
]);

/**
 * One timeline line: "Claimed by api-worker", "Retried by Alice" (a person or the owner agent);
 * system moves name nobody and say why when the reason adds something.
 */
export function eventText(
  event: Pick<T.TaskEvent, "kind" | "reason" | "actor">,
  name: (id: string | undefined) => string | undefined,
) {
  const who = event.actor.name ?? name(event.actor.participantId);
  if (event.actor.kind === "system" || event.kind === "ready" || who === undefined)
    return systemEvents.get(`${event.kind}:${event.reason ?? ""}`) ?? eventLabel(event.kind);
  return `${eventLabel(event.kind)} by ${who}`;
}

/** Cancel one unfinished task, with an optional reason posted to its thread. */
export function CancelTaskDialog({
  accountId,
  serverId,
  task,
  holder,
  close,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly task: T.Task;
  readonly holder: string | undefined;
  readonly close: () => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const cache = useQueryClient();
  const field = useId();
  const [reason, setReason] = useState("");
  // One request key per dialog: a retry after an uncertain answer is the same cancel.
  const [requestKey] = useState(() => crypto.randomUUID());
  const scope = ["human", user.id, accountId, serverId] as const;
  const cancel = useMutation({
    mutationFn: () =>
      request(
        api.server.cancelTask({
          params: { serverId, taskId: task.id },
          payload: input(T.CancelTask, {
            expectedRevision: task.revision,
            requestKey,
            reason: reason.trim() || undefined,
          }),
        }),
      ),
    onSettled: async () => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: [...scope, "board-task"] }),
        cache.invalidateQueries({ queryKey: [...scope, "board"] }),
        cache.invalidateQueries({ queryKey: [...scope, "board-tasks"] }),
      ]);
    },
    onSuccess: close,
  });
  const conflict =
    cancel.error instanceof ApiError && cancel.error.code === "revision_conflict"
      ? new ApiError("revision_conflict", "This task changed. Check it and try again.")
      : cancel.error;
  return (
    <Dialog title={`Cancel ${taskName(task.number)}?`} close={close}>
      <form
        className="task-cancel"
        onSubmit={(event) => {
          event.preventDefault();
          if (!cancel.isPending) cancel.mutate();
        }}
      >
        <p>
          {holder
            ? `${holder} is working on it and is told to stop. `
            : "No agent will pick it up. "}
          Tasks that need it are canceled too. The task and its thread stay on the Board.
        </p>
        <label htmlFor={field}>Reason (optional, posted to the task’s thread)</label>
        <textarea
          id={field}
          rows={3}
          maxLength={4000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={cancel.isPending}
        />
        <Notice error={conflict} />
        <div className="ops-delete-actions">
          <button type="button" className="ops-new" onClick={close}>
            Keep task
          </button>
          <button
            type="submit"
            className="ops-danger"
            disabled={cancel.isPending || conflict !== null}
          >
            {cancel.isPending ? "Canceling…" : "Cancel task"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Retry (reopen) one failed task: it returns to the queue, or waits for its needs, with its
 * attempts reset, and the tasks canceled because it failed wait again. `done` gets the notice.
 */
export function RetryTaskDialog({
  accountId,
  serverId,
  number,
  close,
  done,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly number: number;
  readonly close: () => void;
  readonly done: (notice: string) => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const cache = useQueryClient();
  const field = useId();
  const detail = useBoardTask(accountId, serverId, number);
  const [note, setNote] = useState("");
  // One request key per dialog: a retry after an uncertain answer is the same reopen.
  const [requestKey] = useState(() => crypto.randomUUID());
  const scope = ["human", user.id, accountId, serverId] as const;
  const task = detail.data?.data.task;
  const reopen = useMutation({
    mutationFn: (failed: T.Task) =>
      request(
        api.server.reopenTask({
          params: { serverId, taskId: failed.id },
          payload: input(T.ReopenTask, {
            expectedRevision: failed.revision,
            requestKey,
            note: note.trim() || undefined,
          }),
        }),
      ),
    onSettled: async () => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: [...scope, "board-task"] }),
        cache.invalidateQueries({ queryKey: [...scope, "board"] }),
        cache.invalidateQueries({ queryKey: [...scope, "board-tasks"] }),
      ]);
    },
    onSuccess: (result) => {
      done(retriedNotice(result.data));
      close();
    },
  });
  const failure =
    reopen.error instanceof ApiError && reopen.error.code === "revision_conflict"
      ? new ApiError("revision_conflict", "This task changed. Check it and try again.")
      : reopen.error instanceof ApiError && reopen.error.code === "task_state_conflict"
        ? new ApiError("task_state_conflict", "This task is no longer failed.")
        : reopen.error;
  const stillFailed = task === undefined || task.state === "failed";
  return (
    <Dialog title={`Retry ${taskName(number)}?`} close={close}>
      <form
        className="task-cancel"
        onSubmit={(event) => {
          event.preventDefault();
          if (task && !reopen.isPending) reopen.mutate(task);
        }}
      >
        <Notice error={detail.data ? null : detail.error} />
        {detail.isPending && <p role="status">Loading task…</p>}
        {detail.data && (
          <p>
            {stillFailed
              ? `${retryEffect(retryPlan(detail.data.data))} Its attempts start over.`
              : "This task is no longer failed."}
          </p>
        )}
        <label htmlFor={field}>Note (optional, posted to the task’s thread)</label>
        <textarea
          id={field}
          rows={3}
          maxLength={4000}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={reopen.isPending}
        />
        <Notice error={failure} />
        <div className="ops-delete-actions">
          <button type="button" className="ops-new" onClick={close}>
            Not now
          </button>
          <button
            type="submit"
            className="ops-new primary"
            disabled={!task || !stillFailed || reopen.isPending || failure !== null}
          >
            {reopen.isPending ? "Retrying…" : "Retry task"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Settings: the claim cap (spec 8.3), the most tasks claimed at once; empty is no cap. New Free
 * swarm servers start at 4. Only the server's creator changes it.
 */
function ClaimCapSetting({
  server,
  current,
  creator,
}: {
  readonly server: P.ServerContext;
  readonly current: number | null;
  readonly creator: boolean;
}) {
  const { api } = useServices();
  const user = useHuman();
  const cache = useQueryClient();
  const hint = useId();
  const [value, setValue] = useState(current === null ? "" : String(current));
  const cap = value.trim() === "" ? null : Number(value);
  const valid = cap === null || (Number.isInteger(cap) && cap >= 1 && cap <= 100);
  const save = useMutation({
    mutationFn: (claimCap: number | null) =>
      request(
        api.server.setBoard({
          params: { serverId: server.id },
          payload: { enabled: true, claimCap },
        }),
      ),
    onSuccess: () =>
      cache.invalidateQueries({ queryKey: boardKey(user.id, server.accountId, server.id) }),
  });
  const unchanged = cap === current;
  return (
    <form
      className="board-setting-cap"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !unchanged && !save.isPending) save.mutate(cap);
      }}
    >
      <label>
        At most{" "}
        <input
          name="claimCap"
          type="number"
          inputMode="numeric"
          min={1}
          max={100}
          step={1}
          placeholder="any"
          value={value}
          disabled={!creator || save.isPending}
          aria-describedby={hint}
          onChange={(event) => setValue(event.target.value)}
        />{" "}
        tasks worked on at once
      </label>
      <button
        type="submit"
        className="ops-new"
        disabled={!creator || !valid || unchanged || save.isPending}
      >
        {save.isPending ? "Saving…" : "Save"}
      </button>
      <small id={hint}>
        {valid
          ? "Leave it empty for no cap. Past the cap, agents wait until a claimed task ends."
          : "Enter a whole number from 1 to 100, or leave it empty for no cap."}
      </small>
      <Notice error={save.error} />
    </form>
  );
}

/**
 * Settings: swarm memory (spec 14), part of every swarm, with no switch. Until TalkTo sets it up
 * (at the first claim, read or context that needs it), the server's creator can start it from
 * another swarm's memory instead of TalkTo's template.
 */
function MemorySetting({
  server,
  memory,
  creator,
}: {
  readonly server: P.ServerContext;
  readonly memory: { readonly started: boolean };
  readonly creator: boolean;
}) {
  const { api } = useServices();
  const user = useHuman();
  const cache = useQueryClient();
  const sourceField = useId();
  const sourceHint = useId();
  const [from, setFrom] = useState("");
  const swarms = useQuery({
    queryKey: ["human", user.id, server.accountId, "servers", "memory-sources"],
    enabled: creator && !memory.started,
    queryFn: ({ signal }) =>
      request(
        api.platform.managedServers({
          params: { accountId: server.accountId },
          query: input(P.ServerListing, { limit: 100 }),
        }),
        signal,
      ),
  });
  const sources = (swarms.data?.data.items ?? []).filter(
    (item) => item.board === true && item.id !== server.id,
  );
  const source = sources.find((item) => item.id === from);
  const copy = useMutation({
    mutationFn: (serverId: M.ServerId) =>
      request(
        api.server.setBoard({
          params: { serverId: server.id },
          payload: { memory: { from: serverId } },
        }),
      ),
    onSuccess: () =>
      cache.invalidateQueries({ queryKey: boardKey(user.id, server.accountId, server.id) }),
  });
  return (
    <div className="board-setting-memory">
      <p className="board-setting-about">
        <strong>Swarm memory</strong>
        <small>
          Agents get the swarm’s norms, decisions and known traps with each task they claim, and
          keep them current with Git.
        </small>
      </p>
      {creator && !memory.started && sources.length > 0 && (
        <form
          className="board-setting-source"
          onSubmit={(event) => {
            event.preventDefault();
            if (source !== undefined) copy.mutate(source.id);
          }}
        >
          <label htmlFor={sourceField}>Start from another swarm’s memory</label>
          <select
            id={sourceField}
            value={from}
            disabled={copy.isPending}
            aria-describedby={sourceHint}
            onChange={(event) => setFrom(event.target.value)}
          >
            <option value="">No, start from TalkTo’s template</option>
            {sources.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="ops-new"
            disabled={source === undefined || copy.isPending}
          >
            {copy.isPending ? "Copying…" : "Copy memory"}
          </button>
          <small id={sourceHint}>
            Copies that swarm’s memory, before agents start this one from TalkTo’s template. After
            that, the two change separately.
          </small>
        </form>
      )}
      <Notice error={copy.error} />
    </div>
  );
}

/** Settings: the Board switch (spec 9.5). Only the server's creator changes it. */
export function BoardSwitch({ server }: { readonly server: P.ServerContext }) {
  const { api } = useServices();
  const user = useHuman();
  const cache = useQueryClient();
  const hint = useId();
  const offered = useBoardsOffered();
  const creator = server.createdBy === user.id;
  const on = server.board === true;
  const board = useBoard(server.accountId, server.id, offered && on);
  const [confirming, setConfirming] = useState(false);
  const channelId = board.data?.channelId;
  const channel = useQuery({
    queryKey: ["human", user.id, server.accountId, server.id, "conversation", channelId],
    queryFn:
      channelId === undefined
        ? skipToken
        : ({ signal }) =>
            request(
              api.server.getConversation({
                params: { serverId: server.id, conversationId: channelId },
              }),
              signal,
            ),
  });
  const change = useMutation({
    mutationFn: (enabled: boolean) =>
      request(api.server.setBoard({ params: { serverId: server.id }, payload: { enabled } })),
    onSuccess: async () => {
      setConfirming(false);
      await Promise.all([
        cache.invalidateQueries({
          queryKey: ["human", user.id, server.accountId, server.id, "management"],
        }),
        cache.invalidateQueries({
          queryKey: ["human", user.id, server.accountId, server.id, "board"],
        }),
        cache.invalidateQueries({ queryKey: ["human", user.id, server.accountId, "servers"] }),
      ]);
    },
  });
  if (!offered) return null;
  const working = board.data?.counts.claimed ?? 0;
  return (
    <section className="ops-server-settings board-setting" aria-labelledby="board-setting-title">
      <h2 id="board-setting-title">Board</h2>
      <label className="board-switch">
        <input
          type="checkbox"
          role="switch"
          checked={on}
          disabled={!creator || change.isPending}
          aria-describedby={hint}
          onChange={(event) => {
            if (event.target.checked) change.mutate(true);
            else setConfirming(true);
          }}
        />
        <span>
          <strong>Task board</strong>
          <small id={hint}>
            Agents can create, claim and complete tasks on this server. People answer their
            questions on the Board.
            {!creator && " Only the person who created this server can turn it on or off."}
          </small>
        </span>
      </label>
      {on && board.data?.channelId !== undefined && (
        <p className="board-setting-channel">
          Board channel{" "}
          <span className="board-name">
            #{channel.data?.data.kind === "channel" ? channel.data.data.name : "board"}
          </span>{" "}
          keeps every task’s thread.
        </p>
      )}
      {on && board.data !== undefined && (
        <ClaimCapSetting
          key={board.data.claimCap ?? 0}
          server={server}
          current={board.data.claimCap ?? null}
          creator={creator}
        />
      )}
      {on && board.data?.memory !== undefined && (
        <MemorySetting server={server} memory={board.data.memory} creator={creator} />
      )}
      <Notice error={change.error} />
      {confirming && (
        <Dialog title="Turn off the board?" close={() => setConfirming(false)}>
          <p>
            {working > 0
              ? `${working.toLocaleString()} ${working === 1 ? "task is" : "tasks are"} being worked on. ${working === 1 ? "It" : "They"} will be released. `
              : ""}
            Tasks and their threads stay, and come back when you turn it on.
          </p>
          <Notice error={change.error} />
          <div className="ops-delete-actions">
            <button type="button" className="ops-new" onClick={() => setConfirming(false)}>
              Keep it on
            </button>
            <button
              type="button"
              className="ops-danger"
              disabled={change.isPending}
              onClick={() => change.mutate(false)}
            >
              {change.isPending ? "Turning off…" : "Turn off"}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
