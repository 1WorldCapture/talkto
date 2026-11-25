import { Clock, Effect } from "effect";
import type * as M from "@talkto/api/models";
import * as T from "@talkto/api/tasks";
import type * as Store from "../persistence.js";
import * as Model from "./model.js";
import { present } from "../present.js";

/**
 * Stored board rows as replies show them. Absent fields are left out, never null, so a reply only
 * grows (docs/mcp-compatibility.md). No reply here carries a lease token: only `lease` does, and
 * only `claim_task` returns it.
 */

/** Where task pages live: the dashboard origin and the server. */
export interface Place {
  readonly origin: string;
  readonly serverId: M.ServerId;
}

const optional = present;

/** The current claim, or null when the task is not claimed. */
const claimOf = (row: Model.TaskRow): typeof T.Claim.Type | null =>
  row.state === "claimed" &&
  row.claimerId !== null &&
  row.claimedAt !== null &&
  row.leaseExpiresAt !== null &&
  row.leaseEpoch >= 1
    ? {
        holderId: row.claimerId,
        epoch: row.leaseEpoch,
        claimedAt: Model.iso(row.claimedAt),
        expiresAt: Model.iso(row.leaseExpiresAt),
      }
    : null;
/** What a blocked task asks, or null. */
const blockOf = (row: Model.TaskRow): typeof T.Block.Type | null =>
  row.state === "blocked" &&
  row.blockKind !== null &&
  row.blockMessageId !== null &&
  row.blockedBy !== null &&
  row.blockedAt !== null
    ? {
        kind: row.blockKind,
        questionMessageId: row.blockMessageId,
        askedBy: row.blockedBy,
        askedAt: Model.iso(row.blockedAt),
        ...optional("askKey", row.blockKey),
      }
    : null;
const decisionOf = (row: Model.TaskRow): typeof T.Decision.Type | null =>
  row.decision !== null && row.decidedBy !== null && row.decidedAt !== null
    ? { kind: row.decision, byId: row.decidedBy, at: Model.iso(row.decidedAt) }
    : null;
/** A result file as replies show it; `state` is computed at `now`. */
export const resultFile = (file: Model.ResultFileRecord, now: number): T.ResultFile => ({
  id: file.transferId,
  name: file.name,
  kind: file.kind,
  bytes: file.bytes,
  sha256: file.sha256,
  fileCount: file.fileCount,
  expiresAt: Model.iso(file.expiresAt),
  state: now > file.expiresAt ? "expired" : "available",
  messageId: file.messageId,
});
/** `files` and `links` of a result, each present only when it has items. */
const resultFields = (result: Model.Result | undefined, now: number) => ({
  ...optional(
    "files",
    result === undefined || result.files.length === 0
      ? null
      : result.files.map((file) => resultFile(file, now)),
  ),
  ...optional(
    "links",
    result === undefined || result.links.length === 0 ? null : [...result.links],
  ),
});
/**
 * The attempt whose result a task shows: its last claim, when a claimer completed or failed it.
 * Reopening clears the outcome, and the next claim takes a new epoch.
 */
const currentAttempt = (row: Model.TaskRow) =>
  (row.state === "completed" || row.state === "failed") &&
  row.outcomeReason === "by_claimer" &&
  row.leaseEpoch >= 1
    ? { taskId: row.id, epoch: row.leaseEpoch }
    : null;
/** The current attempt's result of each row, read in two statements. */
const currentResults = (tx: Store.Session, rows: ReadonlyArray<Model.TaskRow>) =>
  tx.board.results(rows.flatMap((row) => currentAttempt(row) ?? []));
const resultOf = (results: ReadonlyMap<string, Model.Result>, row: Model.TaskRow) => {
  const attempt = currentAttempt(row);
  const result =
    attempt === null ? undefined : results.get(Model.resultKey(attempt.taskId, attempt.epoch));
  return result?.kind === row.state ? result : undefined;
};
const outcomeOf = (
  row: Model.TaskRow,
  result: Model.Result | undefined,
  now: number,
): typeof T.Outcome.Type | null =>
  row.finishedAt !== null && row.outcomeReason !== null
    ? {
        kind: row.state,
        reason: row.outcomeReason,
        ...optional("summary", row.outcomeSummary),
        at: Model.iso(row.finishedAt),
        ...optional("messageId", row.outcomeMessageId),
        ...resultFields(result, now),
      }
    : null;

