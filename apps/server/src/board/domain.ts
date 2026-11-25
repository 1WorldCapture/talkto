import { Effect } from "effect";
import * as M from "@talkto/api/models";
import * as T from "@talkto/api/tasks";
import * as E from "@talkto/api/errors";
import type * as Store from "../persistence.js";
import * as Model from "./model.js";

/**
 * The board's state machine inside one synchronous transaction (docs/swarm-server-spec.md, 3).
 * Every function here reads and writes through `tx.board` and records in an `Outbox` what the
 * committed transaction must tell waiting readers, wakes and the alarm. Callers check the actor
 * first; nothing here refuses a request.
 */

/** Generates the IDs one transaction needs; the composition root supplies it. */
export interface Ids {
  readonly uuid: () => Effect.Effect<string>;
}

/** What a committed task transaction announces, collected while it runs. */
export interface Outbox {
  /** Readers with a new event or thread message delivered to them. */
  readonly recipients: Set<M.ParticipantId>;
  /** Participants whose wakes are due (recipient rows with `wakes = 1`). */
  readonly wakes: Set<M.ParticipantId>;
  /** At least one event was written: readers following every task read again. */
  events: boolean;
  /** When the alarm must fire next: a new lease's end, or now for unfinished work. */
  armAt: number | null;
  /**
   * Tasks this transaction may still move on the system's behalf: expiries, cancels through
   * needs and dependents made ready share it, so one transaction stays bounded however large the
   * graph. What is left over waits in a backlog the alarm finishes.
   */
  work: number;
}
export const outbox = (): Outbox => ({
  recipients: new Set(),
  wakes: new Set(),
  events: false,
  armAt: null,
  work: workLimit,
});
export const arm = (box: Outbox, at: number) => {
  box.armAt = box.armAt === null ? at : Math.min(box.armAt, at);
};

/** Who caused an event: an agent or a person acting, or TalkTo itself. */
export type Actor =
  | { readonly kind: "agent" | "person"; readonly id: M.ParticipantId }
  | { readonly kind: "system" };
export const system: Actor = { kind: "system" };
const actorId = (actor: Actor) => (actor.kind === "system" ? null : actor.id);

/** A task's lease columns once its claim ended. */
const leaseEnded = {
  claimerId: null,
  leaseToken: null,
  leaseSeconds: null,
  claimedAt: null,
  leaseExpiresAt: null,
} as const;
/**
 * Tasks one transaction moves at most on the system's behalf (expiries, cancels through needs and
 * dependents made ready, together); the alarm finishes the rest.
 */
export const workLimit = 500;
/** Expired leases one transaction handles at most, within `workLimit`. */
export const expiryLimit = 200;
/** Take one unit of the transaction's work; false, with the alarm armed for now, when none is left. */
const spend = (box: Outbox, at: number) => {
  if (box.work <= 0) {
    arm(box, at);
    return false;
  }
  box.work -= 1;
  return true;
};

/**
 * The task's owner, assignee and holder, without the actor, plus `extra`. A participant listed
 * twice keeps the waking row (spec 5.1).
 */
export const parties = (
  task: Model.TaskRow,
  actor: Actor,
  extra: ReadonlyArray<Model.Recipient> = [],
): ReadonlyArray<Model.Recipient> => {
  const skip = actorId(actor);
  const found = new Map<M.ParticipantId, boolean>();
  const add = (id: M.ParticipantId | null, wakes: boolean) => {
    if (id === null || id === skip) return;
    found.set(id, (found.get(id) ?? false) || wakes);
  };
  add(task.ownerId, false);
  add(task.assigneeId, false);
  add(task.claimerId, false);
  for (const item of extra) add(item.participantId, item.wakes);
  return [...found].map(([participantId, wakes]) => ({ participantId, wakes }));
};

/** Write one event of `task` (its state after the change) and deliver it to `recipients`. */
export const emit = Effect.fn("Board.emit")(function* (
  tx: Store.Session,
  box: Outbox,
  ids: Ids,
  task: Model.TaskRow,
  kind: Model.EventKind,
  actor: Actor,
  at: number,
  recipients: ReadonlyArray<Model.Recipient>,
  reason: Model.Reason | null = null,
) {
  const seq = yield* tx.board.allocateSequence(1);
  yield* tx.board.addEvent({
    seq,
    id: T.TaskEventId.make(yield* ids.uuid()),
    taskId: task.id,
    kind,
    state: task.state,
    actorKind: actor.kind,
    actorId: actorId(actor),
    reason,
    epoch: task.leaseEpoch,
    createdAt: at,
  });
  yield* tx.board.addEventRecipients(seq, recipients);
  box.events = true;
  for (const item of recipients) {
    box.recipients.add(item.participantId);
    if (item.wakes) box.wakes.add(item.participantId);
  }
  return seq;
});

