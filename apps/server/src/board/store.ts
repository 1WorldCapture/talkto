import type { Effect } from "effect";
import type * as M from "@talkto/api/models";
import type * as T from "@talkto/api/tasks";
import type { StorageUnavailable } from "@talkto/api/errors";
import type * as Model from "./model.js";

type Read<A> = Effect.Effect<A, StorageUnavailable>;

/** Filters of the agents' task list (`read_tasks` mode list). */
export interface ListFilter {
  readonly states: ReadonlyArray<T.State> | null;
  readonly labels: ReadonlyArray<string>;
  readonly assigneeId: M.ParticipantId | null;
  readonly ownerId: M.ParticipantId | null;
  /** Owner, assignee or holder. */
  readonly mine: M.ParticipantId | null;
  /** Continue after this (updated_at, number), most recent first. */
  readonly after: { readonly updatedAt: number; readonly number: number } | null;
  readonly limit: number;
}
/** Filters of the dashboard's task list. */
export interface BoardFilter {
  readonly view: T.BoardView;
  readonly state: T.State | null;
  readonly agentId: M.ParticipantId | null;
  readonly label: string | null;
  readonly askKey: string | null;
  readonly title: string | null;
  readonly number: number | null;
  /** Continue after this sort key (rank, priority, time, number). */
  readonly after: ReadonlyArray<number> | null;
  readonly now: number;
  readonly limit: number;
}
/** One dashboard row and the sort key that continues after it. */
export interface BoardEntry {
  readonly row: Model.TaskRow;
  readonly key: ReadonlyArray<number>;
}

/**
 * The board's tables inside one synchronous transaction (migrations/board.sql). Every operation is
 * one or a few local statements; the domain rules live in board/domain.ts.
 */
export interface BoardStore {
  readonly settings: () => Read<Model.Settings | null>;
  readonly saveSettings: (
    settings: Model.Settings & {
      readonly changedBy: M.ParticipantId | null;
      readonly at: number;
    },
  ) => Read<void>;
  /** Record the board channel, created after the settings row. */
  readonly setChannel: (id: M.ConversationId) => Read<void>;
  /** Take `count` task numbers and return the first. */
  readonly takeNumbers: (count: number) => Read<number>;
  /** The next `count` numbers of the shared message sequence; returns the last. */
  readonly allocateSequence: (count: number) => Read<number>;

  readonly batch: (grantId: M.GrantId, requestKey: M.RequestKey) => Read<Model.BatchRow | null>;
  readonly addBatch: (batch: Model.BatchRow) => Read<void>;
  /** One task of the batch finished: the batch's open count goes down, and it ends at zero. */
  readonly finishInBatch: (id: T.BatchId, at: number) => Read<Model.BatchRow>;
  /** One finished task of the batch was reopened: the batch is open again. */
  readonly reopenInBatch: (id: T.BatchId) => Read<void>;
  readonly batchCounts: (
    id: T.BatchId,
  ) => Read<{ readonly completed: number; readonly failed: number; readonly canceled: number }>;

