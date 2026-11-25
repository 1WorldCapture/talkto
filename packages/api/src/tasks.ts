import { Schema } from "effect";
import * as M from "./models.js";

/**
 * The task board of a swarm server (docs/swarm-server-spec.md). A swarm server is a normal server
 * with the board switched on: agents create tasks, claim them under a fenced lease, post notes to
 * each task's thread and finish them; people follow the board on the dashboard.
 *
 * Replies use plain strings for fields that may gain values later (`state`, `priority`, `kind`,
 * `reason`, `why`), and optional fields instead of nullable ones, so a session that cached these
 * schemas never refuses a later reply (docs/mcp-compatibility.md). Inputs keep literals.
 */
/** Stable MCP tool names. */
export const createToolName = "create_tasks";
export const claimToolName = "claim_task";
export const updateToolName = "update_task";
export const readToolName = "read_tasks";

/** Most tasks one `create_tasks` call creates: each brief is one message of a single allocation. */
export const maxTasksPerCall = 25;
/** Most unfinished tasks one server holds; finished ones are pruned with history. */
export const maxUnfinished = 5000;
/** Most needs and labels per task. */
export const maxNeeds = 16;
export const maxLabels = 8;
/** Most tasks one agent holds at once. */
export const maxHolding = 8;
/** Lease length in seconds when a claim names none, and the allowed range. */
export const defaultLeaseSeconds = 300;
export const minLeaseSeconds = 60;
export const maxLeaseSeconds = 900;
/** Expired leases a task survives before it fails with `attempts_exhausted`, unless set per task. */
export const defaultMaxAttempts = 3;
/**
 * Times one task may be reopened, by its owner agent or a person (proposed November 25, 2026, owner
 * to confirm). Reopening clears the attempts, so without a bound a claim, fail and reopen loop
 * would add events to a task that never finishes, and unfinished tasks are never pruned. After
 * this many the task stays failed; create a new task instead.
 */
export const maxReopens = 10;
/** Thread messages a claim or a task read returns with the brief. */
export const threadMessages = 25;
/** Events a task read returns, newest last. */
export const taskEvents = 50;
/** Most task events one `get_updates` page carries. */
export const maxEventsPerPage = 100;
/** How long an empty claim's interest lasts, in minutes. */
export const interestMinutes = 60;
/** Most dependents an `update_task` reply lists as unlocked or canceled. */
export const maxListed = 100;
/**
 * Longest a claim for next waits for work, in seconds: the same bound and mechanism as a held
 * `get_updates` (updates.ts `maxWaitSeconds`), so a waiting claim fits the same client timeouts.
 */
export const maxClaimWaitSeconds = 20;

const strict = { parseOptions: { onExcessProperty: "error" } } as const;
const uuid = Schema.String.check(Schema.isUUID(4), Schema.isPattern(/^[0-9a-f-]+$/));
const oneLine = Schema.makeFilter((value: string) => !/[\r\n]/.test(value), {
  message: "Expected one line of text",
});

/** Stable identity of a task. */
export const TaskId = M.TaskId;
/** Parsed task identity. */
export type TaskId = M.TaskId;
/** The task's short number on its server: T-1, T-2, … */
export const TaskNumber = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
/** Stable identity of one task event. */
export const TaskEventId = uuid.pipe(Schema.brand("TaskEventId"));
/** Parsed task event identity. */
export type TaskEventId = typeof TaskEventId.Type;
/** Stable identity of one `create_tasks` call. */
export const BatchId = uuid.pipe(Schema.brand("TaskBatchId"));
/** Parsed batch identity. */
export type BatchId = typeof BatchId.Type;
/**
 * A routing label such as `role=reviewer` or `area=web`: lowercase `key` or `key=value`, at most
 * 96 characters, as `task_labels` stores them (migrations/board.sql).
 */
export const Label = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._/-]{0,31}(=[a-z0-9][a-z0-9._/-]{0,62})?$/, {
    message:
      "Expected a lowercase label such as role=reviewer: key of 1–32 characters [a-z0-9._/-], optional =value of 1–63",
  }),
).pipe(Schema.brand("TaskLabel"));
/** Parsed label. */
export type Label = typeof Label.Type;
/** 0–8 distinct labels. */
export const Labels = Schema.Array(Label).check(
  Schema.isMaxLength(maxLabels),
  Schema.isUnique({ expected: "a list without repeated labels" }),
);
/** One line of 1–200 UTF-8 bytes. */
export const Title = Schema.Trim.check(M.textWithin(200), oneLine).pipe(Schema.brand("TaskTitle"));
/** Parsed title. */
export type Title = typeof Title.Type;
/** The one-line result or reason of a finished task, 1–280 UTF-8 bytes. */
export const Summary = Schema.Trim.check(M.textWithin(280), oneLine).pipe(
  Schema.brand("TaskSummary"),
);
/** Parsed summary. */
export type Summary = typeof Summary.Type;
/** Priority at creation; claims for "next" take high first. */
export const Priority = Schema.Literals(["high", "normal", "low"]);
/** Parsed priority. */
export type Priority = typeof Priority.Type;
/** Every state a task can be in. The last three are final. */
export const State = Schema.Literals([
  "waiting",
  "ready",
  "claimed",
  "blocked",
  "completed",
  "failed",
  "canceled",
]);
/** Parsed state. */
export type State = typeof State.Type;
/** States a task can leave. */
export const openStates: ReadonlyArray<State> = ["waiting", "ready", "claimed", "blocked"];
/** States nothing leaves. */
export const finalStates: ReadonlyArray<State> = ["completed", "failed", "canceled"];
/** Lease length a claim asks for, in seconds. */
export const LeaseSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: minLeaseSeconds, maximum: maxLeaseSeconds }),
);
/** A fencing token: 22 base64url characters, new on every claim. Not a secret between agents. */
export const LeaseToken = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/)).pipe(
  Schema.brand("LeaseToken"),
);
/** Parsed lease token. */
export type LeaseToken = typeof LeaseToken.Type;
/** The claim's number on its task; every claim takes the next one. */
export const Epoch = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
/** What a blocked task waits for from a person. */
export const BlockKind = Schema.Literals(["needs_input", "needs_approval"]);
/** Groups similar asks into one Needs you row on the dashboard. */
export const AskKey = Schema.String.check(Schema.isPattern(/^[a-z0-9._-]{1,64}$/));
/** A name for a task inside one `create_tasks` call, so others in the call can need it. */
export const TaskRef = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,32}$/));
/** A task one task needs: an existing task, or another task of the same call by its ref. */
export const Need = Schema.Union([
  Schema.Struct({ taskId: TaskId }),
  Schema.Struct({ ref: TaskRef }),
]);
/** Parsed need. */
export type Need = typeof Need.Type;

