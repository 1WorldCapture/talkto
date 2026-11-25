import { Effect, Schema } from "effect";
import * as M from "@talkto/api/models";
import * as T from "@talkto/api/tasks";
import type { StorageUnavailable } from "@talkto/api/errors";
import * as Model from "../board/model.js";
import type * as Store from "../board/store.js";

/** The statement helpers of the SQLite session (storage/sqlite.ts). */
export interface Helpers {
  readonly execute: (
    query: string,
    bindings?: ReadonlyArray<SqlStorageValue>,
  ) => Effect.Effect<ReadonlyArray<Record<string, SqlStorageValue>>, StorageUnavailable>;
  readonly all: <A>(
    schema: Schema.Decoder<A>,
    query: string,
    bindings?: ReadonlyArray<SqlStorageValue>,
  ) => Effect.Effect<ReadonlyArray<A>, StorageUnavailable>;
  readonly one: <A>(
    schema: Schema.Decoder<A>,
    query: string,
    bindings?: ReadonlyArray<SqlStorageValue>,
  ) => Effect.Effect<A | null, StorageUnavailable>;
  readonly allocateSequence: (count: number) => Effect.Effect<number, StorageUnavailable>;
}

const taskColumns = `t.id, t.number, t.batch_id AS batchId, t.title, t.brief_message_id AS briefMessageId,
 t.state, t.priority, t.owner_participant_id AS ownerId, t.assignee_id AS assigneeId,
 t.claimer_id AS claimerId, t.lease_token AS leaseToken, t.lease_epoch AS leaseEpoch,
 t.lease_seconds AS leaseSeconds, t.claimed_at AS claimedAt, t.lease_expires_at AS leaseExpiresAt,
 t.attempts, t.last_note_at AS lastNoteAt, t.max_attempts AS maxAttempts, t.block_kind AS blockKind,
 t.block_message_id AS blockMessageId, t.blocked_by_participant_id AS blockedBy,
 t.blocked_at AS blockedAt, t.block_key AS blockKey, t.decision,
 t.decided_by_participant_id AS decidedBy, t.decided_at AS decidedAt,
 t.outcome_summary AS outcomeSummary, t.outcome_reason AS outcomeReason,
 t.outcome_message_id AS outcomeMessageId, t.revision, t.created_at AS createdAt,
 t.updated_at AS updatedAt, t.ready_at AS readyAt, t.finished_at AS finishedAt`;
/** Claim order: assigned to the claimer first, then priority, then oldest ready, then number. */
const priorityRank = "CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END";
/** The Stalled rule (board/model.ts `isStalled`) in SQL; binds `now` once. */
const stalledSql = `(t.state='claimed' AND (t.attempts>=1 OR t.last_note_at < ? - t.lease_seconds*1000))`;
const settingsRow = Schema.Struct({
  enabled: Schema.Literals([0, 1]),
  channelId: Schema.NullOr(M.ConversationId),
  claimCap: Schema.NullOr(M.Count),
});
const batchRow = Schema.Struct({
  id: T.BatchId,
  ownerId: M.ParticipantId,
  grantId: M.GrantId,
  requestKey: M.RequestKey,
  inputHash: Schema.String,
  taskCount: M.Count,
  openCount: M.Count,
  createdAt: M.Count,
  finishedAt: Schema.NullOr(M.Count),
});
const batchColumns = `id, owner_participant_id AS ownerId, created_by_grant_id AS grantId,
 request_key AS requestKey, input_hash AS inputHash, task_count AS taskCount, open_count AS openCount,
 created_at AS createdAt, finished_at AS finishedAt`;
const workerRow = Schema.Struct({
  taskId: T.TaskId,
  participantId: M.ParticipantId,
  finished: Schema.Literals([0, 1]),
  at: M.Count,
});
const eventRow = Schema.Struct({
  seq: M.Count,
  id: T.TaskEventId,
  taskId: T.TaskId,
  number: T.TaskNumber,
  title: T.Title,
  kind: Schema.String,
  state: Schema.String,
  actorKind: Schema.String,
  actorId: Schema.NullOr(M.ParticipantId),
  reason: Schema.NullOr(Schema.String),
  epoch: M.Count,
  createdAt: M.Count,
  summary: Schema.NullOr(T.Summary),
  assigneeId: Schema.NullOr(M.ParticipantId),
  batchId: T.BatchId,
});
const eventColumns = `e.seq, e.id, e.task_id AS taskId, t.number, t.title, e.kind, e.state,
 e.actor_kind AS actorKind, e.actor_participant_id AS actorId, e.reason, e.epoch,
 e.created_at AS createdAt,
 CASE WHEN e.kind IN ('completed','failed') THEN t.outcome_summary END AS summary,
 t.assignee_id AS assigneeId, t.batch_id AS batchId`;