/** One task with its labels, needs and the result of its last attempt, at `now`. */
export const task = (
  place: Place,
  row: Model.TaskRow,
  labels: ReadonlyArray<string>,
  needs: ReadonlyArray<T.TaskId>,
  result?: Model.Result,
  now = 0,
): T.Task => ({
  id: row.id,
  number: row.number,
  title: row.title,
  state: row.state,
  priority: row.priority,
  labels: [...labels],
  ownerId: row.ownerId,
  ...optional("assigneeId", row.assigneeId),
  needs: [...needs],
  ...optional("claim", claimOf(row)),
  ...optional("block", blockOf(row)),
  ...optional("decision", decisionOf(row)),
  ...optional("outcome", outcomeOf(row, result, now)),
  attempts: row.attempts,
  maxAttempts: row.maxAttempts,
  briefMessageId: row.briefMessageId,
  url: Model.taskUrl(place.origin, place.serverId, row.number),
  createdAt: Model.iso(row.createdAt),
  updatedAt: Model.iso(row.updatedAt),
  revision: row.revision,
});

/** Several tasks, with their labels, needs and results read in four statements. */
export const tasks = Effect.fn("BoardView.tasks")(function* (
  tx: Store.Session,
  place: Place,
  rows: ReadonlyArray<Model.TaskRow>,
) {
  const now = yield* Clock.currentTimeMillis;
  const ids = rows.map((row) => row.id);
  const labels = yield* tx.board.labels(ids);
  const needs = yield* tx.board.needs(ids);
  const results = yield* currentResults(tx, rows);
  return rows.map((row) =>
    task(
      place,
      row,
      labels.get(row.id) ?? [],
      needs.get(row.id) ?? [],
      resultOf(results, row),
      now,
    ),
  );
});
/** One task, re-read so the reply shows exactly what is stored. */
export const one = Effect.fn("BoardView.one")(function* (
  tx: Store.Session,
  place: Place,
  row: Model.TaskRow,
) {
  const [item] = yield* tasks(tx, place, [row]);
  if (item === undefined) return yield* Effect.die("A task view is missing");
  return item;
});

/** A short reference: what lists, needs and recovery show. */
export const summary = (row: Model.TaskRow): T.TaskSummary => ({
  id: row.id,
  number: row.number,
  title: row.title,
  state: row.state,
  ...optional("holderId", row.state === "claimed" ? row.claimerId : null),
  ...optional("assigneeId", row.assigneeId),
  ...optional(
    "expiresAt",
    row.state === "claimed" && row.leaseExpiresAt !== null ? Model.iso(row.leaseExpiresAt) : null,
  ),
});

/** The claimer's lease, or null when the task is not claimed. */
export const lease = (row: Model.TaskRow): T.Lease | null =>
  row.state === "claimed" &&
  row.leaseToken !== null &&
  row.leaseSeconds !== null &&
  row.claimedAt !== null &&
  row.leaseExpiresAt !== null &&
  row.leaseEpoch >= 1
    ? {
        token: row.leaseToken,
        epoch: row.leaseEpoch,
        leaseSeconds: row.leaseSeconds,
        claimedAt: Model.iso(row.claimedAt),
        expiresAt: Model.iso(row.leaseExpiresAt),
        renewBy: Model.iso(row.leaseExpiresAt - row.leaseSeconds * 500),
      }
    : null;

/** How many items a list has, or null for none. */
const countOf = (items: ReadonlyArray<unknown> | undefined) =>
  items === undefined || items.length === 0 ? null : items.length;
/**
 * One row of the Board's lists. `workers` is who worked on it: the agent that finished it, and the
 * agents that held it before (or before the current holder), latest first.
 */