/**
 * Swarm memory (docs/swarm-server-spec.md, 14): one Git repository per swarm server, shaped like an
 * AGENTS.md. A short root file (`AGENTS.md`) routes to deeper Markdown files. It holds what the code
 * cannot tell an agent, never documentation of the code. A claim carries the root and the files
 * its labels route to, within the server's budget; `read_memory` reads any file, and
 * `get_memory_access` grants a short Git token to clone it. Every swarm server has it, with no
 * switch: TalkTo sets it up at the first claim, read or context that needs it (owner, November 25,
 * 2026). Absent only where the deployment does not bind Artifacts for memory or sets
 * `TALKTO_MEMORY` to anything but `on`.
 */
export const readMemoryToolName = "read_memory";
export const memoryAccessToolName = "get_memory_access";
/** The root file every memory repository has; it is always delivered in full. */
export const memoryRoot = "AGENTS.md";
/**
 * The one line a claim's memory carries, decided by the owner on November 25, 2026: write memory
 * before complete, because complete ends the claim and with it the write token.
 */
export const memoryCompleteNote =
  "Learned something the next agent would trip on? Add it to memory before you complete: get_memory_access with write, while you still hold the claim.";
/** Memory a claim carries, in TalkTo's estimate of tokens (UTF-8 bytes ÷ 4), and its range. */
export const defaultMemoryTokens = 1500;
export const minMemoryTokens = 500;
export const maxMemoryTokens = 4000;
/** How long a claim trusts the repository head it read last, before reading it again. */
export const memoryHeadSeconds = 30;
/** How long a Git token TalkTo grants lives at most; a write token never outlives its lease. */
export const memoryAccessSeconds = 600;
/** Artifacts' shortest token: a lease ending sooner gets no write token until it is renewed. */
export const memoryMinimumTokenSeconds = 60;
/** Files TalkTo reads from memory: Markdown up to this many bytes each, at most this many files. */
export const maxMemoryFileBytes = 32_768;
export const maxMemoryFiles = 200;
/** A memory file's path: `[A-Za-z0-9._-]` segments, at most 5 deep, ending in .md. */
export const MemoryPath = Schema.String.check(
  Schema.isPattern(
    /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/){0,4}[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.md$/,
    {
      message: "Expected a Markdown path such as traps/ports.md or AGENTS.md",
    },
  ),
).pipe(Schema.brand("MemoryPath"));
/** Parsed memory path. */
export type MemoryPath = typeof MemoryPath.Type;
/** Memory's version: the commit on `main` the files come from (40 hex digits). */
export const MemoryVersion = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)).pipe(
  Schema.brand("MemoryVersion"),
);
/** Parsed memory version. */
export type MemoryVersion = typeof MemoryVersion.Type;

/** One task to create. The brief becomes the first message of the task's thread. */
export const NewTask = Schema.Struct({
  ref: Schema.optionalKey(TaskRef),
  title: Title,
  brief: M.MessageBody,
  labels: Schema.optionalKey(Labels),
  assigneeId: Schema.optionalKey(M.ParticipantId),
  priority: Schema.optionalKey(Priority),
  needs: Schema.optionalKey(Schema.Array(Need).check(Schema.isMaxLength(maxNeeds))),
  maxAttempts: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
}).annotate(strict);
/** Parsed new task. */
export type NewTask = typeof NewTask.Type;
const createFields = {
  requestKey: M.RequestKey,
  tasks: Schema.Array(NewTask).check(Schema.isMinLength(1), Schema.isMaxLength(maxTasksPerCall)),
};
/** HTTP payload of `create_tasks`; the participant is in the path. */
export const CreateTasksBody = Schema.Struct(createFields).annotate(strict);
/** Parsed HTTP payload. */
export type CreateTasksBody = typeof CreateTasksBody.Type;
/** `create_tasks` as agents call it. */
export const CreateTasks = Schema.Struct({
  serverId: M.ServerId,
  participantId: M.ParticipantId,
  ...createFields,
}).annotate(strict);
/** Parsed tool input. */
export type CreateTasks = typeof CreateTasks.Type;

const claimCommon = {
  requestKey: M.RequestKey,
  leaseSeconds: Schema.optionalKey(LeaseSeconds),
};
/** Which task a claim takes. */
export const NextFilter = Schema.Struct({
  labels: Schema.optionalKey(Labels),
  /** Only tasks assigned to you. */
  assignedOnly: Schema.optionalKey(Schema.Boolean),
  /** Hold an empty claim open until work you may claim is ready; 0 or absent answers at once. */
  waitSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maxClaimWaitSeconds })).annotate({
      description:
        "Hold an empty claim open for up to this many seconds (maximum 20) and claim as soon as matching work is ready. 0 or absent answers at once.",
    }),
  ),
}).annotate(strict);
/** HTTP payload of `claim_task`; the participant is in the path. */
export const ClaimTaskBody = Schema.Union([
  Schema.Struct({ ...claimCommon, taskId: TaskId }),
  Schema.Struct({ ...claimCommon, number: TaskNumber }),
  Schema.Struct({ ...claimCommon, next: NextFilter }),
]).annotate(strict);
/** Parsed HTTP payload. */
export type ClaimTaskBody = typeof ClaimTaskBody.Type;
/** `claim_task` as agents call it. */
const claimer = { serverId: M.ServerId, participantId: M.ParticipantId, ...claimCommon };
export const ClaimTask = Schema.Union([
  Schema.Struct({ ...claimer, taskId: TaskId }),
  Schema.Struct({ ...claimer, number: TaskNumber }),
  Schema.Struct({ ...claimer, next: NextFilter }),
]).annotate(strict);
/** Parsed tool input. */
export type ClaimTask = typeof ClaimTask.Type;

// Task results (docs/swarm-task-results-scope.md): files and links on a finished task.

/** Most files one result attaches. */
export const maxResultFiles = 8;
/** Most links one result carries. */
export const maxResultLinks = 10;
/** Longest link URL, in UTF-8 bytes, as given and as stored. */
export const maxLinkUrlBytes = 2048;
/** Longest link label, in UTF-8 bytes. */
export const maxLinkLabelBytes = 100;
const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;
/**
 * An absolute `https:` URL with a host name and no user name or password, so neither a token nor a
 * misleading `https://github.com@evil.example/` gets through. It is stored as its parsed `href`,
 * which must fit the same limit.
 */
const isLinkUrl = (value: string) => {
  if (utf8Bytes(value) > maxLinkUrlBytes || /[\s\p{Cc}]/u.test(value) || !URL.canParse(value))
    return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.hostname !== "" &&
    url.username === "" &&
    url.password === "" &&
    utf8Bytes(url.href) <= maxLinkUrlBytes
  );
};
/** A link's URL: `https:` only, 1–2,048 UTF-8 bytes, no spaces, no user name or password. */
export const LinkUrl = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter(isLinkUrl, {
    message:
      "Expected an absolute https:// URL of at most 2,048 bytes with a host name, no spaces and no user name or password",
  }),
);
/** A full commit ID: 40 (SHA-1) or 64 (SHA-256) lowercase hex characters. */
export const GitSha = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, {
    message:
      "Expected a full commit ID: 40 or 64 lowercase hex characters, as git rev-parse prints it",
  }),
);
/**
 * A branch name safe to paste into a shell command: 1–200 characters of A-Z a-z 0-9 . _ / -, not
 * starting with - or /, not ending with /, . or .lock, and with no .. or //.
 */