/** Write the task after a change, one revision later. */
export const save = (tx: Store.Session, before: Model.TaskRow, after: Model.TaskRow) =>
  tx.board.saveTask(before, after).pipe(Effect.as(after));
const changed = (before: Model.TaskRow, at: number, fields: Partial<Model.TaskRow>) =>
  ({ ...before, ...fields, revision: before.revision + 1, updatedAt: at }) as const;

/**
 * On a server with a claim cap, the agent to tell that a claim ended: the one waiting longest for
 * work it may claim now, not yet told about any, while fewer tasks are claimed than the cap allows.
 * Its interest stopped it at the cap; a claim's end counts as a ready task for it (spec 6, 8.3).
 */
const slotWaiter = Effect.fn("Board.slotWaiter")(function* (
  tx: Store.Session,
  at: number,
  exclude: ReadonlyArray<M.ParticipantId>,
) {
  const settings = yield* tx.board.settings();
  if (settings === null || settings.claimCap === null) return null;
  const waiter = yield* tx.board.waitingForSlot(at, exclude);
  if (waiter === null) return null;
  const counts = yield* tx.board.counts();
  return counts.claimed < settings.claimCap ? waiter : null;
});

/**
 * Write the event that ended a claim (`completed`, `failed`, or `canceled` while claimed), as
 * `emit` does. At a claim cap, the agent waiting longest for a slot receives it too, without a
 * wake, as for a ready task: its waiting claim claims again (spec 6, 8.3).
 */
export const emitEnded = Effect.fn("Board.emitEnded")(function* (
  tx: Store.Session,
  box: Outbox,
  ids: Ids,
  task: Model.TaskRow,
  kind: Model.EventKind,
  actor: Actor,
  at: number,
  recipients: ReadonlyArray<Model.Recipient>,
  reason: Model.Reason | null = null,
) {
  const skip = actorId(actor);
  const waiter = yield* slotWaiter(tx, at, [
    ...(skip === null ? [] : [skip]),
    ...recipients.map((item) => item.participantId),
  ]);
  const told: ReadonlyArray<Model.Recipient> =
    waiter === null ? [] : [{ participantId: waiter, wakes: false }];
  const seq = yield* emit(tx, box, ids, task, kind, actor, at, [...recipients, ...told], reason);
  if (waiter !== null) yield* tx.board.markInterested([waiter], seq);
  return seq;
});

/**
 * Announce a task that has just become claimable (`ready`, or `released` and `expired`'s
 * follow-up). An assigned task wakes its assignee; an unassigned one goes to the agent that has
 * waited longest for work its labels match, once until that agent claims again (section 6). When
 * a claim just ended (`freed`) and nobody waits for this task, an agent the claim cap stopped
 * hears of it instead, if other work it may claim is ready (`emitEnded`).
 */
export const announceReady = Effect.fn("Board.announceReady")(function* (
  tx: Store.Session,
  box: Outbox,
  ids: Ids,
  task: Model.TaskRow,
  kind: "ready" | "released" | "assigned",
  actor: Actor,
  at: number,
  reason: Model.Reason | null,
  /** Recipients beside the parties and the agent told about the work, such as a former holder. */
  also: ReadonlyArray<Model.Recipient> = [],
  /** The task's claim just ended, so a claim cap may have room again. */
  freed = false,
) {
  const extra: Model.Recipient[] = [...also];
  const former = new Set(also.map((item) => item.participantId));
  let interested = false;
  if (task.assigneeId !== null) {
    // Work given by name wakes its assignee, unless the assignee put it back itself.
    if (kind === "ready" && task.assigneeId !== actorId(actor))
      extra.push({ participantId: task.assigneeId, wakes: true });
  } else {
    // One agent waiting for these labels, never the one that just gave the task up.
    const labels = (yield* tx.board.labels([task.id])).get(task.id) ?? [];
    const waiting = yield* tx.board.interested(labels, at, actorId(actor), 1 + former.size);
    const first = waiting.find((id) => !former.has(id));
    if (first !== undefined) {
      extra.push({ participantId: first, wakes: false });
      interested = true;
    }
  }
  if (freed && !interested) {
    const skip = actorId(actor);
    const waiter = yield* slotWaiter(tx, at, [
      ...(skip === null ? [] : [skip]),
      ...former,
      ...(task.assigneeId === null ? [] : [task.assigneeId]),
    ]);
    if (waiter !== null) extra.push({ participantId: waiter, wakes: false });
  }
  const seq = yield* emit(tx, box, ids, task, kind, actor, at, parties(task, actor, extra), reason);
  const told = extra.filter(
    (item) => item.participantId !== task.assigneeId && !former.has(item.participantId),
  );
  yield* tx.board.markInterested(
    told.map((item) => item.participantId),
    seq,
  );
  return seq;
});

