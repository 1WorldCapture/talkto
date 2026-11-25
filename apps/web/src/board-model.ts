import type * as T from "@talkto/api/tasks";

/*
  The Board's rules (docs/swarm-server-spec.md, 9.2), as plain functions so they are tested
  without rendering (test/board.test.mjs): the summary's bar and counts, the agent line, the
  three-row caps, the task list's tabs and filters, and how one row reads.
*/

/** At most this many tasks, the list opens on All and shows no filters; above it, Open and filters. */
export const smallBoard = 50;
/** Rows the Stalled and Failed lists show before "N more". */
export const exceptionRows = 3;
/** Earlier holders "+N" opens before "and N more", which links to the task page. */
export const heldShown = 5;
/** Tasks the task page's Needs and Needed by show before "Show all". */
export const refsShown = 10;
/** The smallest share of the bar a state with any task gets, so one task never disappears. */
export const minShare = 0.004;

/** A state as the summary shows it. Working is claimed; needs you is blocked. */
export type Swatch = "done" | "failed" | "canceled" | "working" | "needs" | "ready" | "waiting";

/** Board-wide counts per stored state. */
type Counts = T.Counts;

/** The summary's states in the bar's order, each with the stored state it counts. */
const order: ReadonlyArray<{ readonly key: Swatch; readonly state: keyof Counts }> = [
  { key: "done", state: "completed" },
  { key: "failed", state: "failed" },
  { key: "canceled", state: "canceled" },
  { key: "working", state: "claimed" },
  { key: "needs", state: "blocked" },
  { key: "ready", state: "ready" },
  { key: "waiting", state: "waiting" },
];

/** One part of the bar and of the counts line. `share` is its part of the bar's width. */
export interface Segment {
  readonly key: Swatch;
  readonly count: number;
  readonly share: number;
}

/** Every task on the board, finished ones included. */
export const totalOf = (counts: Counts) =>
  counts.waiting +
  counts.ready +
  counts.claimed +
  counts.blocked +
  counts.completed +
  counts.failed +
  counts.canceled;

/** Tasks in the Open tab: waiting, ready, claimed and blocked. */
export const openOf = (counts: Counts) =>
  counts.waiting + counts.ready + counts.claimed + counts.blocked;

/**
 * The bar's parts, in order, for each state that has tasks. Each part is proportional, except
 * that a state with any task gets at least `minShare`, taken from the largest parts.
 */
export function barSegments(counts: Counts): ReadonlyArray<Segment> {
  const total = totalOf(counts);
  if (total === 0) return [];
  const present = order.filter(({ state }) => counts[state] > 0);
  const raw = present.map(({ key, state }) => ({ key, count: counts[state] }));
  const small = raw.filter((part) => part.count / total < minShare);
  const lifted = small.reduce((sum, part) => sum + (minShare - part.count / total), 0);
  const large = raw.filter((part) => part.count / total >= minShare);
  const largeTotal = large.reduce((sum, part) => sum + part.count, 0);
  return raw.map((part) => ({
    ...part,
    share:
      part.count / total < minShare
        ? minShare
        : part.count / total - (largeTotal === 0 ? 0 : (lifted * part.count) / largeTotal),
  }));
}

/** The word after a count on the counts line: "3 need you", "1 needs you", "86 done". */
export function countWord(key: Swatch, count: number) {
  if (key === "needs") return count === 1 ? "needs you" : "need you";
  return key;
}

/** What the task list shows when a count on the summary is clicked. */
export interface CountFilter {
  readonly tab: Tab;
  readonly state?: T.State;
}

/** The list a count on the summary opens. */
export function countFilter(key: Swatch): CountFilter {
  switch (key) {
    case "done":
      return { tab: "done" };
    case "failed":
      return { tab: "failed" };
    case "canceled":
      return { tab: "all", state: "canceled" };
    case "working":
      return { tab: "open", state: "claimed" };
    case "needs":
      return { tab: "open", state: "blocked" };
    case "ready":
      return { tab: "open", state: "ready" };
    case "waiting":
      return { tab: "open", state: "waiting" };
  }
}

/** The agent line: "400 agents · 14 stalled · 24 idle", "2 agents · both working". */
export function agentSummary(agents: {
  readonly total: number;
  readonly working: number;
  readonly stalled: number;
  readonly idle: number;
}) {
  const { total, stalled, idle } = agents;
  if (total === 0) return "No agents yet";
  const parts = [`${total.toLocaleString()} ${total === 1 ? "agent" : "agents"}`];
  if (stalled > 0) parts.push(`${stalled.toLocaleString()} stalled`);
  if (idle > 0)
    parts.push(idle === total && total > 1 ? "all idle" : `${idle.toLocaleString()} idle`);
  else if (stalled === 0)
    parts.push(total === 1 ? "working" : total === 2 ? "both working" : "all working");
  return parts.join(" · ");
}