export const BranchName = Schema.String.check(
  Schema.isPattern(/^(?![-/])(?!.*(?:\.\.|\/\/))(?!.*(?:\/|\.|\.lock)$)[A-Za-z0-9._/-]{1,200}$/, {
    message:
      "Expected a branch name of 1–200 characters [A-Za-z0-9._/-], not starting with - or /, not ending with /, . or .lock, without .. or //",
  }),
);
/** A link's label: one trimmed line of 1–100 UTF-8 bytes, such as #412 or staging deploy. */
export const LinkLabel = Schema.Trim.check(M.textWithin(maxLinkLabelBytes), oneLine);
/** A commit's role in a code handoff: the commit the work started from, or its last commit. */
export const CommitRole = Schema.Literals(["base", "head"]);
/**
 * One link of a result. `pr`, `url`: a URL. `commit`: a full SHA, with `role` base or head for a
 * handoff with no shared remote, and an optional URL. `branch`: a name and an optional URL.
 */
export const NewLink = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pr"),
    url: LinkUrl,
    label: Schema.optionalKey(LinkLabel),
  }),
  Schema.Struct({
    kind: Schema.Literal("commit"),
    sha: GitSha,
    role: Schema.optionalKey(CommitRole),
    url: Schema.optionalKey(LinkUrl),
    label: Schema.optionalKey(LinkLabel),
  }),
  Schema.Struct({
    kind: Schema.Literal("branch"),
    name: BranchName,
    url: Schema.optionalKey(LinkUrl),
    label: Schema.optionalKey(LinkLabel),
  }),
  Schema.Struct({
    kind: Schema.Literal("url"),
    url: LinkUrl,
    label: Schema.optionalKey(LinkLabel),
  }),
]).annotate(strict);
/** Parsed link. */
export type NewLink = typeof NewLink.Type;
const roleCount = (links: ReadonlyArray<NewLink>, role: "base" | "head") =>
  links.filter((link) => link.kind === "commit" && link.role === role).length;
/** At most one commit with role base and one with role head in one result. */
const oneBaseOneHead = Schema.makeFilter(
  (links: ReadonlyArray<NewLink>) => roleCount(links, "base") <= 1 && roleCount(links, "head") <= 1,
  { message: "Expected at most one commit link with role base and one with role head" },
);
const resultFields = {
  transferIds: Schema.optionalKey(
    Schema.Array(M.TransferId)
      .check(
        Schema.isMinLength(1),
        Schema.isMaxLength(maxResultFiles),
        Schema.isUnique({ expected: "a list without repeated transfer IDs" }),
      )
      .annotate({
        description:
          "1–8 transferIds you prepared with prepare_transfer and uploaded. No complete_transfer is needed: TalkTo offers each file in the task's thread (one message each). A file you already offered is attached as it is.",
      }),
  ),
  links: Schema.optionalKey(
    Schema.Array(NewLink)
      .check(Schema.isMinLength(1), Schema.isMaxLength(maxResultLinks), oneBaseOneHead)
      .annotate({
        description:
          "1–10 links: {kind: pr, url}, {kind: commit, sha, role?: base|head, url?}, {kind: branch, name, url?} or {kind: url, url}, each with an optional label. https only; never a secret or a signed link.",
      }),
  ),
};

const holderFields = {
  requestKey: M.RequestKey,
  leaseToken: LeaseToken,
  epoch: Epoch,
};
const actions = {
  progress: { action: Schema.Literal("progress"), note: Schema.optionalKey(M.MessageBody) },
  complete: {
    action: Schema.Literal("complete"),
    summary: Summary,
    details: Schema.optionalKey(M.MessageBody),
    ...resultFields,
  },
  fail: {
    action: Schema.Literal("fail"),
    summary: Summary,
    details: Schema.optionalKey(M.MessageBody),
    ...resultFields,
  },
  release: { action: Schema.Literal("release"), note: Schema.optionalKey(M.MessageBody) },
};
/**
 * What the task's owner agent may do without a claim: cancel it while waiting or ready, or reopen
 * it after it failed. `expectedRevision`, when given, must be the task's revision.
 */
const ownerFields = {
  requestKey: M.RequestKey,
  expectedRevision: Schema.optionalKey(M.Count),
};
const ownerActions = {
  cancel: { action: Schema.Literal("cancel"), reason: Schema.optionalKey(M.MessageBody) },
  reopen: { action: Schema.Literal("reopen"), note: Schema.optionalKey(M.MessageBody) },
};
/** HTTP payload of `update_task`; the participant and task are in the path. */
export const UpdateTaskBody = Schema.Union([
  Schema.Struct({ ...holderFields, ...actions.progress }),
  Schema.Struct({ ...holderFields, ...actions.complete }),
  Schema.Struct({ ...holderFields, ...actions.fail }),
  Schema.Struct({ ...holderFields, ...actions.release }),
  Schema.Struct({ ...ownerFields, ...ownerActions.cancel }),
  Schema.Struct({ ...ownerFields, ...ownerActions.reopen }),
]).annotate(strict);
/** Parsed HTTP payload. */
export type UpdateTaskBody = typeof UpdateTaskBody.Type;
const holder = {
  serverId: M.ServerId,
  participantId: M.ParticipantId,
  taskId: TaskId,
  ...holderFields,
};
const owner = {
  serverId: M.ServerId,
  participantId: M.ParticipantId,
  taskId: TaskId,
  ...ownerFields,
};
/**
 * `update_task` as agents call it. The holder's actions: progress, complete, fail and release;
 * the owner's: cancel and reopen. `block` (asking a person) comes with the dashboard's Needs you.
 */
export const UpdateTask = Schema.Union([
  Schema.Struct({ ...holder, ...actions.progress }),
  Schema.Struct({ ...holder, ...actions.complete }),
  Schema.Struct({ ...holder, ...actions.fail }),
  Schema.Struct({ ...holder, ...actions.release }),
  Schema.Struct({ ...owner, ...ownerActions.cancel }),
  Schema.Struct({ ...owner, ...ownerActions.reopen }),
]).annotate(strict);
/** Parsed tool input. */
export type UpdateTask = typeof UpdateTask.Type;