/** The batch of a task that just finished; its last task tells the owner the batch is done. */
const finishBatch = Effect.fn("Board.finishBatch")(function* (
  tx: Store.Session,
  box: Outbox,
  ids: Ids,
  task: Model.TaskRow,
  at: number,
) {
  const batch = yield* tx.board.finishInBatch(task.batchId, at);
  if (batch.openCount > 0) return;
  // The owner's one summary; phase 1 delivers it without a wake (spec 12).
  yield* emit(tx, box, ids, task, "batch_finished", system, at, [
    { participantId: batch.ownerId, wakes: false },
  ]);
});

/** Cancel one waiting task because a task it needs failed or was canceled. */
const cancelForNeed = Effect.fn("Board.cancelForNeed")(function* (
  tx: Store.Session,
  box: Outbox,
  ids: Ids,
  task: Model.TaskRow,
  at: number,
) {
  const after = yield* save(
    tx,
    task,
    changed(task, at, { state: "canceled", outcomeReason: "need_failed", finishedAt: at }),
  );
  yield* emit(tx, box, ids, after, "canceled", system, at, parties(after, system), "need_failed");
  yield* finishBatch(tx, box, ids, after, at);
  return after;
});
/**
 * Cancel every waiting task below `roots` through needs, breadth first, within the transaction's
 * work. A longer cascade continues on the alarm (`continueBacklog`).
 */
export const cascade = Effect.fn("Board.cascade")(function* (
  tx: Store.Session,
  box: Outbox,
  ids: Ids,
  roots: ReadonlyArray<T.TaskId>,
  at: number,
) {
  const canceled: Model.TaskRow[] = [];
  let frontier = roots;
  while (frontier.length > 0) {
    const next: T.TaskId[] = [];
    for (const dependent of yield* tx.board.waitingDependents(frontier)) {
      if (!spend(box, at)) return canceled;
      const after = yield* cancelForNeed(tx, box, ids, dependent, at);
      canceled.push(after);
      next.push(after.id);
    }
    frontier = next;
  }
  return canceled;
});

/**
 * The alarm's share of the work earlier transactions left: waiting tasks with a failed or canceled
 * need, and everything below them; waiting tasks whose needs all completed; then canceled tasks
 * whose failed need was reopened. Within this
 * transaction's work; the alarm comes back for the rest.
 */
export const continueBacklog = Effect.fn("Board.continueBacklog")(function* (
  tx: Store.Session,
  box: Outbox,
  ids: Ids,
  at: number,
) {
  const backlog = yield* tx.board.cascadeBacklog(Math.max(box.work, 1));
  const started: T.TaskId[] = [];
  for (const task of backlog) {
    if (!spend(box, at)) return;
    yield* cancelForNeed(tx, box, ids, task, at);
    started.push(task.id);
  }
  yield* cascade(tx, box, ids, started, at);
  for (const task of yield* tx.board.unlockBacklog(Math.max(box.work, 1))) {
    if (!spend(box, at)) return;
    yield* unlock(tx, box, ids, task, at);
  }
  yield* revive(tx, box, ids, at);
});
/**
 * A failed task returns to ready, or to waiting while a need is unfinished, with its outcome and
 * attempts cleared; then the tasks canceled because it failed wait again (`revive`).
 */
export const reopen = Effect.fn("Board.reopen")(function* (
  tx: Store.Session,
  box: Outbox,
  ids: Ids,
  task: Model.TaskRow,
  actor: Actor,
  reason: "by_owner" | "by_person",
  at: number,
) {
  const waits = (yield* tx.board.unmetNeeds(task.id)) > 0;
  const after = yield* save(
    tx,
    task,
    changed(task, at, {
      state: waits ? "waiting" : "ready",
      attempts: 0,
      outcomeSummary: null,
      outcomeReason: null,
      outcomeMessageId: null,
      finishedAt: null,
      readyAt: waits ? null : at,
    }),
  );
  yield* tx.board.reopenInBatch(after.batchId);
  yield* emit(tx, box, ids, after, "reopened", actor, at, parties(after, actor), reason);
  if (after.state === "ready") yield* announceReady(tx, box, ids, after, "ready", actor, at, null);
  const reopened = yield* revive(tx, box, ids, at);
  return { task: after, reopened };
});
/**
 * Return the tasks canceled because a reopened task failed to waiting, level by level, within the
 * transaction's work; the alarm revives the rest (`continueBacklog`).
 */