/** How many rows a capped list leaves out: its "N more", or 0 when it shows them all. */
export const moreCount = (total: number, shown: number) => Math.max(0, total - shown);

/** The task list's tabs. */
export type Tab = "all" | "open" | "done" | "failed";

/** The tabs a board of this size offers, with their counts. */
export function tabsFor(
  counts: Counts,
): ReadonlyArray<{ readonly key: Tab; readonly count: number }> {
  const total = totalOf(counts);
  const tabs: Array<{ readonly key: Tab; readonly count: number }> = [];
  if (total <= smallBoard) tabs.push({ key: "all", count: total });
  tabs.push({ key: "open", count: openOf(counts) }, { key: "done", count: counts.completed });
  if (total > smallBoard || counts.failed > 0) tabs.push({ key: "failed", count: counts.failed });
  return tabs;
}

/** The tab the list opens on: All for a small board, Open above it. */
export const defaultTab = (total: number): Tab => (total <= smallBoard ? "all" : "open");

/** Whether the state, agent and label filters are shown: only past one page of tasks. */
export const showsFilters = (total: number) => total > smallBoard;

/** A URL's tab, kept only when this board offers it. */
export function chosenTab(value: string | undefined, counts: Counts): Tab {
  const offered = tabsFor(counts).map((tab) => tab.key);
  const found = offered.find((tab) => tab === value);
  return found ?? defaultTab(totalOf(counts));
}

/** The state filter: a stored state, or stalled (claimed and silent, or on a retry). */
export type StateFilter = T.State | "stalled";

/** The task list's filters, as the URL and the controls hold them. */
export interface ListFilter {
  readonly tab: Tab;
  readonly state?: StateFilter | undefined;
  readonly agentId?: string | undefined;
  readonly label?: string | undefined;
  readonly q?: string | undefined;
}

/**
 * The Board task list request for a filter. A state filter reads every view, so a state outside
 * the tab (such as canceled) still lists its tasks; stalled is its own view.
 */
export function listInput(filter: ListFilter) {
  return {
    view: filter.state === "stalled" ? "stalled" : filter.state === undefined ? filter.tab : "all",
    state: filter.state === "stalled" ? undefined : filter.state,
    agentId: filter.agentId,
    label: filter.label,
    q: filter.q,
  } as const;
}

/** A row's state as the list shows it: its words, its swatch, and whether it needs a person. */
export interface RowState {
  readonly label: string;
  readonly swatch: Swatch | "stalled";
  readonly tone: "you" | "bad" | "plain";
}

/**
 * How one row's state reads. A stalled row whose holder is still within its lease is a retry
 * ("Attempt 2 of 3"), not yet "No update".
 */
export function rowState(
  row: Pick<T.BoardRow, "state" | "stalled"> &
    Partial<Pick<T.BoardRow, "silent" | "attempts" | "maxAttempts">>,
): RowState {
  if (row.state === "claimed" && row.stalled && row.silent === false)
    return {
      label: capitalized(
        attemptLabel({ attempts: row.attempts ?? 0, maxAttempts: row.maxAttempts ?? 0 }),
      ),
      swatch: "working",
      tone: "plain",
    };
  if (row.state === "claimed" && row.stalled)
    return { label: "No update", swatch: "stalled", tone: "bad" };
  switch (row.state) {
    case "blocked":
      return { label: "Needs you", swatch: "needs", tone: "you" };
    case "claimed":
      return { label: "Working", swatch: "working", tone: "plain" };
    case "ready":
      return { label: "Ready", swatch: "ready", tone: "plain" };
    case "waiting":
      return { label: "Waiting", swatch: "waiting", tone: "plain" };
    case "completed":
      return { label: "Done", swatch: "done", tone: "plain" };
    case "failed":
      return { label: "Failed", swatch: "failed", tone: "bad" };
    default:
      return { label: "Canceled", swatch: "canceled", tone: "plain" };
  }
}

/** Whether a task has finished: completed, failed or canceled. */
export const isFinished = (state: string) =>
  state === "completed" || state === "failed" || state === "canceled";

/** The agents a row's Agent column names: one agent, and the others behind "+N". */
export interface RowWorkers {
  readonly agent: string | null;
  readonly others: ReadonlyArray<string>;
}

/**
 * The Agent column. An unfinished task names its holder, else its assignee, else nobody ("Any
 * worker"). A finished task names the agent that finished it (the claimer that completed or failed
 * it, or the owner agent that canceled it), with "+N" for the agents that held it before. When no
 * agent finished it (a person canceled it, a failed need canceled it, or it ran out of attempts),
 * it names its latest holder, if any; a task never claimed names nobody.
 */