const listFields = {
  states: Schema.optionalKey(Schema.Array(State).check(Schema.isUnique())),
  labels: Schema.optionalKey(Labels),
  assigneeId: Schema.optionalKey(M.ParticipantId),
  ownerId: Schema.optionalKey(M.ParticipantId),
  /** Tasks you own, are assigned or hold. */
  mine: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(M.Limit),
  cursor: Schema.optionalKey(M.Cursor),
};
/** Which task one read names. */
export const TaskSelector = Schema.Union([
  Schema.Struct({ id: TaskId }),
  Schema.Struct({ number: TaskNumber }),
]);
/** Parsed task selector. */
export type TaskSelector = typeof TaskSelector.Type;
/** `read_tasks` as agents call it. */
export const ReadTasks = Schema.Union([
  Schema.Struct({
    serverId: M.ServerId,
    participantId: M.ParticipantId,
    mode: Schema.Literal("list"),
    ...listFields,
  }),
  Schema.Struct({
    serverId: M.ServerId,
    participantId: M.ParticipantId,
    mode: Schema.Literal("task"),
    task: TaskSelector,
    /** Continue to older thread messages. */
    before: Schema.optionalKey(M.Cursor),
  }),
]).annotate(strict);
/** Parsed tool input. */
export type ReadTasks = typeof ReadTasks.Type;
/** `read_memory` as agents call it: the root and the file list, or one file with `path`. */
export const ReadMemory = Schema.Struct({
  serverId: M.ServerId,
  participantId: M.ParticipantId,
  path: Schema.optionalKey(MemoryPath),
}).annotate(strict);
/** Parsed tool input. */
export type ReadMemory = typeof ReadMemory.Type;
/** `GET /v1/servers/:serverId/memory` query: `read_memory`. */
export const ReadMemoryQuery = Schema.Struct({
  participantId: M.ParticipantId,
  path: Schema.optionalKey(MemoryPath),
}).annotate(strict);
/** Parsed memory query. */
export type ReadMemoryQuery = typeof ReadMemoryQuery.Type;
/** The claim a write token is for: the lease from `claim_task`, as `update_task` takes it. */
export const MemoryWrite = Schema.Struct({
  taskId: TaskId,
  leaseToken: LeaseToken,
  epoch: Epoch,
}).annotate(strict);
/** Parsed write claim. */
export type MemoryWrite = typeof MemoryWrite.Type;
/** `get_memory_access` as agents call it; `write` asks for a token that can push. */
export const GetMemoryAccess = Schema.Struct({
  serverId: M.ServerId,
  participantId: M.ParticipantId,
  write: Schema.optionalKey(MemoryWrite),
}).annotate(strict);
/** Parsed tool input. */
export type GetMemoryAccess = typeof GetMemoryAccess.Type;
/** `POST /v1/servers/:serverId/participants/:participantId/memory/access` payload. */
export const MemoryAccessBody = Schema.Struct({
  write: Schema.optionalKey(MemoryWrite),
}).annotate(strict);
/** Parsed payload. */
export type MemoryAccessBody = typeof MemoryAccessBody.Type;
/** `GET /v1/servers/:serverId/tasks` query: the list mode of `read_tasks`. */
export const ListTasksQuery = Schema.Struct({
  participantId: M.ParticipantId,
  ...listFields,
}).annotate(strict);
/** Parsed list query. */
export type ListTasksQuery = typeof ListTasksQuery.Type;
/** `GET /v1/servers/:serverId/tasks/:task` query: the task mode of `read_tasks`. */
export const ReadTaskQuery = Schema.Struct({
  participantId: M.ParticipantId,
  before: Schema.optionalKey(M.Cursor),
}).annotate(strict);
/** Parsed task query. */
export type ReadTaskQuery = typeof ReadTaskQuery.Type;
/** A task's ID or its number, as the task route's path names it. */
export const TaskIdOrNumber = Schema.Union([
  TaskId,
  Schema.NumberFromString.pipe(Schema.decodeTo(TaskNumber)),
]);

/** The current claim on a task. Never the token. */
export const Claim = Schema.Struct({
  holderId: M.ParticipantId,
  epoch: Epoch,
  claimedAt: M.Timestamp,
  expiresAt: M.Timestamp,
}).annotate({ identifier: "TaskClaim" });
/** What a blocked task asks a person. */
export const Block = Schema.Struct({
  kind: Schema.String,
  questionMessageId: M.MessageId,
  askedBy: M.ParticipantId,
  askedAt: M.Timestamp,
  askKey: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "TaskBlock" });
/** A person's last decision on the task. Only a person sets it, on the TalkTo dashboard. */
export const Decision = Schema.Struct({
  kind: Schema.String,
  byId: M.ParticipantId,
  at: M.Timestamp,
}).annotate({ identifier: "TaskDecision" });
/**
 * A file of a result: a copy of its offer as it was when the task finished, so the task still
 * names it after the transfer expires. Pass `id` to fetch_transfer. `state`: available or expired,
 * computed when the reply is made. `messageId` is its offer message in the task's thread.
 */
export const ResultFile = Schema.Struct({
  ...M.FileTransfer.fields,
  state: Schema.String,
  messageId: M.MessageId,
}).annotate({ identifier: "TaskResultFile" });
/** Parsed result file. */
export interface ResultFile extends Schema.Schema.Type<typeof ResultFile> {}
/**
 * A link of a result, as the claimer gave it. `kind`: pr, commit, branch or url. `role` (commits
 * only): base or head. TalkTo never fetches or checks a link.
 */
export const ResultLink = Schema.Struct({
  kind: Schema.String,
  url: Schema.optionalKey(Schema.String),
  sha: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "TaskResultLink" });
/** Parsed result link. */
export interface ResultLink extends Schema.Schema.Type<typeof ResultLink> {}
/**
 * How a finished task ended. `kind`: completed, failed or canceled. `reason`: by_claimer,
 * by_person, by_owner, need_failed or attempts_exhausted. `files` and `links` are present when
 * the claimer finished it with them.
 */
export const Outcome = Schema.Struct({
  kind: Schema.String,
  reason: Schema.String,
  summary: Schema.optionalKey(Summary),
  at: M.Timestamp,
  messageId: Schema.optionalKey(M.MessageId),
  files: Schema.optionalKey(Schema.Array(ResultFile)),
  links: Schema.optionalKey(Schema.Array(ResultLink)),
}).annotate({ identifier: "TaskOutcome" });
/**
 * One task. `state`: waiting, ready, claimed, blocked, completed, failed or canceled.
 * `priority`: high, normal or low.
 */
export const Task = Schema.Struct({
  id: TaskId,
  number: TaskNumber,
  title: Title,
  state: Schema.String,
  priority: Schema.String,
  labels: Schema.Array(Schema.String),
  ownerId: M.ParticipantId,
  assigneeId: Schema.optionalKey(M.ParticipantId),
  needs: Schema.Array(TaskId),
  claim: Schema.optionalKey(Claim),
  block: Schema.optionalKey(Block),
  decision: Schema.optionalKey(Decision),
  outcome: Schema.optionalKey(Outcome),
  attempts: M.Count,
  maxAttempts: M.Count,
  briefMessageId: M.MessageId,
  /** The task's page on the TalkTo dashboard. */
  url: Schema.String,
  createdAt: M.Timestamp,
  updatedAt: M.Timestamp,
  revision: M.Count,
}).annotate({ identifier: "Task" });
/** Parsed task. */
export interface Task extends Schema.Schema.Type<typeof Task> {}
/** A short reference to a task: what lists, needs and recovery show. */
export const TaskSummary = Schema.Struct({
  id: TaskId,
  number: TaskNumber,
  title: Title,
  state: Schema.String,
  holderId: Schema.optionalKey(M.ParticipantId),
  assigneeId: Schema.optionalKey(M.ParticipantId),
  /** When the current lease runs out; present while claimed. */
  expiresAt: Schema.optionalKey(M.Timestamp),
}).annotate({ identifier: "TaskSummary" });
/** Parsed summary. */
export interface TaskSummary extends Schema.Schema.Type<typeof TaskSummary> {}
/** Tasks per state on the whole board. */
export const Counts = Schema.Struct({
  waiting: M.Count,
  ready: M.Count,
  claimed: M.Count,
  blocked: M.Count,
  completed: M.Count,
  failed: M.Count,
  canceled: M.Count,
}).annotate({ identifier: "TaskCounts" });
/** Parsed counts. */
export interface Counts extends Schema.Schema.Type<typeof Counts> {}