const requestRow = Schema.Struct({
  grantId: M.GrantId,
  requestKey: M.RequestKey,
  operation: Schema.Literals(["claim", "update", "person"]),
  inputHash: Schema.String,
  taskId: Schema.NullOr(T.TaskId),
  epoch: Schema.NullOr(M.Count),
  eventSeq: Schema.NullOr(M.Count),
  createdAt: M.Count,
});
const resultRow = Schema.Struct({
  taskId: T.TaskId,
  epoch: M.Count,
  kind: Schema.String,
  summary: T.Summary,
  links: Schema.fromJsonString(Schema.Array(T.ResultLink)),
});
const resultFileRow = Schema.Struct({
  taskId: T.TaskId,
  epoch: M.Count,
  transferId: M.TransferId,
  name: M.TransferName,
  kind: M.TransferKind,
  bytes: M.TransferBytes,
  sha256: M.Sha256,
  fileCount: Schema.NullOr(M.Count),
  expiresAt: M.Count,
  messageId: M.MessageId,
});
/** Attempts as `[taskId, epoch]` pairs for json_each. */
const attemptsJson = (
  attempts: ReadonlyArray<{ readonly taskId: T.TaskId; readonly epoch: number }>,
) => JSON.stringify(attempts.map((item) => [item.taskId, item.epoch]));
const countRow = Schema.Struct({ count: M.Count });
const json = (values: ReadonlyArray<string>) => JSON.stringify(values);