export function rowWorkers(
  row: Pick<T.BoardRow, "state" | "holderId" | "assigneeId" | "finishedById" | "earlierHolderIds">,
): RowWorkers {
  if (!isFinished(row.state)) return { agent: row.holderId ?? row.assigneeId ?? null, others: [] };
  const earlier = row.earlierHolderIds ?? [];
  if (row.finishedById !== undefined) return { agent: row.finishedById, others: earlier };
  const [latest, ...rest] = earlier;
  return { agent: latest ?? null, others: rest };
}

/** Whole minutes between two instants, never below zero. */
export const minutesBetween = (from: string, now: number) =>
  Math.max(0, Math.floor((now - new Date(from).getTime()) / 60_000));

/** A silence, rolled up: "18 min", "21 h", "3 d". */
export function silenceFor(minutes: number) {
  if (minutes < 60) return `${minutes.toLocaleString()} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours.toLocaleString()} h`;
  return `${Math.floor(hours / 24).toLocaleString()} d`;
}

/**
 * A stalled row's right side: "No update 21 h" once its holder is silent past the lease, or the
 * retry it is on ("Attempt 2 of 3") until then.
 */
export function silenceLabel(
  row: Pick<T.BoardRow, "lastNoteAt" | "updatedAt" | "silent" | "attempts" | "maxAttempts">,
  now: number,
) {
  if (!row.silent) return { text: capitalized(attemptLabel(row)), silent: false };
  const minutes = minutesBetween(row.lastNoteAt ?? row.updatedAt, now);
  return { text: `No update ${silenceFor(minutes)}`, silent: true };
}

const capitalized = (text: string) => (text[0]?.toUpperCase() ?? "") + text.slice(1);

/**
 * A long name split for truncation in the middle: the start shortens, the last characters stay,
 * so `payments-worker-instance-01` and `-02` still differ. Short names stay whole.
 */
export function nameParts(name: string, tail = 8): readonly [string, string] {
  const characters = Array.from(name);
  if (characters.length <= tail + 12) return [name, ""];
  return [characters.slice(0, -tail).join(""), characters.slice(-tail).join("")];
}

/** "attempt 2 of 3": the claim now running, counting the leases that ran out before it. */
export const attemptLabel = (row: Pick<T.BoardRow, "attempts" | "maxAttempts">) =>
  `attempt ${Math.min(row.attempts + 1, Math.max(row.maxAttempts, 1))} of ${row.maxAttempts}`;

/** "T-14". */
export const taskName = (number: number) => `T-${number}`;

/** A task page path's last part ("T-14" or "14") read as a task number, or null. */
export function parseTaskNumber(value: string | undefined): number | null {
  const match = /^(?:T-)?([1-9][0-9]{0,15})$/i.exec(value ?? "");
  if (!match?.[1]) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : null;
}