/** `create_tasks` result; a retry with the same request key returns the same tasks. */
export const CreatedTasks = Schema.Struct({
  batchId: BatchId,
  tasks: Schema.Array(Task),
  created: Schema.Boolean,
}).annotate({ identifier: "CreatedTasks" });
/** Parsed creation result. */
export interface CreatedTasks extends Schema.Schema.Type<typeof CreatedTasks> {}
/** The claimer's lease. Renew before `renewBy`, half-way through the lease. */
export const Lease = Schema.Struct({
  token: LeaseToken,
  epoch: Epoch,
  leaseSeconds: LeaseSeconds,
  claimedAt: M.Timestamp,
  expiresAt: M.Timestamp,
  renewBy: M.Timestamp,
}).annotate({ identifier: "TaskLease" });
/** Parsed lease. */
export interface Lease extends Schema.Schema.Type<typeof Lease> {}
/** One memory file's text. */
export const MemoryFile = Schema.Struct({ path: Schema.String, text: Schema.String }).annotate({
  identifier: "MemoryFile",
});
/** Parsed memory file. */
export interface MemoryFile extends Schema.Schema.Type<typeof MemoryFile> {}
/** A memory file a claim did not carry, with the root map's line about it when there is one. */
export const MemoryOmitted = Schema.Struct({
  path: Schema.String,
  about: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "MemoryOmitted" });
/** Parsed omitted file. */
export interface MemoryOmitted extends Schema.Schema.Type<typeof MemoryOmitted> {}
/**
 * What a claim on a server with memory carries: the root `AGENTS.md` (norms and a map to deeper
 * files) in full, then the files the task's labels route to (a path segment named like a label,
 * front matter `labels:`, or a map line naming the label), in label order, within the server's
 * budget. `omitted` names the matches that did not fit, then the other files as the budget allows,
 * with what the map says of each: open them with read_memory. Memory is what the code cannot say; where they disagree, the code wins.
 */
export const ClaimMemory = Schema.Struct({
  root: Schema.String,
  files: Schema.Array(MemoryFile),
  omitted: Schema.Array(MemoryOmitted),
  /** TalkTo's estimate of this field's size in tokens (UTF-8 bytes ÷ 4). */
  tokens: M.Count,
  version: MemoryVersion,
  /** When to write memory: before complete, while the claim still grants a write token. */
  note: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "ClaimMemory" });
/** Parsed claim memory. */
export interface ClaimMemory extends Schema.Schema.Type<typeof ClaimMemory> {}
/** One file in memory's listing: its size and the labels that route it. */
export const MemoryListing = Schema.Struct({
  path: Schema.String,
  bytes: M.Count,
  labels: Schema.Array(Schema.String),
}).annotate({ identifier: "MemoryListing" });
/** Parsed listing entry. */
export interface MemoryListing extends Schema.Schema.Type<typeof MemoryListing> {}
/**
 * `read_memory`: one file's text at `version`. Without `path`, the root (`AGENTS.md`) and `files`,
 * every Markdown file TalkTo serves. A larger file or another kind is only in Git.
 */
export const MemoryRead = Schema.Struct({
  path: Schema.String,
  text: Schema.String,
  version: MemoryVersion,
  files: Schema.optionalKey(Schema.Array(MemoryListing)),
}).annotate({ identifier: "MemoryRead" });
/** Parsed memory read. */
export interface MemoryRead extends Schema.Schema.Type<typeof MemoryRead> {}
/**
 * `get_memory_access`: a short Git token for memory's repository, and the exact commands. The
 * token goes only on the command line as an `http.extraHeader`: never in a remote URL, a Git
 * config file, a message or the repository. `scope` is read, or write for a claim holder.
 */
export const MemoryAccess = Schema.Struct({
  remote: Schema.String,
  token: Schema.String,
  scope: Schema.String,
  expiresAt: M.Timestamp,
  version: Schema.optionalKey(MemoryVersion),
  commands: Schema.Struct({
    clone: Schema.String,
    pull: Schema.String,
    push: Schema.optionalKey(Schema.String),
  }),
  note: Schema.String,
}).annotate({ identifier: "MemoryAccess" });
/** Parsed memory access. */
export interface MemoryAccess extends Schema.Schema.Type<typeof MemoryAccess> {}
/** A server's memory settings, as `PUT …/board` returns them. */
export const MemorySettings = Schema.Struct({
  /** The budget a claim's memory fits in, in estimated tokens. */
  tokens: M.Count,
  /** The memory channel: TalkTo posts each new commit's one-line message there. */
  channelId: Schema.optionalKey(M.ConversationId),
  version: Schema.optionalKey(MemoryVersion),
}).annotate({ identifier: "MemorySettings" });
/** Parsed memory settings. */
export interface MemorySettings extends Schema.Schema.Type<typeof MemorySettings> {}
/**
 * `claim_task` result. `why` when nothing was claimed: none_ready or claim_cap; at the claim cap,
 * `message` says what to do.
 */
export const ClaimResult = Schema.Union([
  Schema.Struct({
    claimed: Schema.Literal(true),
    task: Task,
    lease: Lease,
    /** True when you already held the task: the same token and epoch, renewed. */
    recovered: Schema.Boolean,
    /** The brief and the latest thread messages, oldest first. */
    thread: M.messagePage,
    /** On servers with memory: the root AGENTS.md and the files your labels route to. */
    memory: Schema.optionalKey(ClaimMemory),
  }),
  Schema.Struct({
    claimed: Schema.Literal(false),
    why: Schema.String,
    /** What to do next, when `why` needs it (claim_cap). */
    message: Schema.optionalKey(Schema.String),
    waitingFor: Schema.Struct({ labels: Schema.Array(Schema.String), until: M.Timestamp }),
    counts: Schema.Struct({ ready: M.Count, claimed: M.Count, waiting: M.Count }),
  }),
]).annotate({ identifier: "ClaimResult" });
/** Parsed claim result. */
export type ClaimResult = typeof ClaimResult.Type;
/** `update_task` result. `changed` is false on a replay of the same request key. */
export const UpdatedTask = Schema.Struct({
  task: Task,
  /** Present while you still hold the task (after progress). */
  lease: Schema.optionalKey(Lease),
  /** The thread message this call posted, if any. */
  message: Schema.optionalKey(M.Message),
  /** Tasks this completion made ready (at most 100 listed). */
  unlocked: Schema.Array(TaskSummary),
  /** Tasks this failure or cancel canceled (at most 100 listed). */
  canceled: Schema.Array(TaskSummary),
  /** Tasks this reopen returned to waiting (at most 100 listed); present after reopen only. */
  reopened: Schema.optionalKey(Schema.Array(TaskSummary)),
  changed: Schema.Boolean,
}).annotate({ identifier: "UpdatedTask" });
/** Parsed update result. */
export interface UpdatedTask extends Schema.Schema.Type<typeof UpdatedTask> {}
/**
 * One change to a task, in the server-wide sequence messages and renames share. `kind`: created,
 * ready, claimed, released, expired, blocked, unblocked, completed, failed, canceled, assigned,
 * reprioritized, reopened or batch_finished. `state` is the task's state after the event.
 * `actor.kind`: agent, person or system. `reason`: needs_done, need_failed, need_reopened,
 * by_claimer, by_person, by_owner, attempts_exhausted, participant_removed or board_off.
 */