export const boardRow = (
  row: Model.TaskRow,
  labels: ReadonlyArray<string>,
  now: number,
  workers: Model.Workers = { finishedBy: null, holders: [] },
  result?: Model.Result,
): T.BoardRow => {
  const finishedBy = Model.isFinal(row.state) ? workers.finishedBy : null;
  const current = row.state === "claimed" ? row.claimerId : finishedBy;
  const earlier = workers.holders.filter((id) => id !== current);
  const label = labels[0];
  // The holder's last note, or the claim if no note followed it.
  const note =
    row.state === "claimed" && row.claimedAt !== null
      ? Math.max(row.claimedAt, row.lastNoteAt ?? 0)
      : null;
  return {
    ...summary(row),
    priority: row.priority,
    ownerId: row.ownerId,
    ...optional("label", label),
    ...optional("lastNoteAt", note === null ? null : Model.iso(note)),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    stalled: Model.isStalled(row, now),
    silent: Model.isSilent(row, now),
    ...optional("summary", row.outcomeSummary),
    updatedAt: Model.iso(row.updatedAt),
    ...optional("finishedAt", row.finishedAt === null ? null : Model.iso(row.finishedAt)),
    ...optional("finishedById", finishedBy),
    ...optional("earlierHolderIds", earlier.length === 0 ? null : earlier),
    ...optional("resultFiles", countOf(result?.files)),
    ...optional("resultLinks", countOf(result?.links)),
  };
};
/** Board rows with their first labels. */
export const boardRows = Effect.fn("BoardView.boardRows")(function* (
  tx: Store.Session,
  rows: ReadonlyArray<Model.TaskRow>,
  now: number,
) {
  const ids = rows.map((row) => row.id);
  const labels = yield* tx.board.labels(ids);
  const workers = yield* tx.board.workers(ids);
  const results = yield* currentResults(tx, rows);
  return rows.map((row) =>
    boardRow(row, labels.get(row.id) ?? [], now, workers.get(row.id), resultOf(results, row)),
  );
});

/** Kinds whose epoch says which claim the event is about. */
const claimKinds = new Set(["claimed", "released", "expired", "completed", "failed", "canceled"]);
/**
 * Stored events as `get_updates` and `read_tasks` show them, with each person actor's current
 * name and each finished batch's totals.
 */
export const events = Effect.fn("BoardView.events")(function* (
  tx: Store.Session,
  rows: ReadonlyArray<Model.EventView>,
) {
  const actors = [
    ...new Set(
      rows.flatMap((row) =>
        row.actorKind === "person" && row.actorId !== null ? [row.actorId] : [],
      ),
    ),
  ];
  const names = new Map(
    (actors.length === 0 ? [] : yield* tx.participantsByIds(actors)).map((item) => [
      item.id,
      item.name,
    ]),
  );
  // Each completed or failed event reads its own attempt's result (migrations/task-results.sql):
  // its summary, files and links. Events written without one keep the task's current summary.
  const finishing = rows.filter((row) => row.kind === "completed" || row.kind === "failed");
  const results = yield* tx.board.results(
    finishing.map((row) => ({ taskId: row.taskId, epoch: row.epoch })),
  );
  const now = yield* Clock.currentTimeMillis;
  const batches = new Map<string, T.TaskEvent["batch"]>();
  for (const row of rows) {
    if (row.kind !== "batch_finished" || batches.has(row.batchId)) continue;
    const totals = yield* tx.board.batchCounts(row.batchId);
    batches.set(row.batchId, { id: row.batchId, ...totals });
  }
  return rows.map((row): T.TaskEvent => {
    const name = row.actorId === null ? undefined : names.get(row.actorId);
    const batch = row.kind === "batch_finished" ? batches.get(row.batchId) : undefined;
    const found =
      row.kind === "completed" || row.kind === "failed"
        ? results.get(Model.resultKey(row.taskId, row.epoch))
        : undefined;
    const result = found?.kind === row.kind ? found : undefined;
    return {
      id: row.id,
      sequence: row.seq,
      taskId: row.taskId,
      number: row.number,
      title: row.title,
      kind: row.kind,
      state: row.state,
      at: Model.iso(row.createdAt),
      actor: {
        kind: row.actorKind,
        ...optional("participantId", row.actorId),
        ...optional("name", name),
      },
      ...optional("reason", row.reason),
      ...optional("summary", result?.summary ?? row.summary),
      ...optional("holderId", row.kind === "claimed" ? row.actorId : null),
      ...optional("assigneeId", row.assigneeId),
      ...optional("epoch", claimKinds.has(row.kind) && row.epoch >= 1 ? row.epoch : null),
      ...optional("batch", batch),
      ...resultFields(result, now),
    };
  });
});
/** Participants an event names, for `included`. */
export const eventParticipants = (items: ReadonlyArray<T.TaskEvent>) => {
  const ids = new Set<M.ParticipantId>();
  for (const item of items) {
    if (item.actor.participantId !== undefined) ids.add(item.actor.participantId);
    if (item.holderId !== undefined) ids.add(item.holderId);
    if (item.assigneeId !== undefined) ids.add(item.assigneeId);
  }
  return ids;
};
