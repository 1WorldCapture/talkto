import { DateTime, Schema } from "effect";
import * as M from "@talkto/api/models";
import * as T from "@talkto/api/tasks";

/**
 * The task board's stored records (migrations/board.sql) as the domain reads and writes them.
 * Times are epoch milliseconds here; replies carry ISO timestamps.
 */

/** The board's switch: one row once it was first switched on. */
export interface Settings {
  readonly enabled: boolean;
  /** Null until the first task (or the person's switch) creates the board channel. */
  readonly channelId: M.ConversationId | null;
  readonly claimCap: number | null;
}

/** Why a task ended or moved, as task_events.reason and tasks.outcome_reason store it. */
export type Reason =
  | "needs_done"
  | "need_failed"
  | "by_claimer"
  | "by_person"
  | "by_owner"
  | "need_reopened"
  | "attempts_exhausted"
  | "participant_removed"
  | "board_off";
/** What changed, as task_events.kind stores it. */
export type EventKind =
  | "created"
  | "ready"
  | "claimed"
  | "released"
  | "expired"
  | "blocked"
  | "unblocked"
  | "completed"
  | "failed"
  | "canceled"
  | "assigned"
  | "reprioritized"
  | "reopened"
  | "batch_finished";
/** A thread message's role, as task_messages.kind stores it. */
export type MessageKind =
  | "brief"
  | "note"
  | "question"
  | "answer"
  | "decision"
  | "result"
  | "failure"
  | "cancel";

const nullable = <S extends Schema.Top>(schema: S) => Schema.NullOr(schema);
/** One stored task, every column. */
export const TaskRow = Schema.Struct({
  id: T.TaskId,
  number: T.TaskNumber,
  batchId: T.BatchId,
  title: T.Title,
  briefMessageId: M.MessageId,
  state: T.State,
  priority: T.Priority,
  ownerId: M.ParticipantId,
  assigneeId: nullable(M.ParticipantId),
  claimerId: nullable(M.ParticipantId),
  leaseToken: nullable(T.LeaseToken),
  leaseEpoch: M.Count,
  leaseSeconds: nullable(T.LeaseSeconds),
  claimedAt: nullable(M.Count),
  leaseExpiresAt: nullable(M.Count),
  attempts: M.Count,
  lastNoteAt: nullable(M.Count),
  maxAttempts: M.Count,
  blockKind: nullable(T.BlockKind),
  blockMessageId: nullable(M.MessageId),
  blockedBy: nullable(M.ParticipantId),
  blockedAt: nullable(M.Count),
  blockKey: nullable(Schema.String),
  decision: nullable(Schema.Literals(["answered", "approved", "declined"])),
  decidedBy: nullable(M.ParticipantId),
  decidedAt: nullable(M.Count),
  outcomeSummary: nullable(T.Summary),
  outcomeReason: nullable(Schema.String),
  outcomeMessageId: nullable(M.MessageId),
  revision: M.Count,
  createdAt: M.Count,
  updatedAt: M.Count,
  readyAt: nullable(M.Count),
  finishedAt: nullable(M.Count),
});
/** Parsed stored task. */
export interface TaskRow extends Schema.Schema.Type<typeof TaskRow> {}

/** One `create_tasks` call. */
export interface BatchRow {
  readonly id: T.BatchId;
  readonly ownerId: M.ParticipantId;
  readonly grantId: M.GrantId;
  readonly requestKey: M.RequestKey;
  readonly inputHash: string;
  readonly taskCount: number;
  readonly openCount: number;
  readonly createdAt: number;
  readonly finishedAt: number | null;
}

/** One event to write; `seq` comes from the shared message sequence. */
export interface EventRecord {
  readonly seq: number;
  readonly id: T.TaskEventId;
  readonly taskId: T.TaskId;
  readonly kind: EventKind;
  readonly state: T.State;
  readonly actorKind: "agent" | "person" | "system";
  readonly actorId: M.ParticipantId | null;
  readonly reason: Reason | null;
  readonly epoch: number;
  readonly createdAt: number;
}

/** A stored event with the task fields a reader needs. */
export interface EventView {
  readonly seq: number;
  readonly id: T.TaskEventId;
  readonly taskId: T.TaskId;
  readonly number: number;
  readonly title: T.Title;
  readonly kind: string;
  readonly state: string;
  readonly actorKind: string;
  readonly actorId: M.ParticipantId | null;
  readonly reason: string | null;
  readonly epoch: number;
  readonly createdAt: number;
  readonly summary: T.Summary | null;
  readonly assigneeId: M.ParticipantId | null;
  readonly batchId: T.BatchId;
}

/** Who receives one event (or one thread message) through get_updates, and whether it wakes them. */
export interface Recipient {
  readonly participantId: M.ParticipantId;
  readonly wakes: boolean;
}

/** What one claim, update or person request did, so a retry with the same key repeats it. */
export interface RequestRecord {
  readonly grantId: M.GrantId;
  readonly requestKey: M.RequestKey;
  readonly operation: "claim" | "update" | "person";
  readonly inputHash: string;
  readonly taskId: T.TaskId | null;
  readonly epoch: number | null;
  readonly eventSeq: number | null;
  readonly createdAt: number;
}