  readonly task: (id: T.TaskId) => Read<Model.TaskRow | null>;
  readonly taskByNumber: (number: number) => Read<Model.TaskRow | null>;
  readonly tasks: (ids: ReadonlyArray<T.TaskId>) => Read<ReadonlyArray<Model.TaskRow>>;
  readonly batchTasks: (id: T.BatchId) => Read<ReadonlyArray<Model.TaskRow>>;
  readonly insertTask: (row: Model.TaskRow) => Read<void>;
  /**
   * Write every changed column of a task read in this transaction; `before` guards the write. A
   * new claim records its holder, and finishing or reopening records or clears the finisher
   * (Model.workerChange).
   */
  readonly saveTask: (before: Model.TaskRow, after: Model.TaskRow) => Read<void>;
  /**
   * Renew a claim's lease: write only `lease_expires_at`, fenced by the claim read in this
   * transaction (holder, epoch, token and revision). The row and its lease index are the only
   * writes: no other column, index or trigger is touched (the pricing study's E1).
   */
  readonly renewLease: (row: Model.TaskRow, expiresAt: number) => Read<void>;
  /** Who worked on each of these tasks (migrations/task-holders.sql); tasks with nobody are absent. */
  readonly workers: (ids: ReadonlyArray<T.TaskId>) => Read<ReadonlyMap<string, Model.Workers>>;
  /** Record one attempt's result and its files (migrations/task-results.sql). */
  readonly addResult: (record: Model.ResultRecord) => Read<void>;
  /**
   * The results of these attempts, keyed by `Model.resultKey`; attempts without one are absent
   * (no claimer finished them, or a Worker from before task results did).
   */
  readonly results: (
    attempts: ReadonlyArray<{ readonly taskId: T.TaskId; readonly epoch: number }>,
  ) => Read<ReadonlyMap<string, Model.Result>>;
  readonly addLabels: (id: T.TaskId, labels: ReadonlyArray<string>) => Read<void>;
  readonly labels: (
    ids: ReadonlyArray<T.TaskId>,
  ) => Read<ReadonlyMap<string, ReadonlyArray<string>>>;
  /** Distinct labels on the board's tasks, A–Z, at most `limit`. */
  readonly labelNames: (limit: number) => Read<ReadonlyArray<string>>;
  readonly addNeeds: (id: T.TaskId, needs: ReadonlyArray<T.TaskId>) => Read<void>;
  readonly needs: (
    ids: ReadonlyArray<T.TaskId>,
  ) => Read<ReadonlyMap<string, ReadonlyArray<T.TaskId>>>;
  readonly neededBy: (id: T.TaskId) => Read<ReadonlyArray<Model.TaskRow>>;
  /** Waiting tasks that need any of these. */
  readonly waitingDependents: (ids: ReadonlyArray<T.TaskId>) => Read<ReadonlyArray<Model.TaskRow>>;
  /** Needs of the task that have not completed. */
  readonly unmetNeeds: (id: T.TaskId) => Read<number>;
  /**
   * Times the task was reopened by its owner agent or a person (its `reopened` events); a revival
   * through a reopened need is not one.
   */
  readonly reopens: (id: T.TaskId) => Read<number>;
  /** Waiting tasks with a failed or canceled need: a cascade the alarm still owes. */
  readonly cascadeBacklog: (limit: number) => Read<ReadonlyArray<Model.TaskRow>>;
  /** Waiting tasks whose needs all completed: dependents the alarm still owes as ready. */
  readonly unlockBacklog: (limit: number) => Read<ReadonlyArray<Model.TaskRow>>;
  /**
   * Tasks canceled because a need failed, whose need was reopened since and none of whose needs is
   * failed or canceled now: they wait again, the nearest first.
   */
  readonly reviveBacklog: (limit: number) => Read<ReadonlyArray<Model.TaskRow>>;

  /** The next ready task this agent may claim, in claim order. */
  readonly nextReady: (input: {
    readonly participantId: M.ParticipantId;
    readonly labels: ReadonlyArray<string>;
    readonly assignedOnly: boolean;
  }) => Read<Model.TaskRow | null>;
  readonly counts: () => Read<T.Counts>;
  /** Tasks this agent holds with a lease that has not run out by `at`. */
  readonly holding: (participantId: M.ParticipantId, at: number) => Read<number>;
  readonly unfinished: () => Read<number>;
  readonly claimedBy: (participantId: M.ParticipantId) => Read<ReadonlyArray<Model.TaskRow>>;
  /** Every claimed task, for switching the board off. */
  readonly claimedTasks: () => Read<ReadonlyArray<Model.TaskRow>>;
  readonly assignedTo: (participantId: M.ParticipantId) => Read<ReadonlyArray<Model.TaskRow>>;
  /** Tasks held or assigned to this agent, held first, at most `limit`. */
  readonly yours: (
    participantId: M.ParticipantId,
    limit: number,
  ) => Read<ReadonlyArray<Model.TaskRow>>;
  readonly expired: (at: number, limit: number) => Read<ReadonlyArray<Model.TaskRow>>;
  readonly nextExpiry: () => Read<number | null>;
  readonly list: (filter: ListFilter) => Read<ReadonlyArray<Model.TaskRow>>;