const revive = Effect.fn("Board.revive")(function* (
  tx: Store.Session,
  box: Outbox,
  ids: Ids,
  at: number,
) {
  const revived: Model.TaskRow[] = [];
  for (;;) {
    const due = yield* tx.board.reviveBacklog(Math.max(box.work, 1));
    if (due.length === 0) return revived;
    for (const task of due) {
      if (!spend(box, at)) return revived;
      const after = yield* save(
        tx,
        task,
        changed(task, at, {
          state: "waiting",
          outcomeReason: null,
          outcomeMessageId: null,
          finishedAt: null,
          readyAt: null,
        }),
      );
      yield* tx.board.reopenInBatch(after.batchId);
      yield* emit(
        tx,
        box,
        ids,
        after,
        "reopened",
        system,
        at,
        parties(after, system),
        "need_reopened",
      );
      revived.push(after);
    }
  }
});
/** A waiting task whose needs all completed becomes ready. */
const unlock = Effect.fn("Board.unlock")(function* (
  tx: Store.Session,
  box: Outbox,
  ids: Ids,
  task: Model.TaskRow,
  at: number,
) {
  const after = yield* save(tx, task, changed(task, at, { state: "ready", readyAt: at }));
  yield* announceReady(tx, box, ids, after, "ready", system, at, "needs_done");
  return after;
});
/** What finishing one task did to the tasks that need it. */
export interface Finished {
  readonly unlocked: ReadonlyArray<Model.TaskRow>;
  readonly canceled: ReadonlyArray<Model.TaskRow>;
}
/**
 * After a task reached a final state: close it in its batch, then ready the dependents whose needs
 * are now all completed, or cancel the waiting tasks below a failed or canceled one.
 */
export const finish = Effect.fn("Board.finish")(function* (
  tx: Store.Session,
  box: Outbox,
  ids: Ids,
  task: Model.TaskRow,
  at: number,
) {
  yield* finishBatch(tx, box, ids, task, at);
  if (task.state !== "completed") {
    const canceled = yield* cascade(tx, box, ids, [task.id], at);
    const finished: Finished = { unlocked: [], canceled };
    return finished;
  }
  const unlocked: Model.TaskRow[] = [];
  for (const dependent of yield* tx.board.waitingDependents([task.id])) {
    if ((yield* tx.board.unmetNeeds(dependent.id)) > 0) continue;
    if (!spend(box, at)) break;
    unlocked.push(yield* unlock(tx, box, ids, dependent, at));
  }
  const finished: Finished = { unlocked, canceled: [] };
  return finished;
});

/**
 * A lease ran out: the task returns to ready (event `expired`, then `ready`), or fails with
 * `attempts_exhausted` once it has run out `maxAttempts` times. The holder hears either way.
 */
const expireOne = Effect.fn("Board.expireOne")(function* (
  tx: Store.Session,
  box: Outbox,
  ids: Ids,
  task: Model.TaskRow,
  at: number,
) {
  const attempts = task.attempts + 1;
  const holder: ReadonlyArray<Model.Recipient> =
    task.claimerId === null ? [] : [{ participantId: task.claimerId, wakes: false }];
  if (attempts >= task.maxAttempts) {
    const after = yield* save(
      tx,
      task,
      changed(task, at, {
        ...leaseEnded,
        state: "failed",
        attempts,
        outcomeSummary: T.Summary.make(
          `The lease ran out ${attempts} ${attempts === 1 ? "time" : "times"} before any holder finished the task.`,
        ),
        outcomeReason: "attempts_exhausted",
        finishedAt: at,
      }),
    );
    yield* emitEnded(
      tx,
      box,
      ids,
      after,
      "failed",
      system,
      at,
      parties(after, system, holder),
      "attempts_exhausted",
    );
    yield* finish(tx, box, ids, after, at);
    return;
  }
  const after = yield* save(
    tx,
    task,
    changed(task, at, { ...leaseEnded, state: "ready", attempts, readyAt: at }),
  );
  yield* emit(tx, box, ids, after, "expired", system, at, parties(after, system, holder));
  yield* announceReady(tx, box, ids, after, "ready", system, at, null, [], true);
});