/** Epoch milliseconds to the ISO timestamp replies carry. */
export const iso = (ms: number): M.Timestamp =>
  M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(ms)));
/** An ISO timestamp to epoch milliseconds. */
export const millis = (at: M.Timestamp): number => DateTime.toEpochMillis(DateTime.makeUnsafe(at));
/** Final states: nothing leaves them. */
export const isFinal = (state: T.State) =>
  state === "completed" || state === "failed" || state === "canceled";
/**
 * The dashboard page of one task. It goes to agents, so it cannot know whether the person who
 * opens it is a guest or a member of the organization: the shared path serves guests, and the web
 * app sends a member on to the organization's route (`memberServerPath` in apps/web).
 */
export const taskUrl = (origin: string, serverId: M.ServerId, number: number) =>
  `${origin}/app/shared/${serverId}/board/T-${number}`;
/**
 * Stalled: claimed with no note for longer than the lease, or claimed again after an earlier lease
 * ran out. The dashboard's threshold is the lease length, never a separate setting.
 */
/** Silent: claimed, and its holder wrote no note for longer than its lease. */
export const isSilent = (row: TaskRow, now: number) =>
  row.state === "claimed" &&
  row.lastNoteAt !== null &&
  row.leaseSeconds !== null &&
  now - row.lastNoteAt > row.leaseSeconds * 1000;
/** Stalled: silent, or claimed again after a lease ran out (a retry). */
export const isStalled = (row: TaskRow, now: number) =>
  (row.state === "claimed" && row.attempts >= 1) || isSilent(row, now);

/** Agents recorded on one task at most (migrations/task-holders.sql). */
export const holdersKept = 16;
/**
 * Who worked on one task (migrations/task-holders.sql): the agent that finished it, if an agent
 * did, and every agent that ever claimed it, latest claim first.
 */
export interface Workers {
  readonly finishedBy: M.ParticipantId | null;
  readonly holders: ReadonlyArray<M.ParticipantId>;
}
/** What one task write records about who worked on it. */
export interface WorkerChange {
  /** A new claim: the agent that now holds the task, and when it claimed. */
  readonly claim: { readonly holder: M.ParticipantId; readonly at: number } | null;
  /**
   * The task finished, or was reopened: the agent that finished it (null when a person, a cancel
   * through its needs or running out of attempts ended it, or it was reopened). Undefined when the
   * write changes neither.
   */
  readonly finisher?: { readonly agent: M.ParticipantId; readonly at: number } | null;
}
/**
 * What a task write records: a new claim's holder, and on finishing the claimer that completed or
 * failed it or the owner agent that canceled it. The finisher is cleared on reopen.
 */
export function workerChange(before: TaskRow, after: TaskRow): WorkerChange {
  const claim =
    after.state === "claimed" &&
    after.claimerId !== null &&
    after.claimedAt !== null &&
    (before.state !== "claimed" || after.leaseEpoch !== before.leaseEpoch)
      ? { holder: after.claimerId, at: after.claimedAt }
      : null;
  if (isFinal(after.state) && !isFinal(before.state)) {
    const at = after.finishedAt ?? after.updatedAt;
    const agent =
      after.outcomeReason === "by_claimer" && after.state !== "canceled"
        ? before.claimerId
        : after.outcomeReason === "by_owner" && after.state === "canceled"
          ? after.ownerId
          : null;
    return { claim, finisher: agent === null ? null : { agent, at } };
  }
  if (isFinal(before.state) && !isFinal(after.state)) return { claim, finisher: null };
  return { claim };
}

/** One file of a result, as task_result_files copies its offer. */
export interface ResultFileRecord {
  readonly transferId: M.TransferId;
  readonly name: M.TransferName;
  readonly kind: M.TransferKind;
  readonly bytes: M.TransferBytes;
  readonly sha256: M.Sha256;
  readonly fileCount: number | null;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly messageId: M.MessageId;
}
/**
 * One attempt's result (migrations/task-results.sql): written on every claimer complete or fail,
 * with or without files and links, so each event reads its own summary.
 */
export interface ResultRecord {
  readonly taskId: T.TaskId;
  readonly epoch: number;
  readonly kind: "completed" | "failed";
  readonly summary: T.Summary;
  readonly participantId: M.ParticipantId;
  /** Links as the schema validated them, URLs as their parsed href. */
  readonly links: ReadonlyArray<T.NewLink>;
  readonly files: ReadonlyArray<ResultFileRecord>;
  readonly createdAt: number;
}
/** A stored result as readers see it. */
export interface Result {
  readonly kind: string;
  readonly summary: T.Summary;
  readonly links: ReadonlyArray<T.ResultLink>;
  readonly files: ReadonlyArray<ResultFileRecord>;
}
/** The key `BoardStore.results` answers by: one attempt of one task. */
export const resultKey = (taskId: string, epoch: number) => `${taskId}:${epoch}`;