  readonly addEvent: (event: Model.EventRecord) => Read<void>;
  readonly addEventRecipients: (
    seq: number,
    recipients: ReadonlyArray<Model.Recipient>,
  ) => Read<void>;
  readonly event: (id: string) => Read<{ readonly seq: number } | null>;
  readonly taskEvents: (id: T.TaskId, limit: number) => Read<ReadonlyArray<Model.EventView>>;
  /** Events in (boundary, ceiling]: the reader's own (`reader`) or every one (null). */
  readonly eventsBetween: (
    reader: M.ParticipantId | null,
    boundary: number,
    ceiling: number,
    limit: number,
  ) => Read<ReadonlyArray<Model.EventView>>;
  /** Waking events for the reader after `boundary`, newest first: their IDs and sequences. */
  readonly wakingEvents: (
    reader: M.ParticipantId,
    boundary: number,
    limit: number,
  ) => Read<ReadonlyArray<{ readonly id: string; readonly seq: number }>>;

  readonly addThreadMessage: (
    message: M.Message,
    taskId: T.TaskId,
    kind: Model.MessageKind,
  ) => Read<void>;
  readonly addThreadRecipients: (
    seq: number,
    recipients: ReadonlyArray<Model.Recipient>,
  ) => Read<void>;
  /** Thread message IDs, newest first, below `before` when it is given. */
  readonly thread: (
    id: T.TaskId,
    before: number | null,
    limit: number,
  ) => Read<ReadonlyArray<{ readonly id: M.MessageId; readonly seq: number }>>;

  readonly request: (
    grantId: M.GrantId,
    requestKey: M.RequestKey,
  ) => Read<Model.RequestRecord | null>;
  readonly addRequest: (record: Model.RequestRecord) => Read<void>;

  readonly putInterest: (
    participantId: M.ParticipantId,
    labels: ReadonlyArray<string>,
    since: number,
    expiresAt: number,
  ) => Read<void>;
  /**
   * Agents waiting for work these labels satisfy and not yet told about any, longest-waiting
   * first, without `exclude`.
   */
  readonly interested: (
    labels: ReadonlyArray<string>,
    at: number,
    exclude: M.ParticipantId | null,
    limit: number,
  ) => Read<ReadonlyArray<M.ParticipantId>>;
  /**
   * The agent waiting longest, not yet told about any work and not in `exclude`, for which a
   * ready task it may claim is waiting: unassigned or assigned to it, carrying every label of its
   * interest. Only a claim cap kept such an agent from claiming (spec 8.3).
   */
  readonly waitingForSlot: (
    at: number,
    exclude: ReadonlyArray<M.ParticipantId>,
  ) => Read<M.ParticipantId | null>;
  /** These agents were told about the event at `seq`; they wait again only after a new claim. */
  readonly markInterested: (ids: ReadonlyArray<M.ParticipantId>, seq: number) => Read<void>;
  readonly removeInterest: (participantId: M.ParticipantId) => Read<void>;
  readonly removeInterests: () => Read<void>;
  readonly removeExpired: (at: number) => Read<void>;

  /** The dashboard's Board top. */
  readonly summary: (now: number) => Read<{
    readonly counts: T.Counts;
    readonly stalled: number;
    readonly finishedSince: number;
    readonly agents: { readonly total: number; readonly working: number; readonly stalled: number };
    readonly stalledRows: ReadonlyArray<Model.TaskRow>;
    readonly failedRows: ReadonlyArray<Model.TaskRow>;
  }>;
  /** What changes the Board top: the newest event, the stalled count and the newest note. */
  readonly version: (now: number) => Read<string>;
  readonly boardList: (filter: BoardFilter) => Read<ReadonlyArray<BoardEntry>>;
}