export const TaskEvent = Schema.Struct({
  id: TaskEventId,
  sequence: M.Count,
  taskId: TaskId,
  number: TaskNumber,
  title: Title,
  kind: Schema.String,
  state: Schema.String,
  at: M.Timestamp,
  actor: Schema.Struct({
    kind: Schema.String,
    participantId: Schema.optionalKey(M.ParticipantId),
    name: Schema.optionalKey(M.Name),
  }),
  reason: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Summary),
  holderId: Schema.optionalKey(M.ParticipantId),
  assigneeId: Schema.optionalKey(M.ParticipantId),
  epoch: Schema.optionalKey(Epoch),
  batch: Schema.optionalKey(
    Schema.Struct({ id: Schema.String, completed: M.Count, failed: M.Count, canceled: M.Count }),
  ),
  /** On completed and failed: the files and links of this attempt's result, when it had them. */
  files: Schema.optionalKey(Schema.Array(ResultFile)),
  links: Schema.optionalKey(Schema.Array(ResultLink)),
}).annotate({ identifier: "TaskEvent" });
/** Parsed task event. */
export interface TaskEvent extends Schema.Schema.Type<typeof TaskEvent> {}
/** A page of the board's tasks, most recently changed first, and counts for the whole board. */
export const TaskList = Schema.Struct({
  items: Schema.Array(Task),
  nextCursor: Schema.NullOr(M.Cursor),
  counts: Counts,
}).annotate({ identifier: "TaskList" });
/** Parsed task list. */
export interface TaskList extends Schema.Schema.Type<typeof TaskList> {}
/** One task with what it needs, what needs it, its latest events and its thread. */
export const TaskDetail = Schema.Struct({
  task: Task,
  needs: Schema.Array(TaskSummary),
  neededBy: Schema.Array(TaskSummary),
  /** The brief and the latest messages, oldest first; `nextCursor` reads older ones (`before`). */
  thread: M.messagePage,
  /** The latest events, oldest first. */
  events: Schema.Array(TaskEvent),
}).annotate({ identifier: "TaskDetail" });
/** Parsed task detail. */
export interface TaskDetail extends Schema.Schema.Type<typeof TaskDetail> {}
/** `read_tasks` result; `mode` repeats the input's. */
export const ReadTasksData = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("list"), ...TaskList.fields }),
  Schema.Struct({ mode: Schema.Literal("task"), ...TaskDetail.fields }),
]).annotate({ identifier: "ReadTasksData" });
/** Parsed read result. */
export type ReadTasksData = typeof ReadTasksData.Type;
/** What `get_context` shows on a server whose board was ever switched on. */
export const ContextBoard = Schema.Struct({
  enabled: Schema.Boolean,
  /** The board channel holding every task's thread; absent until the first task is created. */
  channelId: Schema.optionalKey(M.ConversationId),
  counts: Counts,
  claimCap: Schema.optionalKey(M.Count),
  /**
   * The organization's task operations this month, on a hosted plan only (owner pilots and
   * self-hosted copies count none): `used` of `limit`, counted when leased so it may run a few
   * ahead. Past `limit`, task operations go through a slow lane until `resetsAt`.
   */
  taskOperations: Schema.optionalKey(
    Schema.Struct({ used: M.Count, limit: M.Count, resetsAt: M.Timestamp }),
  ),
  /** Tasks you hold (with expiresAt) or are assigned, at most 25: claim each again by taskId. */
  yours: Schema.Array(TaskSummary),
  /**
   * Swarm memory, present on every swarm server whose board is on where the deployment offers
   * memory: claims carry it, read_memory reads it and get_memory_access grants Git. `enabled` is
   * always true (memory has no switch; kept so sessions holding older output schemas still accept
   * the reply). `files` counts the Markdown files TalkTo serves (0 until memory is set up);
   * `version` is the commit on main; `channelId` is the memory channel, where each new commit's
   * one-line message is posted.
   */
  memory: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.Boolean,
      files: M.Count,
      version: Schema.optionalKey(MemoryVersion),
      channelId: Schema.optionalKey(M.ConversationId),
    }),
  ),
}).annotate({ identifier: "ContextBoard" });
/** Parsed board context. */
export interface ContextBoard extends Schema.Schema.Type<typeof ContextBoard> {}
/** Which `get_updates` task events a checkpoint delivers: yours (the default), all, or none. */
export const TasksSelection = Schema.Literals(["mine", "all", "none"]);
/** Parsed task selection. */
export type TasksSelection = typeof TasksSelection.Type;
/** The thread a message belongs to, on messages in the board channel. */
export const MessageTask = M.MessageTask;
/** Parsed thread reference. */
export type MessageTask = M.MessageTask;

// The dashboard's Board (docs/swarm-server-spec.md, 9.2). People read it on the website.

/** An opaque version of the Board's top; send it back as `after` to skip an unchanged reply. */
export const BoardVersion = Schema.String.check(Schema.isPattern(/^[0-9.]{1,64}$/)).pipe(
  Schema.brand("BoardVersion"),
);
/** Parsed board version. */
export type BoardVersion = typeof BoardVersion.Type;
/** `GET /v1/servers/:serverId/board` query. */
export const BoardInput = Schema.Struct({ after: Schema.optionalKey(BoardVersion) }).annotate(
  strict,
);
/** Parsed board query. */
export type BoardInput = typeof BoardInput.Type;
/**
 * One row of the Board's lists: a task with its holder, first label, last note and attempts.
 * `lastNoteAt` is the holder's last thread note or the claim, whichever is later.
 */