/** Updated column: "6 min ago" within the hour, the clock time today, the date before that. */
export function updatedLabel(at: string, now: Date) {
  const minutes = minutesBetween(at, now.getTime());
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const when = new Date(at);
  if (when.toDateString() === now.toDateString())
    return when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return when.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Whether the task list refreshes itself when the summary reports a change. Each refresh reads
 * every loaded page, so a list scrolled past two pages waits for the person instead.
 */
export const refreshesItself = (pages: number) => pages <= 2;

/**
 * What a Retry (reopen) of a failed task should do, read from its page: whether it waits for a
 * need that is not done, and how many tasks that need it were canceled when it failed. The server
 * returns every canceled task below it to waiting, unless another of that task's needs also failed,
 * so `back` is what the person is told to expect; the result lists what came back.
 */
export interface RetryPlan {
  readonly waits: boolean;
  readonly back: number;
}

/** A failed task's Retry plan from its needs and the tasks that need it. */
export function retryPlan(detail: {
  readonly needs: ReadonlyArray<Pick<T.TaskSummary, "state">>;
  readonly neededBy: ReadonlyArray<Pick<T.TaskSummary, "state">>;
}): RetryPlan {
  return {
    waits: detail.needs.some((need) => need.state !== "completed"),
    back: detail.neededBy.filter((task) => task.state === "canceled").length,
  };
}

const tasksWord = (count: number) =>
  count === 1 ? "1 task waiting on it comes" : `${count.toLocaleString()} tasks waiting on it come`;

/** What Retry does: "It goes back to the queue, and 3 tasks waiting on it come back too." */
export function retryEffect(plan: RetryPlan) {
  const where = plan.waits ? "It waits for the tasks it needs again" : "It goes back to the queue";
  return plan.back === 0 ? `${where}.` : `${where}, and ${tasksWord(plan.back)} back too.`;
}

/** "Retry T-90? It goes back to the queue, and 3 tasks waiting on it come back too." */
export const retryQuestion = (number: number, plan: RetryPlan) =>
  `Retry ${taskName(number)}? ${retryEffect(plan)}`;

/**
 * The attempt a task is on, or the attempts it used: expired leases, plus the claim running now or
 * the one that completed or failed it.
 */
export function attemptsUsed(task: Pick<T.Task, "attempts" | "maxAttempts" | "state" | "claim">) {
  const ended = task.state === "completed" || task.state === "failed";
  return Math.min(task.attempts + (task.claim !== undefined || ended ? 1 : 0), task.maxAttempts);
}

/** What a Retry did, for the page's notice: "T-90 is back in the queue. 3 tasks came back too." */
export function retriedNotice(result: {
  readonly task: Pick<T.Task, "number" | "state">;
  readonly reopened?: ReadonlyArray<unknown> | undefined;
}) {
  const name = taskName(result.task.number);
  const where =
    result.task.state === "waiting"
      ? `${name} is waiting for the tasks it needs.`
      : `${name} is back in the queue.`;
  const back = result.reopened?.length ?? 0;
  if (back === 0) return where;
  return `${where} ${back === 1 ? "1 task" : `${back.toLocaleString()} tasks`} waiting on it came back too.`;
}

// Task results (docs/swarm-task-results-scope.md, 6): the Result panel, the Board's counts and
// the timeline's note, as plain functions.

const plural = (count: number, singular: string) =>
  `${count.toLocaleString()} ${count === 1 ? singular : `${singular}s`}`;
/** A Board row's muted count, "2 files · 3 links"; empty without a result. */
export function resultCount(row: Pick<T.BoardRow, "resultFiles" | "resultLinks">) {
  return [
    ...(row.resultFiles === undefined ? [] : [plural(row.resultFiles, "file")]),
    ...(row.resultLinks === undefined ? [] : [plural(row.resultLinks, "link")]),
  ].join(" · ");
}
/** What a completed or failed event adds in the timeline, "2 files, 3 links"; empty without. */
export function eventResult(event: Pick<T.TaskEvent, "files" | "links">) {
  return [
    ...(event.files === undefined ? [] : [plural(event.files.length, "file")]),
    ...(event.links === undefined ? [] : [plural(event.links.length, "link")]),
  ].join(", ");
}
/** A commit's short form, as git prints it. */
export const shortSha = (sha: string) => sha.slice(0, 7);
/** A file hash's short form: its first and last four characters. */
export const shortHash = (hash: string) => `${hash.slice(0, 4)}…${hash.slice(-4)}`;
/** The host name a link goes to, shown beside every link so a label cannot hide it. */
export function linkHost(url: string) {
  return URL.canParse(url) ? new URL(url).hostname : url;
}
/** What a link row reads: its label, else a branch's name or a commit's short SHA, else the URL's path. */
export function linkText(link: T.ResultLink) {
  if (link.label !== undefined) return link.label;
  if (link.name !== undefined) return link.name;
  if (link.sha !== undefined) return shortSha(link.sha);
  if (link.url === undefined || !URL.canParse(link.url)) return link.url ?? "";
  const url = new URL(link.url);
  const path = `${url.pathname}${url.search}`;
  return path === "/" ? url.hostname : path;
}
/** A link kind's tag. */
export function linkKind(kind: string) {
  return kind === "pr"
    ? "PR"
    : kind === "commit"
      ? "Commit"
      : kind === "branch"
        ? "Branch"
        : "Link";
}
/**
 * A result's links as the panel's Code part reads them: the base and head commits of a handoff,
 * other commits and branches, then every other link.
 */
export function resultCode(links: ReadonlyArray<T.ResultLink>) {
  const base = links.find((link) => link.kind === "commit" && link.role === "base");
  const head = links.find((link) => link.kind === "commit" && link.role === "head");
  return {
    base,
    head,
    code: links.filter(
      (link) =>
        (link.kind === "commit" || link.kind === "branch") && link !== base && link !== head,
    ),
    other: links.filter((link) => link.kind !== "commit" && link.kind !== "branch"),
  };
}
/** A result file's size line: "folder · 1.2 MB · 14 files" or "48 KB". */
export function fileFacts(file: Pick<T.ResultFile, "kind" | "fileCount">, size: string) {
  return [
    ...(file.kind === "folder" ? ["folder"] : []),
    size,
    ...(file.fileCount === null ? [] : [plural(file.fileCount, "file")]),
  ].join(" · ");
}
/** "expires Dec 25" while a file is available, "Expired Dec 25" after. */
export function fileExpiry(file: Pick<T.ResultFile, "state" | "expiresAt">, now = new Date()) {
  const day = new Date(file.expiresAt).toLocaleDateString([], { month: "short", day: "numeric" });
  return file.state === "expired" || new Date(file.expiresAt) <= now
    ? `Expired ${day}`
    : `expires ${day}`;
}