/**
 * Expire one lease that ran out, outside the transaction's batch: a claim found it before
 * `expire` reached it (more than `expiryLimit` ran out at once). Returns the task after.
 */
export const expireLapsed = Effect.fn("Board.expireLapsed")(function* (
  tx: Store.Session,
  box: Outbox,
  ids: Ids,
  task: Model.TaskRow,
  at: number,
) {
  yield* expireOne(tx, box, ids, task, at);
  const after = yield* tx.board.task(task.id);
  if (after === null) return yield* Effect.die("An expired task is missing");
  return after;
});

/**
 * Expire every lease that ran out by `at`, at most `expiryLimit` and within the transaction's work:
 * each task operation does this first (lazy expiry), so a write after the end of a lease gets
 * `claim_lost` even before the alarm runs.
 */
export const expire = Effect.fn("Board.expire")(function* (
  tx: Store.Session,
  box: Outbox,
  ids: Ids,
  at: number,
) {
  const limit = Math.min(expiryLimit, Math.max(box.work, 1));
  const due = yield* tx.board.expired(at, limit);
  let expired = 0;
  for (const task of due) {
    if (!spend(box, at)) break;
    yield* expireOne(tx, box, ids, task, at);
    expired += 1;
  }
  if (due.length >= limit) arm(box, at);
  return expired;
});

/** End a claim the holder did not end: a person, a removal or the board switch released it. */
export const releaseClaim = Effect.fn("Board.releaseClaim")(function* (
  tx: Store.Session,
  box: Outbox,
  ids: Ids,
  task: Model.TaskRow,
  actor: Actor,
  reason: Model.Reason,
  at: number,
  /** Wake the holder: the task stopped being theirs while they may still work on it. */
  wakeHolder: boolean,
) {
  const holder: ReadonlyArray<Model.Recipient> =
    task.claimerId === null ? [] : [{ participantId: task.claimerId, wakes: wakeHolder }];
  const after = yield* save(
    tx,
    task,
    changed(task, at, { ...leaseEnded, state: "ready", readyAt: at }),
  );
  // The holder put nothing back itself, so an assignee other than the holder is told as for ready.
  yield* announceReady(tx, box, ids, after, "released", actor, at, reason, holder, true);
  return after;
});

/**
 * A person removed an agent: its claims return to ready, it stops being the assignee of
 * unfinished tasks, and its interest ends (spec 3.1). Its own tasks stay.
 */
export const removeAgent = Effect.fn("Board.removeAgent")(function* (
  tx: Store.Session,
  box: Outbox,
  ids: Ids,
  agentId: M.ParticipantId,
  personId: M.ParticipantId,
  at: number,
) {
  if ((yield* tx.board.settings()) === null) return;
  const person: Actor = { kind: "person", id: personId };
  const removed: ReadonlyArray<Model.Recipient> = [{ participantId: agentId, wakes: false }];
  yield* tx.board.removeInterest(agentId);
  // The assignee first, so a released or now unassigned ready task goes to an agent waiting for
  // work: announced while the removed agent was still its assignee, nobody would hear of it.
  for (const task of yield* tx.board.assignedTo(agentId)) {
    const after = yield* save(tx, task, changed(task, at, { assigneeId: null }));
    if (after.state === "ready")
      yield* announceReady(
        tx,
        box,
        ids,
        after,
        "assigned",
        person,
        at,
        "participant_removed",
        removed,
      );
    else
      yield* emit(
        tx,
        box,
        ids,
        after,
        "assigned",
        person,
        at,
        parties(after, person, removed),
        "participant_removed",
      );
  }
  for (const task of yield* tx.board.claimedBy(agentId))
    yield* releaseClaim(tx, box, ids, task, person, "participant_removed", at, false);
});

/** The board channel holds task threads; archiving it is refused with the existing code. */
export const refuseArchive = Effect.fn("Board.refuseArchive")(function* (
  tx: Store.Session,
  conversationId: M.ConversationId,
) {
  const settings = yield* tx.board.settings();
  if (settings?.channelId === conversationId)
    return yield* new E.Forbidden({
      message:
        "The board channel holds task threads and cannot be archived. Switch the board off in Settings instead.",
    });
});

/** Keep briefs, outcome messages and the tasks a finished task's row still names (spec 2.5). */
export const keptMessagesSql = `EXISTS (SELECT 1 FROM tasks t WHERE t.brief_message_id=m.id
  OR t.outcome_message_id=m.id OR t.block_message_id=m.id)`;