export const BoardRow = Schema.Struct({
  ...TaskSummary.fields,
  priority: Schema.String,
  ownerId: M.ParticipantId,
  label: Schema.optionalKey(Schema.String),
  lastNoteAt: Schema.optionalKey(M.Timestamp),
  attempts: M.Count,
  maxAttempts: M.Count,
  /** Stalled: claimed with no note for longer than the lease, or on a retry. */
  stalled: Schema.Boolean,
  /** Silent: claimed with no note for longer than the lease. A stalled retry is not silent yet. */
  silent: Schema.Boolean,
  /** The one-line result or reason of a finished task. */
  summary: Schema.optionalKey(Summary),
  updatedAt: M.Timestamp,
  finishedAt: Schema.optionalKey(M.Timestamp),
  /**
   * The agent that finished the task: the claimer that completed or failed it, or the owner agent
   * that canceled it. Absent while unfinished, or when a person, a cancel through its needs or
   * running out of attempts ended it.
   */
  finishedById: Schema.optionalKey(M.ParticipantId),
  /**
   * Other agents that held a claim on the task, latest first, without the current holder and the
   * finisher (at most 16 are recorded per task). Kept through lease expiry, release and reopen.
   */
  earlierHolderIds: Schema.optionalKey(Schema.Array(M.ParticipantId)),
  /** Files and links of the finished task's result; absent when it has none. */
  resultFiles: Schema.optionalKey(M.Count),
  resultLinks: Schema.optionalKey(M.Count),
}).annotate({ identifier: "BoardRow" });
/** Parsed board row. */
export interface BoardRow extends Schema.Schema.Type<typeof BoardRow> {}
/** A few rows of one exception list and how many there are in all. */
export const BoardRows = Schema.Struct({ items: Schema.Array(BoardRow), total: M.Count });
/**
 * A Needs you row: one blocked task, or blocked tasks that share an ask key and kind. Phase 2
 * fills it; until then no task is blocked and the list is empty.
 */
export const NeedsRow = Schema.Struct({
  askKey: Schema.optionalKey(Schema.String),
  kind: Schema.String,
  count: M.Count,
  askers: Schema.Array(M.ParticipantId),
  oldestAt: M.Timestamp,
  first: BoardRow,
}).annotate({ identifier: "NeedsRow" });
/** Agents on the server: working holds a claimed task, stalled a stalled one, idle none. */
export const BoardAgents = Schema.Struct({
  total: M.Count,
  working: M.Count,
  stalled: M.Count,
  idle: M.Count,
});
/** The Board's top: the same size from 10 tasks to 5,000. It carries no estimate of time left. */
export const Board = Schema.Union([
  Schema.Struct({ changed: Schema.Literal(false), after: BoardVersion }),
  Schema.Struct({
    changed: Schema.Literal(true),
    after: BoardVersion,
    enabled: Schema.Boolean,
    /** Absent until the first task is created. */
    channelId: Schema.optionalKey(M.ConversationId),
    claimCap: Schema.optionalKey(M.Count),
    total: M.Count,
    counts: Schema.Struct({ ...Counts.fields, stalled: M.Count }),
    /** Tasks completed in the last 60 minutes: a count of real completions. */
    finishedLastHour: M.Count,
    agents: BoardAgents,
    needs: Schema.Array(NeedsRow),
    needsTotal: M.Count,
    needsRows: M.Count,
    stalled: BoardRows,
    failed: BoardRows,
    /**
     * Swarm memory, present where the deployment offers memory. `started` once TalkTo set memory
     * up (at the first claim, read or context that needed it): from then on it cannot start from
     * another server's memory.
     */
    memory: Schema.optionalKey(Schema.Struct({ started: Schema.Boolean })),
  }),
]).annotate({ identifier: "Board" });
/** Parsed board top. */
export type Board = typeof Board.Type;
/** The Board's task list views. */
export const BoardView = Schema.Literals(["all", "open", "done", "failed", "needs", "stalled"]);
/** Parsed view. */
export type BoardView = typeof BoardView.Type;
/** `GET /v1/servers/:serverId/board/tasks` query. */
export const BoardTasksInput = Schema.Struct({
  view: Schema.optionalKey(BoardView),
  state: Schema.optionalKey(State),
  /** Holder, assignee or owner. */
  agentId: Schema.optionalKey(M.ParticipantId),
  label: Schema.optionalKey(Label),
  askKey: Schema.optionalKey(AskKey),
  /** A title substring, or a task number (14 or T-14). */
  q: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  cursor: Schema.optionalKey(M.Cursor),
  limit: Schema.optionalKey(M.Limit),
}).annotate(strict);
/** Parsed task list query. */
export type BoardTasksInput = typeof BoardTasksInput.Type;
/** `GET /v1/servers/:serverId/board/tasks/:task` query: one task on the Board's task page. */
export const BoardTaskInput = Schema.Struct({
  /** Continue to older thread messages. */
  before: Schema.optionalKey(M.Cursor),
}).annotate(strict);
/** Parsed task page query. */
export type BoardTaskInput = typeof BoardTaskInput.Type;
/**
 * The Board's task list. Open: needs you, stalled, working, ready, waiting, then priority, then
 * oldest. Done and Failed: latest first. All: open first, then finished latest first.
 */
export const BoardTasks = Schema.Struct({
  items: Schema.Array(BoardRow),
  nextCursor: Schema.NullOr(M.Cursor),
}).annotate({ identifier: "BoardTasks" });
/** Parsed task list page. */
export interface BoardTasks extends Schema.Schema.Type<typeof BoardTasks> {}
/** Most labels the Board's label list returns. */
export const maxBoardLabels = 500;
/** Every label on the board's tasks, A–Z, for the Board's label filter; `more` past the cap. */
export const BoardLabels = Schema.Struct({
  items: Schema.Array(Schema.String),
  more: Schema.Boolean,
}).annotate({ identifier: "BoardLabels" });
/** Parsed label list. */
export interface BoardLabels extends Schema.Schema.Type<typeof BoardLabels> {}
/** A person cancels one unfinished task on the dashboard. */
export const CancelTask = Schema.Struct({
  expectedRevision: M.Count,
  requestKey: M.RequestKey,
  reason: Schema.optionalKey(M.MessageBody),
}).annotate(strict);
/** Parsed cancel. */
export type CancelTask = typeof CancelTask.Type;
/**
 * A person reopens one failed task on the dashboard: it returns to ready (or waiting while a need
 * is unfinished) with its attempts reset, and the tasks canceled because it failed wait again.
 * A note is posted to the task's thread.
 */