/** The SQLite board store over the session's statement helpers. */
export const make = ({ execute, all, one, allocateSequence }: Helpers): Store.BoardStore => {
  const tasks = (where: string, bindings: ReadonlyArray<SqlStorageValue> = []) =>
    all(Model.TaskRow, `SELECT ${taskColumns} FROM tasks t ${where}`, bindings);
  const task = (where: string, bindings: ReadonlyArray<SqlStorageValue>) =>
    one(Model.TaskRow, `SELECT ${taskColumns} FROM tasks t ${where}`, bindings);
  const count = (query: string, bindings: ReadonlyArray<SqlStorageValue> = []) =>
    one(countRow, query, bindings).pipe(Effect.map((row) => row?.count ?? 0));
  const counts = Effect.fnUntraced(function* () {
    const rows = yield* all(
      Schema.Struct({ state: T.State, count: M.Count }),
      "SELECT state, COUNT(*) AS count FROM tasks GROUP BY state",
    );
    const found = new Map(rows.map((row) => [row.state, row.count]));
    return T.Counts.make({
      waiting: found.get("waiting") ?? 0,
      ready: found.get("ready") ?? 0,
      claimed: found.get("claimed") ?? 0,
      blocked: found.get("blocked") ?? 0,
      completed: found.get("completed") ?? 0,
      failed: found.get("failed") ?? 0,
      canceled: found.get("canceled") ?? 0,
    });
  });
  /**
   * Record a write's new holder (once per agent, at most Model.holdersKept per task, its latest
   * claim kept) and its finisher, or clear the finisher on reopen.
   */
  const recordWorkers = (before: Model.TaskRow, after: Model.TaskRow) => {
    const change = Model.workerChange(before, after);
    const claim =
      change.claim === null
        ? Effect.void
        : execute(
            `INSERT INTO task_holders(task_id,participant_id,first_claimed_at,last_claimed_at)
             SELECT ?1,?2,?3,?3 WHERE (SELECT COUNT(*) FROM task_holders WHERE task_id=?1) < ?4
               OR EXISTS (SELECT 1 FROM task_holders WHERE task_id=?1 AND participant_id=?2)
             ON CONFLICT(task_id,participant_id) DO UPDATE SET last_claimed_at=excluded.last_claimed_at`,
            [after.id, change.claim.holder, change.claim.at, Model.holdersKept],
          );
    const finisher =
      change.finisher === undefined
        ? Effect.void
        : change.finisher === null
          ? execute("DELETE FROM task_finishers WHERE task_id=?", [after.id])
          : execute(
              "INSERT OR REPLACE INTO task_finishers(task_id,participant_id,finished_at) VALUES(?,?,?)",
              [after.id, change.finisher.agent, change.finisher.at],
            );
    return Effect.all([claim, finisher], { discard: true });
  };
  /** Holders by latest claim, then the finisher, into one record per task. */
  const groupWorkers = (rows: ReadonlyArray<typeof workerRow.Type>) =>
    Effect.sync(() => {
      const map = new Map<string, Model.Workers>();
      for (const row of rows) {
        const current = map.get(row.taskId) ?? { finishedBy: null, holders: [] };
        map.set(
          row.taskId,
          row.finished === 1
            ? { ...current, finishedBy: row.participantId }
            : { ...current, holders: [...current.holders, row.participantId] },
        );
      }
      return map;
    });
  const grouped = <K extends string, V>(
    rows: ReadonlyArray<{ readonly key: K; readonly value: V }>,
  ): ReadonlyMap<string, ReadonlyArray<V>> => {
    const map = new Map<string, V[]>();
    for (const row of rows) {
      const list = map.get(row.key) ?? [];
      list.push(row.value);
      map.set(row.key, list);
    }
    return map;
  };
  return {
    settings: () =>
      one(
        settingsRow,
        "SELECT enabled, channel_id AS channelId, claim_cap AS claimCap FROM board_settings WHERE singleton=1",
      ).pipe(
        Effect.map((row) =>
          row === null
            ? null
            : { enabled: row.enabled === 1, channelId: row.channelId, claimCap: row.claimCap },
        ),
      ),
    saveSettings: (settings) =>
      execute(
        `INSERT INTO board_settings(singleton,enabled,channel_id,claim_cap,changed_by_participant_id,changed_at)
         VALUES(1,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET enabled=excluded.enabled,
         channel_id=excluded.channel_id,claim_cap=excluded.claim_cap,changed_by_participant_id=excluded.changed_by_participant_id,
         changed_at=excluded.changed_at`,
        [
          settings.enabled ? 1 : 0,
          settings.channelId,
          settings.claimCap,
          settings.changedBy,
          settings.at,
        ],
      ).pipe(Effect.asVoid),
    setChannel: (id) =>
      execute("UPDATE board_settings SET channel_id=? WHERE singleton=1", [id]).pipe(Effect.asVoid),
    takeNumbers: (n) =>
      one(
        Schema.Struct({ first: M.Count }),
        "UPDATE board_settings SET next_number=next_number+? WHERE singleton=1 RETURNING next_number-? AS first",
        [n, n],
      ).pipe(
        Effect.flatMap((row) =>
          row === null ? Effect.die("The board has no settings row") : Effect.succeed(row.first),
        ),
      ),
    allocateSequence,
    batch: (grantId, requestKey) =>
      one(
        batchRow,
        `SELECT ${batchColumns} FROM task_batches WHERE created_by_grant_id=? AND request_key=?`,
        [grantId, requestKey],
      ),
    addBatch: (batch) =>
      execute(
        `INSERT INTO task_batches(id,owner_participant_id,created_by_grant_id,request_key,input_hash,task_count,open_count,created_at,finished_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [
          batch.id,
          batch.ownerId,
          batch.grantId,
          batch.requestKey,
          batch.inputHash,
          batch.taskCount,
          batch.openCount,
          batch.createdAt,
          batch.finishedAt,
        ],
      ).pipe(Effect.asVoid),
    finishInBatch: (id, at) =>
      one(
        batchRow,
        `UPDATE task_batches SET open_count=open_count-1,
         finished_at=CASE WHEN open_count=1 THEN MAX(?,created_at) ELSE NULL END
         WHERE id=? AND open_count>0 RETURNING ${batchColumns}`,
        [at, id],
      ).pipe(
        Effect.flatMap((row) =>
          row === null
            ? Effect.die("A finished task's batch was already closed")
            : Effect.succeed(row),
        ),
      ),
    reopenInBatch: (id) =>
      execute(
        "UPDATE task_batches SET open_count=open_count+1, finished_at=NULL WHERE id=? AND open_count<task_count",
        [id],
      ).pipe(Effect.asVoid),
    batchCounts: (id) =>
      one(
        Schema.Struct({ completed: M.Count, failed: M.Count, canceled: M.Count }),
        `SELECT COALESCE(SUM(state='completed'),0) AS completed, COALESCE(SUM(state='failed'),0) AS failed,
         COALESCE(SUM(state='canceled'),0) AS canceled FROM tasks WHERE batch_id=?`,
        [id],
      ).pipe(Effect.map((row) => row ?? { completed: 0, failed: 0, canceled: 0 })),
    task: (id) => task("WHERE t.id=?", [id]),
    taskByNumber: (n) => task("WHERE t.number=?", [n]),
    tasks: (ids) =>
      ids.length === 0
        ? Effect.succeed([])
        : tasks("WHERE t.id IN (SELECT value FROM json_each(?)) ORDER BY t.number", [json(ids)]),
    batchTasks: (id) => tasks("WHERE t.batch_id=? ORDER BY t.number", [id]),
    insertTask: (row) =>
      execute(
        `INSERT INTO tasks(id,number,batch_id,title,brief_message_id,state,priority,owner_participant_id,
         assignee_id,max_attempts,revision,created_at,updated_at,ready_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          row.id,
          row.number,
          row.batchId,
          row.title,
          row.briefMessageId,
          row.state,
          row.priority,
          row.ownerId,
          row.assigneeId,
          row.maxAttempts,
          row.revision,
          row.createdAt,
          row.updatedAt,
          row.readyAt,
        ],
      ).pipe(Effect.asVoid),
    saveTask: (before, after) =>
      execute(
        `UPDATE tasks SET state=?, priority=?, assignee_id=?, claimer_id=?, lease_token=?, lease_epoch=?,
         lease_seconds=?, claimed_at=?, lease_expires_at=?, attempts=?, last_note_at=?, block_kind=?,
         block_message_id=?, blocked_by_participant_id=?, blocked_at=?, block_key=?, decision=?,
         decided_by_participant_id=?, decided_at=?, outcome_summary=?, outcome_reason=?,
         outcome_message_id=?, revision=?, updated_at=?, ready_at=?, finished_at=?
         WHERE id=? AND revision=? RETURNING id`,
        [
          after.state,
          after.priority,
          after.assigneeId,
          after.claimerId,
          after.leaseToken,
          after.leaseEpoch,
          after.leaseSeconds,
          after.claimedAt,
          after.leaseExpiresAt,
          after.attempts,
          after.lastNoteAt,
          after.blockKind,
          after.blockMessageId,
          after.blockedBy,
          after.blockedAt,
          after.blockKey,
          after.decision,
          after.decidedBy,
          after.decidedAt,
          after.outcomeSummary,
          after.outcomeReason,
          after.outcomeMessageId,
          after.revision,
          after.updatedAt,
          after.readyAt,
          after.finishedAt,
          before.id,
          before.revision,
        ],
      ).pipe(
        Effect.flatMap((rows) =>
          rows.length === 1 ? Effect.void : Effect.die("A task changed inside its own transaction"),
        ),
        Effect.andThen(recordWorkers(before, after)),
      ),
    renewLease: (row, expiresAt) =>
      execute(
        `UPDATE tasks SET lease_expires_at=? WHERE id=? AND state='claimed' AND claimer_id=?
         AND lease_epoch=? AND lease_token=? AND revision=? RETURNING id`,
        [expiresAt, row.id, row.claimerId, row.leaseEpoch, row.leaseToken, row.revision],
      ).pipe(
        Effect.flatMap((rows) =>
          rows.length === 1 ? Effect.void : Effect.die("A task changed inside its own transaction"),
        ),
      ),
    workers: (ids) =>
      ids.length === 0
        ? Effect.succeed(new Map())
        : all(
            workerRow,
            `SELECT h.task_id AS taskId, h.participant_id AS participantId, 0 AS finished,
               h.last_claimed_at AS at
             FROM task_holders h WHERE h.task_id IN (SELECT value FROM json_each(?1))
             UNION ALL
             SELECT f.task_id, f.participant_id, 1, f.finished_at FROM task_finishers f
             WHERE f.task_id IN (SELECT value FROM json_each(?1))
             ORDER BY taskId, finished DESC, at DESC, participantId`,
            [json(ids)],
          ).pipe(Effect.flatMap(groupWorkers)),
    addResult: (record) =>
      Effect.gen(function* () {
        yield* execute(
          `INSERT INTO task_results(task_id,epoch,kind,summary,participant_id,links,created_at)
           VALUES(?,?,?,?,?,?,?)`,
          [
            record.taskId,
            record.epoch,
            record.kind,
            record.summary,
            record.participantId,
            JSON.stringify(record.links),
            record.createdAt,
          ],
        );
        if (record.files.length === 0) return;
        yield* execute(
          `INSERT INTO task_result_files(task_id,epoch,position,transfer_id,name,kind,bytes,sha256,
             file_count,expires_at,message_id)
           SELECT ?1,?2,key,json_extract(value,'$.transferId'),json_extract(value,'$.name'),
             json_extract(value,'$.kind'),json_extract(value,'$.bytes'),json_extract(value,'$.sha256'),
             json_extract(value,'$.fileCount'),json_extract(value,'$.expiresAt'),
             json_extract(value,'$.messageId')
           FROM json_each(?3)`,
          [record.taskId, record.epoch, JSON.stringify(record.files)],
        );
      }),
    results: (attempts) =>
      attempts.length === 0
        ? Effect.succeed(new Map())
        : Effect.gen(function* () {
            const pairs = attemptsJson(attempts);
            const rows = yield* all(
              resultRow,
              `SELECT r.task_id AS taskId, r.epoch, r.kind, r.summary, r.links
               FROM json_each(?) j JOIN task_results r
                 ON r.task_id=json_extract(j.value,'$[0]') AND r.epoch=json_extract(j.value,'$[1]')`,
              [pairs],
            );
            if (rows.length === 0) return new Map<string, Model.Result>();
            const files = yield* all(
              resultFileRow,
              `SELECT f.task_id AS taskId, f.epoch, f.transfer_id AS transferId, f.name, f.kind,
                 f.bytes, f.sha256, f.file_count AS fileCount, f.expires_at AS expiresAt,
                 f.message_id AS messageId
               FROM json_each(?) j JOIN task_result_files f
                 ON f.task_id=json_extract(j.value,'$[0]') AND f.epoch=json_extract(j.value,'$[1]')
               ORDER BY f.task_id, f.epoch, f.position`,
              [pairs],
            );
            const byAttempt = new Map<string, Model.ResultFileRecord[]>();
            for (const { taskId, epoch, ...file } of files) {
              const key = Model.resultKey(taskId, epoch);
              const list = byAttempt.get(key) ?? [];
              list.push(file);
              byAttempt.set(key, list);
            }
            return new Map(
              rows.map((row): [string, Model.Result] => {
                const key = Model.resultKey(row.taskId, row.epoch);
                return [
                  key,
                  {
                    kind: row.kind,
                    summary: row.summary,
                    links: row.links,
                    files: byAttempt.get(key) ?? [],
                  },
                ];
              }),
            );
          }),
    addLabels: (id, labels) =>
      labels.length === 0
        ? Effect.void
        : execute("INSERT INTO task_labels(label,task_id) SELECT value,? FROM json_each(?)", [
            id,
            json(labels),
          ]).pipe(Effect.asVoid),
    labels: (ids) =>
      ids.length === 0
        ? Effect.succeed(new Map())
        : all(
            Schema.Struct({ key: Schema.String, value: Schema.String }),
            `SELECT task_id AS key, label AS value FROM task_labels
             WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY task_id, label`,
            [json(ids)],
          ).pipe(Effect.map(grouped)),
    // The primary key (label, task_id) leads with the label, so this walks one index.
    labelNames: (limit) =>
      all(
        Schema.Struct({ label: Schema.String }),
        "SELECT DISTINCT label FROM task_labels ORDER BY label LIMIT ?",
        [limit],
      ).pipe(Effect.map((rows) => rows.map((row) => row.label))),
    addNeeds: (id, needs) =>
      needs.length === 0
        ? Effect.void
        : execute("INSERT INTO task_needs(task_id,need_id) SELECT ?,value FROM json_each(?)", [
            id,
            json(needs),
          ]).pipe(Effect.asVoid),
    needs: (ids) =>
      ids.length === 0
        ? Effect.succeed(new Map())
        : all(
            Schema.Struct({ key: Schema.String, value: T.TaskId }),
            `SELECT n.task_id AS key, n.need_id AS value FROM task_needs n JOIN tasks d ON d.id=n.need_id
             WHERE n.task_id IN (SELECT value FROM json_each(?)) ORDER BY n.task_id, d.number`,
            [json(ids)],
          ).pipe(Effect.map(grouped)),
    neededBy: (id) =>
      tasks("JOIN task_needs n ON n.task_id=t.id WHERE n.need_id=? ORDER BY t.number", [id]),
    waitingDependents: (ids) =>
      ids.length === 0
        ? Effect.succeed([])
        : tasks(
            `WHERE t.state='waiting' AND t.id IN (SELECT n.task_id FROM task_needs n
             WHERE n.need_id IN (SELECT value FROM json_each(?))) ORDER BY t.number`,
            [json(ids)],
          ),
    unmetNeeds: (id) =>
      count(
        `SELECT COUNT(*) AS count FROM task_needs n JOIN tasks d ON d.id=n.need_id
         WHERE n.task_id=? AND d.state<>'completed'`,
        [id],
      ),
    // The task's events through task_events_task; a task holds a bounded number of them.
    reopens: (id) =>
      count(
        `SELECT COUNT(*) AS count FROM task_events
         WHERE task_id=? AND kind='reopened' AND reason IN ('by_owner','by_person')`,
        [id],
      ),
    cascadeBacklog: (limit) =>
      tasks(
        `WHERE t.state='waiting' AND EXISTS (SELECT 1 FROM task_needs n JOIN tasks d ON d.id=n.need_id
         WHERE n.task_id=t.id AND d.state IN ('failed','canceled')) ORDER BY t.number LIMIT ?`,
        [limit],
      ),
    unlockBacklog: (limit) =>
      tasks(
        `WHERE t.state='waiting' AND NOT EXISTS (SELECT 1 FROM task_needs n JOIN tasks d ON d.id=n.need_id
         WHERE n.task_id=t.id AND d.state<>'completed') ORDER BY t.number LIMIT ?`,
        [limit],
      ),
    // Driven from open tasks: a canceled dependent of one that was reopened after the dependent's
    // cancel, and canceled at or after that need failed or was canceled, so a task canceled for
    // another need's failure stays canceled.
    reviveBacklog: (limit) =>
      all(
        Model.TaskRow,
        `SELECT DISTINCT ${taskColumns} FROM tasks n JOIN task_needs e ON e.need_id=n.id
         JOIN tasks t ON t.id=e.task_id
         WHERE n.state IN ('waiting','ready','claimed','blocked') AND t.state='canceled'
         AND t.outcome_reason='need_failed'
         AND EXISTS (SELECT 1 FROM task_events f WHERE f.task_id=n.id
           AND f.kind IN ('failed','canceled') AND f.created_at<=t.finished_at)
         AND EXISTS (SELECT 1 FROM task_events r WHERE r.task_id=n.id AND r.kind='reopened'
           AND r.created_at>=t.finished_at)
         AND NOT EXISTS (SELECT 1 FROM task_needs m JOIN tasks x ON x.id=m.need_id
           WHERE m.task_id=t.id AND x.state IN ('failed','canceled'))
         ORDER BY t.number LIMIT ?`,
        [limit],
      ),
    nextReady: ({ participantId, labels, assignedOnly }) =>
      task(
        `WHERE t.state='ready' AND ${assignedOnly ? "t.assignee_id=?" : "(t.assignee_id IS NULL OR t.assignee_id=?)"}
         AND (SELECT COUNT(*) FROM task_labels l WHERE l.task_id=t.id
           AND l.label IN (SELECT value FROM json_each(?)))=?
         ORDER BY t.assignee_id IS NULL, ${priorityRank}, t.ready_at, t.number LIMIT 1`,
        [participantId, json(labels), labels.length],
      ),
    counts,
    holding: (participantId, at) =>
      count(
        "SELECT COUNT(*) AS count FROM tasks WHERE state='claimed' AND claimer_id=? AND lease_expires_at>?",
        [participantId, at],
      ),
    unfinished: () =>
      count(
        "SELECT COUNT(*) AS count FROM tasks WHERE state IN ('waiting','ready','claimed','blocked')",
      ),
    claimedBy: (participantId) =>
      tasks("WHERE t.state='claimed' AND t.claimer_id=? ORDER BY t.number", [participantId]),
    claimedTasks: () => tasks("WHERE t.state='claimed' ORDER BY t.number"),
    assignedTo: (participantId) =>
      tasks(
        "WHERE t.assignee_id=? AND t.state IN ('waiting','ready','claimed','blocked') ORDER BY t.number",
        [participantId],
      ),
    yours: (participantId, limit) =>
      tasks(
        `WHERE (t.state='claimed' AND t.claimer_id=?) OR (t.assignee_id=? AND t.state IN ('waiting','ready','blocked'))
         ORDER BY t.state<>'claimed', t.number LIMIT ?`,
        [participantId, participantId, limit],
      ),
    expired: (at, limit) =>
      tasks(
        "WHERE t.state='claimed' AND t.lease_expires_at<=? ORDER BY t.lease_expires_at, t.number LIMIT ?",
        [at, limit],
      ),
    nextExpiry: () =>
      one(
        Schema.Struct({ at: Schema.NullOr(M.Count) }),
        "SELECT MIN(lease_expires_at) AS at FROM tasks WHERE state='claimed'",
      ).pipe(Effect.map((row) => row?.at ?? null)),
    list: (filter) => {
      const where: string[] = [];
      const bindings: SqlStorageValue[] = [];
      if (filter.states !== null) {
        where.push("t.state IN (SELECT value FROM json_each(?))");
        bindings.push(json(filter.states));
      }
      if (filter.labels.length > 0) {
        where.push(
          "(SELECT COUNT(*) FROM task_labels l WHERE l.task_id=t.id AND l.label IN (SELECT value FROM json_each(?)))=?",
        );
        bindings.push(json(filter.labels), filter.labels.length);
      }
      if (filter.assigneeId !== null) {
        where.push("t.assignee_id=?");
        bindings.push(filter.assigneeId);
      }
      if (filter.ownerId !== null) {
        where.push("t.owner_participant_id=?");
        bindings.push(filter.ownerId);
      }
      if (filter.mine !== null) {
        where.push(
          "(t.owner_participant_id=? OR t.assignee_id=? OR (t.state='claimed' AND t.claimer_id=?))",
        );
        bindings.push(filter.mine, filter.mine, filter.mine);
      }
      if (filter.after !== null) {
        where.push("(t.updated_at, t.number) < (?, ?)");
        bindings.push(filter.after.updatedAt, filter.after.number);
      }
      return tasks(
        `${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
         ORDER BY t.updated_at DESC, t.number DESC LIMIT ?`,
        [...bindings, filter.limit],
      );
    },
    addEvent: (event) =>
      execute(
        `INSERT INTO task_events(seq,id,task_id,kind,state,actor_kind,actor_participant_id,reason,epoch,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          event.seq,
          event.id,
          event.taskId,
          event.kind,
          event.state,
          event.actorKind,
          event.actorId,
          event.reason,
          event.epoch,
          event.createdAt,
        ],
      ).pipe(Effect.asVoid),
    addEventRecipients: (seq, recipients) =>
      recipients.length === 0
        ? Effect.void
        : execute(
            `INSERT INTO task_event_recipients(participant_id,seq,wakes)
             SELECT json_extract(value,'$[0]'),?,json_extract(value,'$[1]') FROM json_each(?)`,
            [seq, JSON.stringify(recipients.map((r) => [r.participantId, r.wakes ? 1 : 0]))],
          ).pipe(Effect.asVoid),
    event: (id) =>
      one(Schema.Struct({ seq: M.Count }), "SELECT seq FROM task_events WHERE id=?", [id]),
    taskEvents: (id, limit) =>
      all(
        eventRow,
        `SELECT * FROM (SELECT ${eventColumns} FROM task_events e JOIN tasks t ON t.id=e.task_id
         WHERE e.task_id=? ORDER BY e.seq DESC LIMIT ?) ORDER BY seq`,
        [id, limit],
      ),
    eventsBetween: (reader, boundary, ceiling, limit) =>
      reader === null
        ? all(
            eventRow,
            `SELECT ${eventColumns} FROM task_events e JOIN tasks t ON t.id=e.task_id
             WHERE e.seq>? AND e.seq<=? ORDER BY e.seq LIMIT ?`,
            [boundary, ceiling, limit],
          )
        : all(
            eventRow,
            `SELECT ${eventColumns} FROM task_event_recipients r JOIN task_events e ON e.seq=r.seq
             JOIN tasks t ON t.id=e.task_id
             WHERE r.participant_id=? AND r.seq>? AND r.seq<=? ORDER BY r.seq LIMIT ?`,
            [reader, boundary, ceiling, limit],
          ),
    wakingEvents: (reader, boundary, limit) =>
      all(
        Schema.Struct({ id: Schema.String, seq: M.Count }),
        `SELECT e.id, e.seq FROM task_event_recipients r JOIN task_events e ON e.seq=r.seq
         WHERE r.participant_id=? AND r.seq>? AND r.wakes=1 ORDER BY r.seq DESC LIMIT ?`,
        [reader, boundary, limit],
      ),
    addThreadMessage: (message, taskId, kind) =>
      execute("INSERT INTO task_messages(message_id,seq,task_id,kind) VALUES(?,?,?,?)", [
        message.id,
        message.sequence,
        taskId,
        kind,
      ]).pipe(Effect.asVoid),
    addThreadRecipients: (seq, recipients) =>
      recipients.length === 0
        ? Effect.void
        : execute(
            `INSERT INTO task_message_recipients(participant_id,seq,wakes)
             SELECT json_extract(value,'$[0]'),?,json_extract(value,'$[1]') FROM json_each(?)`,
            [seq, JSON.stringify(recipients.map((r) => [r.participantId, r.wakes ? 1 : 0]))],
          ).pipe(Effect.asVoid),
    thread: (id, before, limit) =>
      all(
        Schema.Struct({ id: M.MessageId, seq: M.Count }),
        `SELECT message_id AS id, seq FROM task_messages WHERE task_id=? AND (? IS NULL OR seq<?)
         ORDER BY seq DESC LIMIT ?`,
        [id, before, before, limit],
      ),
    request: (grantId, requestKey) =>
      one(
        requestRow,
        `SELECT created_by_grant_id AS grantId, request_key AS requestKey, operation, input_hash AS inputHash,
         task_id AS taskId, epoch, event_seq AS eventSeq, created_at AS createdAt
         FROM task_requests WHERE created_by_grant_id=? AND request_key=?`,
        [grantId, requestKey],
      ),
    addRequest: (record) =>
      execute(
        `INSERT INTO task_requests(created_by_grant_id,request_key,operation,input_hash,task_id,epoch,event_seq,created_at)
         VALUES(?,?,?,?,?,?,?,?)`,
        [
          record.grantId,
          record.requestKey,
          record.operation,
          record.inputHash,
          record.taskId,
          record.epoch,
          record.eventSeq,
          record.createdAt,
        ],
      ).pipe(Effect.asVoid),
    putInterest: (participantId, labels, since, expiresAt) =>
      execute(
        `INSERT INTO task_interests(participant_id,labels,since,expires_at,woken_seq) VALUES(?,?,?,?,NULL)
         ON CONFLICT(participant_id) DO UPDATE SET labels=excluded.labels,since=excluded.since,
         expires_at=excluded.expires_at,woken_seq=NULL`,
        [participantId, json(labels), since, expiresAt],
      ).pipe(Effect.asVoid),
    interested: (labels, at, exclude, limit) =>
      all(
        Schema.Struct({ participantId: M.ParticipantId }),
        `SELECT participant_id AS participantId FROM task_interests i
         WHERE i.woken_seq IS NULL AND i.expires_at>? AND i.participant_id<>?
         AND NOT EXISTS (SELECT 1 FROM json_each(i.labels) j
           WHERE j.value NOT IN (SELECT value FROM json_each(?)))
         ORDER BY i.since, i.participant_id LIMIT ?`,
        [at, exclude ?? "", json(labels), limit],
      ).pipe(Effect.map((rows) => rows.map((row) => row.participantId))),
    waitingForSlot: (at, exclude) =>
      one(
        Schema.Struct({ participantId: M.ParticipantId }),
        `SELECT participant_id AS participantId FROM task_interests i
         WHERE i.woken_seq IS NULL AND i.expires_at>?
         AND i.participant_id NOT IN (SELECT value FROM json_each(?))
         AND EXISTS (SELECT 1 FROM tasks t WHERE t.state='ready'
           AND (t.assignee_id IS NULL OR t.assignee_id=i.participant_id)
           AND NOT EXISTS (SELECT 1 FROM json_each(i.labels) j WHERE NOT EXISTS
             (SELECT 1 FROM task_labels l WHERE l.task_id=t.id AND l.label=j.value)))
         ORDER BY i.since, i.participant_id LIMIT 1`,
        [at, json(exclude)],
      ).pipe(Effect.map((row) => row?.participantId ?? null)),
    markInterested: (ids, seq) =>
      ids.length === 0
        ? Effect.void
        : execute(
            "UPDATE task_interests SET woken_seq=? WHERE participant_id IN (SELECT value FROM json_each(?))",
            [seq, json(ids)],
          ).pipe(Effect.asVoid),
    removeInterest: (participantId) =>
      execute("DELETE FROM task_interests WHERE participant_id=?", [participantId]).pipe(
        Effect.asVoid,
      ),
    removeInterests: () => execute("DELETE FROM task_interests").pipe(Effect.asVoid),
    removeExpired: (at) =>
      execute("DELETE FROM task_interests WHERE expires_at<=?", [at]).pipe(
        Effect.andThen(
          execute("DELETE FROM task_requests WHERE task_id IS NULL AND created_at<=?", [
            at - 86_400_000,
          ]),
        ),
        Effect.asVoid,
      ),
    summary: Effect.fnUntraced(function* (now) {
      const all = yield* counts();
      const stalled = yield* count(`SELECT COUNT(*) AS count FROM tasks t WHERE ${stalledSql}`, [
        now,
      ]);
      const finishedSince = yield* count(
        "SELECT COUNT(*) AS count FROM tasks WHERE state='completed' AND finished_at>?",
        [now - 3_600_000],
      );
      const agents = yield* one(
        Schema.Struct({ total: M.Count, working: M.Count, stalled: M.Count }),
        `SELECT (SELECT COUNT(*) FROM participants p
           WHERE NOT EXISTS (SELECT 1 FROM person_participants pp WHERE pp.participant_id=p.id)
           AND NOT EXISTS (SELECT 1 FROM participant_removals r WHERE r.participant_id=p.id)) AS total,
         (SELECT COUNT(DISTINCT claimer_id) FROM tasks WHERE state='claimed') AS working,
         (SELECT COUNT(DISTINCT t.claimer_id) FROM tasks t WHERE ${stalledSql}) AS stalled`,
        [now],
      );
      const stalledRows = yield* tasks(
        `WHERE ${stalledSql} ORDER BY t.last_note_at, t.number LIMIT 3`,
        [now],
      );
      const failedRows = yield* tasks(
        "WHERE t.state='failed' ORDER BY t.finished_at DESC, t.number DESC LIMIT 3",
      );
      return {
        counts: all,
        stalled,
        finishedSince,
        agents: agents ?? { total: 0, working: 0, stalled: 0 },
        stalledRows,
        failedRows,
      };
    }),
    version: Effect.fnUntraced(function* (now) {
      const row = yield* one(
        Schema.Struct({ head: M.Count, stalled: M.Count, note: M.Count }),
        `SELECT COALESCE((SELECT seq FROM task_events ORDER BY seq DESC LIMIT 1),0) AS head,
         (SELECT COUNT(*) FROM tasks t WHERE ${stalledSql}) AS stalled,
         COALESCE((SELECT MAX(last_note_at) FROM tasks WHERE state='claimed'),0) AS note`,
        [now],
      );
      return `${row?.head ?? 0}.${row?.stalled ?? 0}.${row?.note ?? 0}`;
    }),
    boardList: (filter) => {
      // One sort key for every view: rank (needs you, stalled, working, ready, waiting, finished),
      // priority (open only), then time and number; finished tasks are latest first.
      const rank = `CASE WHEN t.state='blocked' THEN 0 WHEN ${stalledSql} THEN 1
        WHEN t.state='claimed' THEN 2 WHEN t.state='ready' THEN 3 WHEN t.state='waiting' THEN 4 ELSE 5 END`;
      const priority = `CASE WHEN t.state IN ('completed','failed','canceled') THEN 0 ELSE ${priorityRank} END`;
      const time = `CASE t.state WHEN 'blocked' THEN t.blocked_at WHEN 'claimed' THEN
        CASE WHEN ${stalledSql} THEN t.last_note_at ELSE t.claimed_at END
        WHEN 'ready' THEN t.ready_at WHEN 'waiting' THEN t.created_at ELSE -t.finished_at END`;
      const order = `CASE WHEN t.state IN ('completed','failed','canceled') THEN -t.number ELSE t.number END`;
      const where: string[] = [];
      const bindings: SqlStorageValue[] = [];
      const views: Record<T.BoardView, string | null> = {
        all: null,
        open: "t.state IN ('waiting','ready','claimed','blocked')",
        done: "t.state='completed'",
        failed: "t.state='failed'",
        needs: "t.state='blocked'",
        stalled: stalledSql,
      };
      const view = views[filter.view];
      if (view !== null) {
        where.push(view);
        if (filter.view === "stalled") bindings.push(filter.now);
      }
      if (filter.state !== null) {
        where.push("t.state=?");
        bindings.push(filter.state);
      }
      if (filter.agentId !== null) {
        // Tasks it owns, is assigned, holds, ever held or finished (migrations/task-holders.sql).
        where.push(
          `(t.owner_participant_id=? OR t.assignee_id=? OR (t.state='claimed' AND t.claimer_id=?)
           OR EXISTS (SELECT 1 FROM task_holders h WHERE h.task_id=t.id AND h.participant_id=?)
           OR EXISTS (SELECT 1 FROM task_finishers f WHERE f.task_id=t.id AND f.participant_id=?))`,
        );
        bindings.push(
          filter.agentId,
          filter.agentId,
          filter.agentId,
          filter.agentId,
          filter.agentId,
        );
      }
      if (filter.label !== null) {
        where.push("EXISTS (SELECT 1 FROM task_labels l WHERE l.task_id=t.id AND l.label=?)");
        bindings.push(filter.label);
      }
      if (filter.askKey !== null) {
        where.push("t.block_key=?");
        bindings.push(filter.askKey);
      }
      if (filter.title !== null || filter.number !== null) {
        where.push("(instr(lower(t.title), lower(?))>0 OR t.number=?)");
        bindings.push(filter.title ?? "", filter.number ?? -1);
      }
      const key = `${rank} AS k0, ${priority} AS k1, ${time} AS k2, ${order} AS k3`;
      // The rank and time expressions each bind `now` for the Stalled rule.
      const keyBindings = [filter.now, filter.now];
      const after = filter.after;
      const page = after === null ? "" : `WHERE (k0, k1, k2, k3) > (?, ?, ?, ?)`;
      return all(
        Schema.Struct({
          ...Model.TaskRow.fields,
          k0: Schema.Number,
          k1: Schema.Number,
          k2: Schema.Number,
          k3: Schema.Number,
        }),
        `SELECT * FROM (SELECT ${taskColumns}, ${key} FROM tasks t
         ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}) ${page}
         ORDER BY k0, k1, k2, k3 LIMIT ?`,
        [...keyBindings, ...bindings, ...(after === null ? [] : after), filter.limit],
      ).pipe(
        Effect.map((rows) =>
          rows.map(({ k0, k1, k2, k3, ...row }) => ({ row, key: [k0, k1, k2, k3] })),
        ),
      );
    },
  };
};