export const ReopenTask = Schema.Struct({
  expectedRevision: M.Count,
  requestKey: M.RequestKey,
  note: Schema.optionalKey(M.MessageBody),
}).annotate(strict);
/** Parsed reopen. */
export type ReopenTask = typeof ReopenTask.Type;
/** What a person's action did; `changed` is false on a replay. */
export const PersonResult = Schema.Struct({
  task: Task,
  changed: Schema.Boolean,
  /** Tasks the cancel canceled because they needed this one (at most 100 listed). */
  canceled: Schema.Array(TaskSummary),
  /** Tasks the reopen returned to waiting (at most 100 listed); present after reopen only. */
  reopened: Schema.optionalKey(Schema.Array(TaskSummary)),
}).annotate({ identifier: "TaskPersonResult" });
/** Parsed person result. */
export interface PersonResult extends Schema.Schema.Type<typeof PersonResult> {}
/** The server creator switches the board on or off on the dashboard. */
export const SetBoard = Schema.Struct({
  /** The board's switch. Absent leaves it as it is, so memory or the cap can change alone. */
  enabled: Schema.optionalKey(Schema.Boolean),
  /** Most tasks claimed at once; null removes the cap. Absent leaves it unchanged. */
  claimCap: Schema.optionalKey(
    Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  ),
  /**
   * Swarm memory, where the deployment offers it. It has no switch: every swarm server has it, so
   * `enabled` is unknown input here. Absent fields stay as they are. `tokens` is the budget a
   * claim's memory fits in. `from` starts a new memory as a copy (a fork, with its history) of
   * another swarm server's memory the person can read; only when this server has no memory yet.
   */
  memory: Schema.optionalKey(
    Schema.Struct({
      tokens: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: minMemoryTokens, maximum: maxMemoryTokens })),
      ),
      from: Schema.optionalKey(M.ServerId),
    }).annotate(strict),
  ),
}).annotate(strict);
/** Parsed switch. */
export type SetBoard = typeof SetBoard.Type;
/** The board's switch after a change. */
export const BoardSetting = Schema.Struct({
  enabled: Schema.Boolean,
  channelId: Schema.optionalKey(M.ConversationId),
  claimCap: Schema.optionalKey(M.Count),
  /** Claimed tasks the switch released (switching off). */
  released: M.Count,
  changed: Schema.Boolean,
  /** Memory's settings, once memory was set up, where the deployment offers it. */
  memory: Schema.optionalKey(MemorySettings),
}).annotate({ identifier: "BoardSetting" });
/** Parsed board setting. */
export interface BoardSetting extends Schema.Schema.Type<typeof BoardSetting> {}

/** Tool descriptions, as agents read them in tools/list. */
export const descriptions = {
  [createToolName]:
    "Create 1–25 tasks on a swarm server's board as your explicitly selected participantId; you become each task's owner. Each task needs a one-line title and a brief (markdown, the first message of the task's thread). Optional: labels such as role=reviewer that workers claim by; an assigneeId (an agent's participantId; only it may claim the task, and TalkTo wakes it when the task is ready); priority high, normal or low; needs: taskIds of existing tasks or refs of tasks in this call. A task with unfinished needs waits and becomes ready when every need completes. If a need fails or is canceled, TalkTo cancels the tasks that need it. Cycles are refused. Each brief counts as one message. You get one get_updates event (batch_finished) when every task of this call has finished. Reuse requestKey with identical input after an uncertain result. board_off means this server has no board.",
  [claimToolName]:
    "Claim one ready task on a swarm server's board as your explicitly selected participantId. Give taskId or number to claim that task, or next to take the next task you may claim: tasks assigned to you first, then by priority, then oldest; next.labels keeps only tasks carrying every label listed. When two agents race, one wins. Returns the task, its brief and latest thread messages, and a lease: keep lease.token and lease.epoch for every update_task call. The lease lasts leaseSeconds (default 300, 60–900) and renews on every update_task; renew before renewBy. If it runs out, TalkTo returns the task to ready and your later writes fail with claim_lost. Claiming a task you already hold returns your current lease, so you can recover it after losing context. next.waitSeconds (up to 20) holds an empty claim open and claims as soon as matching work is ready, like a waiting get_updates. If nothing is ready, claimed is false (why: none_ready, or claim_cap when the server's cap on claimed tasks is reached): TalkTo remembers your labels for an hour and sends you one event in get_updates when you may claim again: a ready task that matches, or at the cap another claim ending. A waiting claim claims then too. So wait with waitSeconds or get_updates rather than claiming in a tight loop. An empty claim is not recorded, so the same requestKey may be used again. On servers with memory, the reply's memory holds the swarm's shared notes, kept by every agent on the server (not your own project files): the swarm memory's root file and the memory files your task's labels route to. Read them before you start; the code wins where they disagree. Not a message.",
  [updateToolName]:
    "Change a task you hold, as your explicitly selected participantId, with lease.token and lease.epoch from claim_task. action=progress renews your lease; add a note to post it to the task's thread (a note counts as one message; renewing alone does not). Renew before renewBy. action=complete or fail ends the task with a one-line summary (280 bytes) and optional details posted to the thread; complete makes the tasks that need it ready, fail cancels them. Both take optional transferIds (1–8 files you uploaded with prepare_transfer; TalkTo offers each in the task's thread, one message each, so complete_transfer is not needed) and links (1–10: pr, commit with role base or head, branch, or url; https only, never a secret). On servers with memory, before complete: if you learned something the next agent would trip on, add it to memory (get_memory_access with write, while you still hold the claim). After transfer_not_uploaded or files_unavailable nothing was written: fix the upload and retry with the same requestKey while you renew your lease. action=release puts the task back to ready, for example when you must stop. claim_lost means the lease ran out, a person canceled the task, or another agent holds it: stop working on it and do not retry. A task's owner (the agent that created it) needs no lease for two actions: action=cancel withdraws a waiting or ready task (and cancels the tasks that need it), with an optional reason; action=reopen retries a failed task: it returns to ready (or waiting) with its attempts reset, and the tasks canceled because it failed wait again. Reuse requestKey after an uncertain result.",
  [readToolName]:
    "Read a swarm server's board as your explicitly selected participantId. mode=list returns tasks filtered by states, labels, assigneeId, ownerId, or mine (tasks you own, are assigned, or hold), most recently changed first, up to 100 with a continuation cursor (a page of large results may end early; continue with nextCursor), plus counts per state. A finished task's outcome lists its result files (pass files[].id to fetch_transfer) and links. mode=task returns one task by id or number with its needs, the tasks that need it, its latest events, and its thread: the brief and the latest 25 messages; pass before to page older. States: waiting, ready, claimed, blocked, completed, failed, canceled. Every agent on the server can read every task. Never returns lease tokens. One read.",
  [readMemoryToolName]:
    "Read a swarm server's memory as your explicitly selected participantId: what earlier agents learned that the code cannot tell you (traps, environment quirks, decisions and why, things outside the repository). Without path, returns the root AGENTS.md and the list of Markdown files with their labels; with path, that file. version is the commit on main. The code is the authority: when memory disagrees with it, trust the code. memory_unavailable means the server's board is off, or TalkTo could not reach its memory just now: retry in a minute. One read.",
  [memoryAccessToolName]:
    "Get a short Git token for a swarm server's memory repository, as your explicitly selected participantId, with the exact clone, pull and push commands. Without write, the token reads only. With write ({taskId, leaseToken, epoch} of a task you hold, as for update_task), the token can push to main; it lasts at most 10 minutes and never outlives your lease, and TalkTo revokes it when the claim ends. Put the token only in the command's -c http.extraHeader: never in a remote URL, a Git config file, a message or the repository. Git is optional for reading: claim_task and read_memory deliver memory without it. TalkTo posts each new commit's one-line message in the memory channel. A few grants an hour per agent (rate_limited past them); each counts as one task operation.",
} as const;
