import { Clock, Context, Effect, Encoding, Layer, Schema } from "effect";
import * as M from "@talkto/api/models";
import * as T from "@talkto/api/tasks";
import * as E from "@talkto/api/errors";
import * as U from "@talkto/api/updates";
import type { AccessContext, PrincipalKey } from "../access.js";
import * as Store from "../persistence.js";
import * as Actors from "../actors.js";
import * as Metering from "../metering/model.js";
import * as Signal from "../update-signal.js";
import * as WakeSchedule from "../wakes/schedule.js";
import * as TalkTo from "../talkto.js";
import * as Transfers from "../files/transfers.js";
import * as Domain from "./domain.js";
import * as Memory from "../memory/service.js";
import * as Model from "./model.js";
import * as View from "./view.js";
import { present } from "../present.js";

/**
 * The task board's operations (docs/swarm-server-spec.md, 3–5 and 9). MCP tools, HTTP routes and
 * the dashboard call the same operations; handlers stay thin. Every agent write acts only as the
 * caller's own agent (`Actors.requireOwnAgent`), every read as a registered agent
 * (`Actors.requireAgent`), and people act only through a website session, checked by the HTTP
 * handler before these run.
 */

type Base = E.ServerAccessDenied | E.StorageUnavailable | E.BoardOff;
type Acting = E.ParticipantNotFound | E.NotAnAgent | E.ParticipantRemoved | E.AgentNotOwned;
type Response<A, F = never> = Effect.Effect<M.Outcome<A>, Base | F>;
type Reading =
  | E.ParticipantNotFound
  | E.NotAnAgent
  | E.ParticipantRemoved
  | E.TaskNotFound
  | E.InvalidCursor;

/** What the deployment decides about boards, and the platform's copy of the switch. */
export class Deployment extends Context.Service<
  Deployment,
  {
    /** `TALKTO_BOARD=on`: task tools are listed and work. Off answers `board_off` everywhere. */
    readonly enabled: boolean;
    /** The principal of the person who created this server, or null where none is known. */
    readonly creator: () => Effect.Effect<PrincipalKey | null>;
    /** Copy the switch to the server list (D1 `servers.board`); a failure never undoes it. */
    readonly record: (enabled: boolean) => Effect.Effect<void>;
    /**
     * The deployment has a transfer store, so a result may carry files. TalkTo Local has none and
     * answers `files_unavailable` to `transferIds`; links work everywhere.
     */
    readonly transfers: boolean;
  }
>()("@talkto/board/Deployment") {}
/** Compositions without a platform: the deployment flags only. */
export const standalone = (enabled: boolean, options: { readonly transfers?: boolean } = {}) =>
  Deployment.of({
    enabled,
    creator: () => Effect.succeed(null),
    record: () => Effect.void,
    transfers: options.transfers ?? false,
  });

export interface Interface {
  /** The deployment offers swarm memory (memory/service.ts), so the guide describes it. */
  readonly memory: boolean;
  readonly createTasks: (
    access: AccessContext,
    input: T.CreateTasks,
    origin: string,
  ) => Response<
    T.CreatedTasks,
    | Acting
    | Metering.Failure
    | E.InvalidInput
    | E.TaskCycle
    | E.NeedUnavailable
    | E.TaskLimitReached
    | E.IdempotencyConflict
  >;
  readonly claimTask: (
    access: AccessContext,
    input: T.ClaimTask,
    origin: string,
  ) => Response<
    T.ClaimResult,
    | Acting
    | E.TaskNotFound
    | E.TaskNotClaimable
    | E.TaskStateConflict
    | E.ClaimLost
    | E.IdempotencyConflict
  >;
  readonly updateTask: (
    access: AccessContext,
    input: T.UpdateTask,
    origin: string,
  ) => Response<
    T.UpdatedTask,
    | Acting
    | Metering.Failure
    | E.TaskNotFound
    | E.ClaimLost
    | E.IdempotencyConflict
    | E.Forbidden
    | E.TaskStateConflict
    | E.RevisionConflict
    | E.InvalidInput
    | E.TransferNotFound
    | E.TransferExpired
    | E.TransferNotUploaded
    | E.FilesUnavailable
  >;
  readonly readTasks: (
    access: AccessContext,
    input: T.ReadTasks,
    origin: string,
  ) => Response<T.ReadTasksData, Reading | E.InvalidInput>;
  /** `read_memory`, and `GET …/memory`: the root and the file list, or one file (memory/service.ts). */
  readonly readMemory: Memory.Interface["read"];
  /** `get_memory_access`, and `POST …/memory/access`: a short Git token for memory. */
  readonly memoryAccess: Memory.Interface["access"];
  /** `read_tasks` mode list, and `GET …/tasks`. */
  readonly listTasks: (
    access: AccessContext,
    input: Omit<Extract<T.ReadTasks, { readonly mode: "list" }>, "mode">,
    origin: string,
  ) => Response<T.TaskList, Reading>;
  /** `read_tasks` mode task, and `GET …/tasks/:task`. */
  readonly readTask: (
    access: AccessContext,
    input: Omit<Extract<T.ReadTasks, { readonly mode: "task" }>, "mode">,
    origin: string,
  ) => Response<T.TaskDetail, Reading>;
  /** `get_context.board`: null where the server never had a board or the deployment has none. */
  readonly context: (
    access: AccessContext,
    participantId: M.ParticipantId | null,
  ) => Effect.Effect<T.ContextBoard | null, E.ServerAccessDenied | E.StorageUnavailable>;
  /** The Board's task page: one task as `readTask` returns it, read by a person on the website. */
  readonly boardTask: (
    access: AccessContext,
    input: { readonly task: T.TaskSelector; readonly before?: M.Cursor },
    origin: string,
  ) => Response<T.TaskDetail, E.TaskNotFound | E.InvalidCursor>;
  /** The dashboard's Board top; `board_off` only where the board was never switched on. */
  readonly board: (access: AccessContext, input: T.BoardInput) => Response<T.Board>;
  readonly boardTasks: (
    access: AccessContext,
    input: T.BoardTasksInput,
  ) => Response<T.BoardTasks, E.InvalidCursor>;
  /** Every label on the board's tasks, for the Board's label filter. */
  readonly boardLabels: (access: AccessContext) => Response<T.BoardLabels>;
  /** A person cancels a task on the dashboard. */
  readonly cancel: (
    access: AccessContext,
    person: TalkTo.PersonProfile,
    taskId: T.TaskId,
    input: T.CancelTask,
    origin: string,
  ) => Response<
    T.PersonResult,
    E.TaskNotFound | E.TaskStateConflict | E.RevisionConflict | E.IdempotencyConflict
  >;
  /** A person reopens a failed task on the dashboard. */
  readonly reopen: (
    access: AccessContext,
    person: TalkTo.PersonProfile,
    taskId: T.TaskId,
    input: T.ReopenTask,
    origin: string,
  ) => Response<
    T.PersonResult,
    E.TaskNotFound | E.TaskStateConflict | E.RevisionConflict | E.IdempotencyConflict
  >;
  /** The server's creator switches the board on or off on the dashboard. */
  readonly setBoard: (
    access: AccessContext,
    person: TalkTo.PersonProfile,
    input: T.SetBoard,
  ) => Response<T.BoardSetting, E.Forbidden | E.InvalidInput | E.MemoryUnavailable>;
  /**
   * The alarm's pass: expire leases that ran out, finish a long cascade, drop expired interests.
   * Returns when the board needs the alarm next, or null.
   */
  readonly tick: () => Effect.Effect<number | null, E.StorageUnavailable>;
  /** When the board needs the alarm next, or null: the earliest lease end, or now for a cascade. */
  readonly nextDue: () => Effect.Effect<number | null, E.StorageUnavailable>;
}
/** The task board's application service. */
export class Board extends Context.Service<Board, Interface>()("@talkto/Board") {}

const empty = <A>(data: A): M.Outcome<A> => ({
  data,
  included: { participants: [], conversations: [] },
});
/**
 * The agents a set of Board rows names (holder, assignee, owner, finisher and earlier holders), for
 * their names and marks. A removed agent is included with its removedAt.
 */
const rowAgents = (rows: ReadonlyArray<T.BoardRow>) => [
  ...new Set(
    rows.flatMap((row) => [
      row.ownerId,
      ...(row.holderId === undefined ? [] : [row.holderId]),
      ...(row.assigneeId === undefined ? [] : [row.assigneeId]),
      ...(row.finishedById === undefined ? [] : [row.finishedById]),
      ...(row.earlierHolderIds ?? []),
    ]),
  ),
];
/** A Board reply with the agents its rows name. */
const withAgents = <A>(participants: ReadonlyArray<M.Participant>, data: A): M.Outcome<A> => ({
  data,
  included: { participants, conversations: [] },
});
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
/** A request's input fingerprint, so a reused request key with other input is refused. */
type Fingerprinted =
  | { readonly participantId: M.ParticipantId; readonly tasks: T.CreateTasks["tasks"] }
  | Omit<T.ClaimTask, "serverId" | "requestKey">
  | Omit<T.UpdateTask, "serverId" | "requestKey">
  | { readonly taskId: T.TaskId; readonly reason: T.CancelTask["reason"] | null }
  | { readonly taskId: T.TaskId; readonly reopen: T.ReopenTask["note"] | null };
const fingerprint = (value: Fingerprinted) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
  ).pipe(Effect.map(hex));
/** A fencing token: 16 random bytes, base64url. Not a secret between agents on one server. */
const leaseToken = Effect.sync(() =>
  T.LeaseToken.make(Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)))),
);
const name = (row: Pick<Model.TaskRow, "number">) => `T-${row.number}`;
const conflict = () =>
  new E.IdempotencyConflict({ message: "The request key was already used for different input." });
const invalid = (message: string) => new E.InvalidInput({ message });
const invalidCursor = () =>
  new E.InvalidCursor({ message: "The continuation token does not match this request." });
const notFound = () =>
  new E.TaskNotFound({
    message: "No task with this ID or number exists on this server. List tasks with read_tasks.",
  });
const boardOff = (settings: Model.Settings | null, deployed: boolean) =>
  new E.BoardOff({
    message: !deployed
      ? "Task boards are not available on this TalkTo deployment yet. Coordinate in channels and direct chats."
      : settings === null
        ? "This server has no task board. Coordinate in channels and direct chats, or ask your person to switch the board on in the server's Settings."
        : "The task board on this server is switched off. Ask the person who created the server to switch it on in Settings.",
  });
/** A thread message's request key: unique per message; the task request holds the caller's key. */
const threadKey = (id: M.MessageId) => M.RequestKey.make(`talkto.task:${id}`);
const boardChannelKey = M.RequestKey.make("talkto.board-channel");
const boardDescription =
  "Task threads of this server's board: each task's brief, notes and result. Agents follow tasks through get_updates (tasks), so they need not select this channel.";
const ThreadCursor = Schema.Struct({
  version: Schema.Literal(1),
  serverId: M.ServerId,
  kind: Schema.Literal("task_thread"),
  taskId: T.TaskId,
  boundary: M.Count,
});
const ListCursor = Schema.Struct({
  version: Schema.Literal(1),
  serverId: M.ServerId,
  kind: Schema.Literal("task_list"),
  filter: Schema.String,
  updatedAt: M.Count,
  number: M.Count,
});
const BoardCursor = Schema.Struct({
  version: Schema.Literal(1),
  serverId: M.ServerId,
  kind: Schema.Literal("board_tasks"),
  filter: Schema.String,
  key: Schema.Array(Schema.Number),
});
const encode = (
  value: typeof ThreadCursor.Type | typeof ListCursor.Type | typeof BoardCursor.Type,
) => M.Cursor.make(Encoding.encodeBase64Url(JSON.stringify(value)));
const parse = Effect.fn("Board.parseCursor")(function* <S extends Schema.Decoder<unknown>>(
  schema: S,
  token: M.Cursor,
) {
  const text = Encoding.decodeBase64UrlString(token);
  if (text._tag === "Failure")
    return yield* new E.InvalidCursor({ message: "The continuation token is malformed." });
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text.success).pipe(
    Effect.mapError(
      () =>
        new E.InvalidCursor({ message: "The continuation token has an invalid shape or version." }),
    ),
  );
});
/** A Board search: a task number (14 or T-14), or a title substring. */
const searchTerms = (q: string | undefined) => {
  if (q === undefined) return { title: null, number: null };
  const trimmed = q.trim();
  const numbered = /^(?:t-?)?(\d{1,15})$/i.exec(trimmed);
  return {
    title: trimmed.length === 0 ? null : trimmed,
    number: numbered?.[1] === undefined ? null : Number(numbered[1]),
  };
};

/** The latest timestamp of several, so a new message never sorts before an older one. */
const latest = (values: ReadonlyArray<M.Timestamp>, fallback: M.Timestamp) =>
  values.toSorted().at(-1) ?? fallback;

/** Fencing: only the holder of this exact claim writes, and only while its lease lasts. */
const holds = (
  row: Model.TaskRow,
  participantId: M.ParticipantId,
  claim: { readonly epoch: number; readonly leaseToken: T.LeaseToken },
  at: number,
) =>
  row.state === "claimed" &&
  row.claimerId === participantId &&
  row.leaseEpoch === claim.epoch &&
  row.leaseToken === claim.leaseToken &&
  row.leaseExpiresAt !== null &&
  row.leaseExpiresAt > at;
/** A result link as stored and returned: its URL as the parsed `href`. */
const normalizeLink = (link: T.NewLink): T.NewLink =>
  link.url === undefined ? link : { ...link, url: new URL(link.url).href };
/** The body of the offer TalkTo posts for a result file on its sender's behalf. */
const offerBody = (
  row: Pick<Model.TaskRow, "number">,
  record: Transfers.TransferRecord,
  kind: "result" | "failure",
) =>
  M.MessageBody.make(
    `${kind === "result" ? "Result" : "Failure"} ${record.kind} for ${name(row)}: ${record.name}${
      record.fileCount === null ? "" : ` (${record.fileCount} files)`
    }`,
  );
/** One result file's copy of its offer. */
const resultFile = (
  record: Transfers.TransferRecord,
  messageId: M.MessageId,
): Model.ResultFileRecord => ({
  transferId: record.id,
  name: record.name,
  kind: record.kind,
  bytes: record.bytes,
  sha256: record.sha256,
  fileCount: record.fileCount,
  expiresAt: Model.millis(record.expiresAt),
  messageId,
});
/** A task list page's byte budget: the same as one get_updates page (scope 2.3). */
const listBudget = U.outcomeBudget;
const taskBytes = (task: T.Task) => new TextEncoder().encode(JSON.stringify(task)).length;

export const layer = Layer.effect(
  Board,
  Effect.gen(function* () {
    const persistence = yield* Store.Persistence;
    const ownership = yield* Actors.AgentOwnership;
    const ids = yield* TalkTo.Identifiers;
    const meter = yield* Metering.Meter;
    const signal = yield* Signal.UpdateSignal;
    const wakes = yield* WakeSchedule.WakeSchedule;
    const deployment = yield* Deployment;
    const transfers = yield* Transfers.TransferStore;
    const shareCost = yield* Metering.ShareCost;
    const memory = yield* Memory.Memory;

    const run = <A, F>(
      access: AccessContext,
      operation: string,
      body: (tx: Store.Session) => Effect.Effect<A, F>,
    ) =>
      persistence
        .transaction(operation, (tx) =>
          Effect.gen(function* () {
            const serverId = yield* tx.serverIdentity();
            const grant = yield* tx.grant(access.grantId);
            if (
              serverId !== access.serverId ||
              grant === null ||
              grant.principalKey !== access.principalKey ||
              grant.revokedAt !== null
            )
              return yield* new E.ServerAccessDenied({ message: "The server is unavailable." });
            return yield* body(tx);
          }),
        )
        .pipe(
          Effect.provideService(Actors.AgentOwnership, ownership),
          Effect.provideService(Actors.Operation, operation),
        );
    /** After a commit: wake waiting readers and due wakes, and keep the alarm for new leases. */
    const announce = Effect.fn("Board.announce")(function* (
      box: Domain.Outbox,
      messages: ReadonlyArray<M.Outcome<M.Created<M.Message>>> = [],
    ) {
      if (box.events || box.recipients.size > 0)
        yield* signal.notifyTasks({ recipientIds: [...box.recipients], events: box.events });
      // A thread message also reaches the board channel's readers and anyone it @mentions.
      for (const message of messages) {
        if (!message.data.created) continue;
        const arrival = TalkTo.arrival(message);
        yield* signal.notify(arrival);
        yield* wakes.notify(arrival);
      }
      if (box.wakes.size > 0) yield* wakes.notifyParticipants([...box.wakes]);
      if (box.armAt !== null) yield* wakes.arm(box.armAt);
    });
    /**
     * Swarm memory has no switch: the first call that needs it sets it up (memory/service.ts), and
     * the memory channel's notice is announced like the board channel's.
     */
    const ensureMemory = Effect.fn("Board.ensureMemory")(function* (
      access: AccessContext,
      participantId: M.ParticipantId | null,
    ) {
      if (!deployment.enabled || !memory.offered) return;
      const notice = yield* memory.ensure(access, participantId);
      if (notice !== null) yield* announce(Domain.outbox(), [notice]);
    });
    /**
     * Lazy expiry, in a transaction of its own before each task write: a write refused because
     * its lease ran out rolls back, and the expiry must not roll back with it (spec 3.3).
     */
    const expireDue = Effect.fn("Board.expireDue")(function* (at: number) {
      const box = Domain.outbox();
      const expired = yield* persistence.transaction("board.expire", (tx) =>
        Effect.gen(function* () {
          const next = yield* tx.board.nextExpiry();
          if (next === null || next > at) return 0;
          return yield* Domain.expire(tx, box, ids, at);
        }),
      );
      if (expired > 0) yield* announce(box);
    });
    /** The board's settings, refusing every task operation while it is off or absent. */
    const requireBoard = Effect.fn("Board.requireBoard")(function* (tx: Store.Session) {
      const settings = yield* tx.board.settings();
      if (!deployment.enabled || settings === null || !settings.enabled)
        return yield* boardOff(settings, deployment.enabled);
      return settings;
    });
    /** The board channel, created by the first agent or person that needs it (board.sql). */
    const ensureChannel = Effect.fn("Board.ensureChannel")(function* (
      tx: Store.Session,
      access: AccessContext,
      settings: Model.Settings,
      creator: M.Participant,
      at: number,
    ) {
      if (settings.channelId !== null) {
        const found = yield* tx.conversation(settings.channelId);
        if (found?.kind !== "channel") return yield* Effect.die("The board channel is missing");
        return { channel: found, notice: null };
      }
      let n = 1;
      let channelName = M.Name.make("board");
      while ((yield* tx.channelNamed(channelName)) !== null) {
        n += 1;
        channelName = M.Name.make(`board-${n}`);
      }
      const createdAt = latest([Model.iso(at), creator.createdAt], Model.iso(at));
      const channel = M.Channel.make({
        kind: "channel",
        id: M.ConversationId.make(yield* ids.uuid()),
        name: channelName,
        description: M.ChannelDescription.make(boardDescription),
        isGeneral: false,
        createdByParticipantId: creator.id,
        createdAt,
        archivedAt: null,
        revision: 0,
        messageCount: 0,
        lastMessageAt: null,
        latestMessage: null,
      });
      yield* tx.addChannel({ item: channel, grantId: access.grantId, requestKey: boardChannelKey });
      yield* tx.board.setChannel(channel.id);
      const notice = yield* TalkTo.channelNotice(
        tx,
        access,
        channel,
        creator,
        M.MessageId.make(yield* ids.uuid()),
      );
      return { channel, notice };
    });
    /**
     * Post one message to a task's thread in the board channel. An agent's counts as one message
     * (metered); a person's does not. Delivered through get_updates to the task's owner, assignee
     * and holder (task_message_recipients), and to anyone it @mentions.
     */
    const post = Effect.fn("Board.post")(function* (
      tx: Store.Session,
      box: Domain.Outbox,
      access: AccessContext,
      input: {
        readonly sender: M.Participant;
        readonly channelId: M.ConversationId;
        readonly task: Model.TaskRow;
        readonly kind: Model.MessageKind;
        readonly body: typeof M.MessageBody.Type;
        readonly at: number;
        readonly metered: boolean;
        /**
         * The transfer this message offers on the sender's behalf: metered as one share, like
         * complete_transfer, and its body is TalkTo's, so it @mentions nobody.
         */
        readonly transfer?: { readonly id: M.TransferId; readonly units: Metering.Units };
      },
    ) {
      const channel = yield* tx.conversation(input.channelId);
      if (channel === null) return yield* Effect.die("The board channel is missing");
      const id = M.MessageId.make(yield* ids.uuid());
      const prior = yield* tx.latestMessage();
      const createdAt = latest(
        [input.sender.createdAt, channel.createdAt, prior?.createdAt ?? Model.iso(input.at)],
        Model.iso(input.at),
      );
      const at = latest([Model.iso(input.at), createdAt], createdAt);
      if (input.metered)
        yield* input.transfer === undefined
          ? meter.consume(id, Metering.singleUnit, "message")
          : meter.consume(id, input.transfer.units, "share");
      const appended = yield* tx.append({
        id,
        conversationId: channel.id,
        senderId: input.sender.id,
        body: input.body,
        createdAt: at,
        grantId: access.grantId,
        requestKey: threadKey(id),
      });
      if (input.transfer === undefined) {
        const mentions = yield* TalkTo.mentioned(tx, input.body, input.sender.id);
        if (mentions.length > 0) yield* tx.addMentions(appended, mentions);
      } else yield* tx.attachTransfer(input.transfer.id, appended.id);
      yield* tx.board.addThreadMessage(appended, input.task.id, input.kind);
      const recipients = Domain.parties(input.task, { kind: "agent", id: input.sender.id });
      yield* tx.board.addThreadRecipients(appended.sequence, recipients);
      for (const item of recipients) box.recipients.add(item.participantId);
      const item = yield* tx.message(appended.id);
      if (item === null) return yield* Effect.die("A thread message is missing");
      return yield* TalkTo.describeMessages(tx, { item, created: true }, [item]);
    });
    /** The brief and the latest thread messages, oldest first; `before` pages older ones. */
    const thread = Effect.fn("Board.thread")(function* (
      tx: Store.Session,
      access: AccessContext,
      row: Model.TaskRow,
      /** Older than this sequence; null for the first page. */
      boundary: number | null,
    ) {
      const rows = yield* tx.board.thread(row.id, boundary, T.threadMessages + 1);
      const selected = rows.slice(0, T.threadMessages);
      const oldest = selected.at(-1);
      const ids = selected.map((item) => item.id);
      // The first page always starts with the brief, however long the thread is.
      if (boundary === null && !ids.includes(row.briefMessageId)) ids.push(row.briefMessageId);
      const items = (yield* tx.messagesByIds(ids)).toSorted((a, b) => a.sequence - b.sequence);
      const nextCursor =
        rows.length > selected.length && oldest !== undefined
          ? encode({
              version: 1,
              serverId: access.serverId,
              kind: "task_thread",
              taskId: row.id,
              boundary: oldest.seq,
            })
          : null;
      return yield* TalkTo.describeMessages(tx, { items, nextCursor }, items);
    });
    const place = (access: AccessContext, origin: string): View.Place => ({
      origin,
      serverId: access.serverId,
    });
    const record = (
      tx: Store.Session,
      access: AccessContext,
      requestKey: M.RequestKey,
      operation: Model.RequestRecord["operation"],
      inputHash: string,
      task: Model.TaskRow | null,
      at: number,
    ) =>
      tx.board.addRequest({
        grantId: access.grantId,
        requestKey,
        operation,
        inputHash,
        taskId: task?.id ?? null,
        epoch: task?.leaseEpoch ?? null,
        eventSeq: null,
        createdAt: at,
      });
    /** Why a write by a holder no longer counts, in words the agent can act on. */
    const claimLost = Effect.fn("Board.claimLost")(function* (
      tx: Store.Session,
      row: Model.TaskRow,
      participantId: M.ParticipantId,
      epoch: number,
    ) {
      const holder =
        row.state === "claimed" && row.claimerId !== null
          ? yield* tx.participant(row.claimerId)
          : null;
      const message =
        holder !== null && holder.id !== participantId
          ? `Task ${name(row)} is no longer yours: ${holder.name} holds it now (epoch ${row.leaseEpoch}). Stop working on it. Read it with read_tasks if you need its current state.`
          : holder !== null && row.leaseEpoch === epoch
            ? `Your lease token for task ${name(row)} does not match your claim (epoch ${epoch}). Use lease.token from your latest claim_task, or claim the task again by taskId to recover it.`
            : holder !== null
              ? `Your lease on task ${name(row)} is stale: you hold epoch ${row.leaseEpoch} now, not ${epoch}. Use lease.token and lease.epoch from your latest claim_task, or claim the task again by taskId to recover them.`
              : Model.isFinal(row.state)
                ? `Task ${name(row)} is no longer yours: it is ${row.state}. Stop working on it. Read it with read_tasks if you need to know what happened.`
                : `Task ${name(row)} is no longer yours: your lease (epoch ${epoch}) ran out or was released, and the task is ${row.state} now. Stop working on it, and do not write the result anywhere else. Read it with read_tasks if you need its current state.`;
      return yield* new E.ClaimLost({
        message,
        state: row.state,
        epoch: row.leaseEpoch,
        ...present("holderId", holder?.id),
      });
    });
    /** Claimable or not, and why: the checks a claim by ID or number runs on one task. */
    const claimable = Effect.fn("Board.claimable")(function* (
      tx: Store.Session,
      row: Model.TaskRow,
      participantId: M.ParticipantId,
    ) {
      switch (row.state) {
        case "ready":
          if (row.assigneeId !== null && row.assigneeId !== participantId)
            return yield* new E.TaskNotClaimable({
              message: `Task ${name(row)} is assigned to another agent; only its assignee can claim it. Claim next to take work you may claim.`,
              reason: "assigned_to_other",
            });
          return;
        case "claimed": {
          const holder = row.claimerId === null ? null : yield* tx.participant(row.claimerId);
          return yield* new E.TaskNotClaimable({
            message: `Task ${name(row)} is held by ${holder?.name ?? "another agent"}. Claim next to take other work.`,
            reason: "held_by_other",
            ...present("holderId", row.claimerId),
            ...present(
              "expiresAt",
              row.leaseExpiresAt === null ? null : Model.iso(row.leaseExpiresAt),
            ),
          });
        }
        case "waiting":
          return yield* new E.TaskNotClaimable({
            message: `Task ${name(row)} waits for tasks it needs to complete. It becomes ready by itself; claim other work meanwhile.`,
            reason: "waiting_on_needs",
          });
        default:
          return yield* new E.TaskStateConflict({
            message: `Task ${name(row)} is ${row.state}, so it cannot be claimed.`,
            state: row.state,
          });
      }
    });

    /** A new task's brief: one metered message by its owner, in the board channel. */
    const postBrief = Effect.fn("Board.postBrief")(function* (
      tx: Store.Session,
      access: AccessContext,
      owner: M.Participant,
      channel: M.Channel,
      row: Model.TaskRow,
      body: typeof M.MessageBody.Type,
      at: number,
    ) {
      const prior = yield* tx.latestMessage();
      const createdAt = latest(
        [Model.iso(at), owner.createdAt, channel.createdAt, prior?.createdAt ?? Model.iso(at)],
        Model.iso(at),
      );
      yield* meter.consume(row.briefMessageId, Metering.singleUnit, "message");
      const appended = yield* tx.append({
        id: row.briefMessageId,
        conversationId: channel.id,
        senderId: owner.id,
        body,
        createdAt,
        grantId: access.grantId,
        requestKey: threadKey(row.briefMessageId),
      });
      yield* tx.board.insertTask(row);
      const mentions = yield* TalkTo.mentioned(tx, body, owner.id);
      if (mentions.length > 0) yield* tx.addMentions(appended, mentions);
      yield* tx.board.addThreadMessage(appended, row.id, "brief");
      yield* tx.board.addThreadRecipients(
        appended.sequence,
        Domain.parties(row, { kind: "agent", id: owner.id }),
      );
      const item = yield* tx.message(appended.id);
      if (item === null) return yield* Effect.die("A brief is missing");
      return yield* TalkTo.describeMessages(tx, { item, created: true }, [item]);
    });

    /**
     * End an unfinished task as canceled (a person, or the owner agent while it waits or is ready),
     * with an optional reason posted to its thread first. The holder, if any, is woken: the task
     * stopped being theirs while they work on it. Tasks that need it are canceled too.
     */
    const cancelRow = Effect.fn("Board.cancelRow")(function* (
      tx: Store.Session,
      box: Domain.Outbox,
      access: AccessContext,
      input: {
        readonly row: Model.TaskRow;
        readonly sender: M.Participant;
        readonly actor: Domain.Actor;
        readonly reason: "by_person" | "by_owner";
        readonly body: typeof M.MessageBody.Type | null;
        readonly channelId: M.ConversationId;
        readonly metered: boolean;
        readonly at: number;
      },
    ) {
      const { row, actor, at } = input;
      const message =
        input.body === null
          ? null
          : yield* post(tx, box, access, {
              sender: input.sender,
              channelId: input.channelId,
              task: row,
              kind: "cancel",
              body: input.body,
              at,
              metered: input.metered,
            });
      const after = yield* Domain.save(tx, row, {
        ...row,
        claimerId: null,
        leaseToken: null,
        leaseSeconds: null,
        claimedAt: null,
        leaseExpiresAt: null,
        state: "canceled",
        outcomeReason: input.reason,
        outcomeMessageId: message?.data.item.id ?? null,
        finishedAt: at,
        revision: row.revision + 1,
        updatedAt: at,
      });
      // A claimed task's cancel ends its claim, so a claim cap may have room again.
      yield* (row.state === "claimed" ? Domain.emitEnded : Domain.emit)(
        tx,
        box,
        ids,
        after,
        "canceled",
        actor,
        at,
        Domain.parties(
          after,
          actor,
          row.claimerId === null ? [] : [{ participantId: row.claimerId, wakes: true }],
        ),
        input.reason,
      );
      const finished = yield* Domain.finish(tx, box, ids, after, at);
      return { after, message, canceled: finished.canceled };
    });
    /**
     * Reopen a failed task (a person, or its owner agent), with an optional note posted to its
     * thread first: see `Domain.reopen`.
     */
    const reopenRow = Effect.fn("Board.reopenRow")(function* (
      tx: Store.Session,
      box: Domain.Outbox,
      access: AccessContext,
      input: {
        readonly row: Model.TaskRow;
        readonly sender: M.Participant;
        readonly actor: Domain.Actor;
        readonly reason: "by_person" | "by_owner";
        readonly body: typeof M.MessageBody.Type | null;
        readonly channelId: M.ConversationId;
        readonly metered: boolean;
        readonly at: number;
      },
    ) {
      // A task reopened `maxReopens` times stays failed, so a claim, fail and reopen loop cannot
      // add events to a task that never finishes (unfinished tasks are never pruned).
      if ((yield* tx.board.reopens(input.row.id)) >= T.maxReopens)
        return yield* new E.TaskStateConflict({
          message: `Task ${name(input.row)} was already reopened ${T.maxReopens} times, the most one task may be. It stays failed. Create a new task with what the failures taught instead of reopening it again.`,
          state: input.row.state,
        });
      const message =
        input.body === null
          ? null
          : yield* post(tx, box, access, {
              sender: input.sender,
              channelId: input.channelId,
              task: input.row,
              kind: "note",
              body: input.body,
              at: input.at,
              metered: input.metered,
            });
      const reopened = yield* Domain.reopen(
        tx,
        box,
        ids,
        input.row,
        input.actor,
        input.reason,
        input.at,
      );
      return { after: reopened.task, message, reopened: reopened.reopened };
    });
    const notFailed = (row: Model.TaskRow) =>
      new E.TaskStateConflict({
        message: `Task ${name(row)} is ${row.state}; only a failed task can be reopened.`,
        state: row.state,
      });
    /**
     * A transfer a result names: the caller's own, in this server object, given an upload link
     * and not expired (docs/swarm-task-results-scope.md, 3.1). A missing transfer, one from
     * another server, a pending one and another agent's get the same answer.
     */
    const ownTransfer = Effect.fn("Board.ownTransfer")(function* (
      tx: Store.Session,
      id: M.TransferId,
      participantId: M.ParticipantId,
      at: number,
    ) {
      const record = yield* tx.transfer(id);
      if (record === null || record.senderId !== participantId || record.poolState !== "reserved")
        return yield* new E.TransferNotFound({
          message: `No transfer ${id} that you prepared exists on this server. Pass transferIds from your own prepare_transfer calls on this server.`,
        });
      if (at > Model.millis(record.expiresAt))
        return yield* new E.TransferExpired({
          message: `Transfer ${id} (${record.name}) has expired: a transfer lasts 30 days after prepare_transfer. Prepare and upload it again, then complete with its new transferId.`,
        });
      return record;
    });
    /** Files on a deployment without a transfer store (TalkTo Local). */
    const noFiles = () =>
      new E.FilesUnavailable({
        message:
          "File transfer is not available on this deployment, so a result cannot carry files. Complete without transferIds; links still work.",
        operation: "files",
        reason: "absent",
      });

    const createTasks: Interface["createTasks"] = Effect.fn("Board.createTasks")(
      function* (access, input, origin) {
        const at = yield* Clock.currentTimeMillis;
        yield* expireDue(at);
        // Memory is ready before the first claim: the first tasks set it up.
        yield* ensureMemory(access, input.participantId);
        const inputHash = yield* fingerprint({
          participantId: input.participantId,
          tasks: input.tasks,
        });
        const units = Metering.Units.make(Math.min(input.tasks.length, Metering.blockUnits));
        const box = Domain.outbox();
        const result = yield* Metering.withCapacity(
          meter,
          units,
        )(
          run(access, "createTasks", (tx) =>
            Effect.gen(function* () {
              const settings = yield* requireBoard(tx);
              const owner = yield* Actors.requireOwnAgent(tx, access, input.participantId);
              yield* Domain.expire(tx, box, ids, at);
              const prior = yield* tx.board.batch(access.grantId, input.requestKey);
              if (prior !== null) {
                if (prior.inputHash !== inputHash) return yield* conflict();
                const rows = yield* tx.board.batchTasks(prior.id);
                return {
                  outcome: empty<T.CreatedTasks>({
                    batchId: prior.id,
                    tasks: yield* View.tasks(tx, place(access, origin), rows),
                    created: false,
                  }),
                  messages: [],
                };
              }
              // Refs name tasks of this call; needs by ref must point at one of them.
              const refs = new Map<string, number>();
              input.tasks.forEach((task, index) => {
                if (task.ref !== undefined && !refs.has(task.ref)) refs.set(task.ref, index);
              });
              if (refs.size !== input.tasks.filter((task) => task.ref !== undefined).length)
                return yield* invalid("Give each task's ref only once in one call.");
              const inner: number[][] = input.tasks.map(() => []);
              const outer: T.TaskId[][] = input.tasks.map(() => []);
              for (const [index, task] of input.tasks.entries()) {
                for (const need of task.needs ?? []) {
                  if ("ref" in need) {
                    const target = refs.get(need.ref);
                    if (target === undefined)
                      return yield* invalid(
                        `A need names ref ${need.ref}, which no task in this call has. Give that task the ref, or name an existing task by taskId.`,
                      );
                    if (!inner[index]?.includes(target)) inner[index]?.push(target);
                  } else if (!outer[index]?.includes(need.taskId)) outer[index]?.push(need.taskId);
                }
              }
              // Needs are fixed at creation, so a cycle can only form inside this call.
              const cycle = cycleOf(inner);
              if (cycle.length > 0) {
                const named = cycle.map((index) => input.tasks[index]?.ref ?? `#${index + 1}`);
                return yield* new E.TaskCycle({
                  message: `These tasks need each other in a cycle, so none could ever start: ${named.join(", ")}. Remove one of the needs and try again.`,
                  refs: named,
                });
              }
              const existingIds = [...new Set(outer.flat())];
              const existing = new Map(
                (yield* tx.board.tasks(existingIds)).map((row) => [row.id, row]),
              );
              for (const id of existingIds) {
                const found = existing.get(id);
                if (found === undefined)
                  return yield* new E.NeedUnavailable({
                    message: `A need names task ${id}, which does not exist on this server.`,
                    taskId: id,
                  });
                if (found.state === "failed" || found.state === "canceled")
                  return yield* new E.NeedUnavailable({
                    message: `A need names task ${name(found)}, which ${found.state === "failed" ? "failed" : "was canceled"}, so the task needing it could never start.`,
                    taskId: id,
                    state: found.state,
                  });
              }
              for (const assigneeId of new Set(
                input.tasks.flatMap((task) =>
                  task.assigneeId === undefined ? [] : [task.assigneeId],
                ),
              )) {
                const assignee = yield* tx.participant(assigneeId);
                if (assignee === null)
                  return yield* new E.ParticipantNotFound({
                    message: `assigneeId ${assigneeId} names no participant on this server.`,
                  });
                if (assignee.kind === "person")
                  return yield* new E.NotAnAgent({
                    message:
                      "assigneeId must be an agent's participant ID; people follow the board on the TalkTo dashboard.",
                  });
                if (assignee.removedAt !== undefined)
                  return yield* new E.ParticipantRemoved({
                    message: `${assignee.name} was removed from this server, so it cannot be assigned work.`,
                  });
              }
              const open = yield* tx.board.unfinished();
              if (open + input.tasks.length > T.maxUnfinished)
                return yield* new E.TaskLimitReached({
                  message: `This server already has ${open} unfinished tasks, and holds at most ${T.maxUnfinished}. Wait for tasks to finish before creating more.`,
                  limit: T.maxUnfinished,
                });
              const { channel, notice } = yield* ensureChannel(tx, access, settings, owner, at);
              const first = yield* tx.board.takeNumbers(input.tasks.length);
              const batchId = T.BatchId.make(yield* ids.uuid());
              yield* tx.board.addBatch({
                id: batchId,
                ownerId: owner.id,
                grantId: access.grantId,
                requestKey: input.requestKey,
                inputHash,
                taskCount: input.tasks.length,
                openCount: input.tasks.length,
                createdAt: at,
                finishedAt: null,
              });
              const taskIds = yield* Effect.forEach(input.tasks, () =>
                ids.uuid().pipe(Effect.map(T.TaskId.make)),
              );
              const rows: Model.TaskRow[] = [];
              const messages: M.Outcome<M.Created<M.Message>>[] = [];
              for (const [index, task] of input.tasks.entries()) {
                const id = taskIds[index];
                if (id === undefined) return yield* Effect.die("A new task has no ID");
                const waits =
                  (inner[index]?.length ?? 0) > 0 ||
                  (outer[index] ?? []).some((need) => existing.get(need)?.state !== "completed");
                const row: Model.TaskRow = {
                  id,
                  number: first + index,
                  batchId,
                  title: task.title,
                  briefMessageId: M.MessageId.make(yield* ids.uuid()),
                  state: waits ? "waiting" : "ready",
                  priority: task.priority ?? "normal",
                  ownerId: owner.id,
                  assigneeId: task.assigneeId ?? null,
                  claimerId: null,
                  leaseToken: null,
                  leaseEpoch: 0,
                  leaseSeconds: null,
                  claimedAt: null,
                  leaseExpiresAt: null,
                  attempts: 0,
                  lastNoteAt: null,
                  maxAttempts: task.maxAttempts ?? T.defaultMaxAttempts,
                  blockKind: null,
                  blockMessageId: null,
                  blockedBy: null,
                  blockedAt: null,
                  blockKey: null,
                  decision: null,
                  decidedBy: null,
                  decidedAt: null,
                  outcomeSummary: null,
                  outcomeReason: null,
                  outcomeMessageId: null,
                  revision: 0,
                  createdAt: at,
                  updatedAt: at,
                  readyAt: waits ? null : at,
                  finishedAt: null,
                };
                // The brief is the thread's first message, so it exists before its task row.
                const brief = yield* postBrief(tx, access, owner, channel, row, task.brief, at);
                rows.push(row);
                messages.push(brief);
              }
              for (const [index, row] of rows.entries()) {
                const task = input.tasks[index];
                const needs = [
                  ...(inner[index] ?? []).flatMap((target) => {
                    const need = taskIds[target];
                    return need === undefined ? [] : [need];
                  }),
                  ...(outer[index] ?? []),
                ];
                yield* tx.board.addNeeds(row.id, needs);
                yield* tx.board.addLabels(row.id, task?.labels ?? []);
              }
              // Events after the thread messages, so readers see each brief before its task.
              for (const row of rows) {
                const actor: Domain.Actor = { kind: "agent", id: owner.id };
                yield* Domain.emit(
                  tx,
                  box,
                  ids,
                  row,
                  "created",
                  actor,
                  at,
                  Domain.parties(row, actor),
                );
                if (row.state === "ready")
                  yield* Domain.announceReady(tx, box, ids, row, "ready", actor, at, null);
              }
              return {
                outcome: empty<T.CreatedTasks>({
                  batchId,
                  tasks: yield* View.tasks(tx, place(access, origin), rows),
                  created: true,
                }),
                messages: notice === null ? messages : [notice, ...messages],
              };
            }),
          ),
        );
        yield* announce(box, result.messages);
        return result.outcome;
      },
    );
    const claimTask: Interface["claimTask"] = Effect.fn("Board.claimTask")(
      function* (access, input, origin) {
        const at = yield* Clock.currentTimeMillis;
        yield* expireDue(at);
        // Memory is set up at the first claim that needs it, and its head read at most every 30
        // seconds, so the claim carries recent commits. Neither ever fails the claim.
        yield* ensureMemory(access, input.participantId);
        yield* memory.refresh(false);
        const { serverId: _server, requestKey, ...asked } = input;
        const inputHash = yield* fingerprint(asked);
        const token = yield* leaseToken;
        const box = Domain.outbox();
        const result = yield* run(access, "claimTask", (tx) =>
          Effect.gen(function* () {
            const settings = yield* requireBoard(tx);
            const agent = yield* Actors.requireOwnAgent(tx, access, input.participantId);
            yield* Domain.expire(tx, box, ids, at);
            const labels = "next" in input ? (input.next.labels ?? []) : [];
            /** Nothing to claim now: remember the agent's labels for an hour. */
            const none = Effect.fn("Board.claimNone")(function* (
              why: "none_ready" | "claim_cap",
              message: string | null = null,
            ) {
              const until = at + T.interestMinutes * 60_000;
              yield* tx.board.putInterest(agent.id, labels, at, until);
              const counts = yield* tx.board.counts();
              return empty<T.ClaimResult>({
                claimed: false,
                why,
                ...present("message", message),
                waitingFor: { labels: [...labels], until: Model.iso(until) },
                counts: { ready: counts.ready, claimed: counts.claimed, waiting: counts.waiting },
              });
            });
            /** The claimed task with its lease and thread. */
            const claimed = Effect.fn("Board.claimed")(function* (
              row: Model.TaskRow,
              recovered: boolean,
            ) {
              const lease = View.lease(row);
              if (lease === null) return yield* Effect.die("A claimed task has no lease");
              const page = yield* thread(tx, access, row, null);
              // Swarm memory: the root and the files the task's labels route to, from the cache.
              const labels = (yield* tx.board.labels([row.id])).get(row.id) ?? [];
              const delivered = yield* memory.deliver(tx, labels);
              return {
                data: {
                  claimed: true as const,
                  task: yield* View.one(tx, place(access, origin), row),
                  lease,
                  recovered,
                  thread: page.data,
                  ...present("memory", delivered),
                },
                included: page.included,
              } satisfies M.Outcome<T.ClaimResult>;
            });
            /** Renew a lease the agent already holds: the same token and epoch. */
            const recover = Effect.fn("Board.recover")(function* (row: Model.TaskRow) {
              const seconds = row.leaseSeconds ?? T.defaultLeaseSeconds;
              const after = yield* Domain.save(tx, row, {
                ...row,
                leaseExpiresAt: at + seconds * 1000,
              });
              Domain.arm(box, at + seconds * 1000);
              return yield* claimed(after, true);
            });
            /**
             * The task as it stands now: a lease that ran out is not held, even when more leases ran
             * out at once than this transaction's expiry reached, so it expires here first.
             */
            const current = (row: Model.TaskRow) =>
              row.state === "claimed" && (row.leaseExpiresAt === null || row.leaseExpiresAt <= at)
                ? Domain.expireLapsed(tx, box, ids, row, at)
                : Effect.succeed(row);
            // Only a claim that took a task is recorded: an empty one runs again on a retry, so a
            // worker may reuse one key until it gets work.
            const prior = yield* tx.board.request(access.grantId, requestKey);
            if (prior !== null) {
              if (prior.operation !== "claim" || prior.inputHash !== inputHash)
                return yield* conflict();
              if (prior.taskId === null) return yield* Effect.die("An empty claim was recorded");
              const stored = yield* tx.board.task(prior.taskId);
              if (stored === null) return yield* Effect.die("A claimed task is missing");
              const row = yield* current(stored);
              if (
                row.state === "claimed" &&
                row.claimerId === agent.id &&
                row.leaseEpoch === prior.epoch
              )
                return yield* recover(row);
              return yield* claimLost(tx, row, agent.id, prior.epoch ?? row.leaseEpoch);
            }
            let row: Model.TaskRow | null;
            if ("next" in input) {
              row = yield* tx.board.nextReady({
                participantId: agent.id,
                labels,
                assignedOnly: input.next.assignedOnly ?? false,
              });
            } else {
              const found =
                "taskId" in input
                  ? yield* tx.board.task(input.taskId)
                  : yield* tx.board.taskByNumber(input.number);
              if (found === null) return yield* notFound();
              row = yield* current(found);
              // Claiming a task you hold recovers its lease after a lost context.
              if (row.state === "claimed" && row.claimerId === agent.id) {
                const outcome = yield* recover(row);
                yield* record(tx, access, requestKey, "claim", inputHash, row, at);
                return outcome;
              }
              yield* claimable(tx, row, agent.id);
            }
            if ((yield* tx.board.holding(agent.id, at)) >= T.maxHolding)
              return yield* new E.TaskNotClaimable({
                message: `You already hold ${T.maxHolding} tasks, the most one agent may hold at once. Finish or release one, then claim again.`,
                reason: "holding_too_many",
              });
            if (settings.claimCap !== null) {
              const counts = yield* tx.board.counts();
              if (counts.claimed >= settings.claimCap)
                return yield* none(
                  "claim_cap",
                  `This server's claim cap is reached: at most ${settings.claimCap} ${settings.claimCap === 1 ? "task" : "tasks"} may be claimed at once. Wait for a ready event in get_updates or for a claimed task to finish, then claim again; a claim with next.waitSeconds claims as soon as one finishes. Do not claim in a loop.`,
                );
            }
            if (row === null) return yield* none("none_ready");
            const seconds = input.leaseSeconds ?? T.defaultLeaseSeconds;
            const after = yield* Domain.save(tx, row, {
              ...row,
              state: "claimed",
              claimerId: agent.id,
              leaseToken: token,
              leaseEpoch: row.leaseEpoch + 1,
              leaseSeconds: seconds,
              claimedAt: at,
              leaseExpiresAt: at + seconds * 1000,
              lastNoteAt: at,
              revision: row.revision + 1,
              updatedAt: at,
            });
            const actor: Domain.Actor = { kind: "agent", id: agent.id };
            yield* Domain.emit(
              tx,
              box,
              ids,
              after,
              "claimed",
              actor,
              at,
              Domain.parties(after, actor),
            );
            yield* tx.board.removeInterest(agent.id);
            yield* record(tx, access, requestKey, "claim", inputHash, after, at);
            Domain.arm(box, at + seconds * 1000);
            return yield* claimed(after, false);
          }),
        );
        yield* announce(box);
        return result;
      },
    );

    const updateTask: Interface["updateTask"] = Effect.fn("Board.updateTask")(
      function* (access, input, origin) {
        const at = yield* Clock.currentTimeMillis;
        yield* expireDue(at);
        const { serverId: _server, requestKey, ...asked } = input;
        const inputHash = yield* fingerprint(asked);
        const body =
          input.action === "progress" || input.action === "release" || input.action === "reopen"
            ? (input.note ?? null)
            : input.action === "cancel"
              ? (input.reason ?? null)
              : (input.details ?? null);
        const finishing = input.action === "complete" || input.action === "fail" ? input : null;
        const transferIds = finishing?.transferIds ?? [];
        const links = (finishing?.links ?? []).map(normalizeLink);
        const shareUnits = shareCost.units();
        // Result files not offered yet are checked in the store between two transactions, as
        // complete_transfer does: first the claim and each transfer's owner, then each upload's
        // size, then everything again in the write (docs/swarm-task-results-scope.md, 3.1). A
        // refusal anywhere writes nothing, so the worker fixes the cause and retries the same key.
        const uploaded = new Set<M.TransferId>();
        let offering = 0;
        if (finishing !== null && transferIds.length > 0) {
          const pending = yield* run(access, "updateTask.files", (tx) =>
            Effect.gen(function* () {
              yield* requireBoard(tx);
              const agent = yield* Actors.requireOwnAgent(tx, access, input.participantId);
              // A replay returns what the first call stored, before any fencing.
              if ((yield* tx.board.request(access.grantId, requestKey)) !== null) return null;
              const row = yield* tx.board.task(input.taskId);
              if (row === null) return yield* notFound();
              // claim_lost comes before any transfer or store work: nothing is attached or offered.
              if (!holds(row, agent.id, finishing, at))
                return yield* claimLost(tx, row, agent.id, finishing.epoch);
              if (!deployment.transfers) return yield* noFiles();
              const unoffered: Transfers.TransferRecord[] = [];
              for (const id of transferIds) {
                const record = yield* ownTransfer(tx, id, agent.id, at);
                if (record.messageId === null) unoffered.push(record);
              }
              return unoffered;
            }),
          );
          if (pending !== null) {
            // The details message, one share for each file TalkTo offers (files already offered
            // were counted then). One allocation holds one block.
            const cost = (body === null ? 0 : 1) + pending.length * shareUnits;
            if (cost > Metering.blockUnits)
              return yield* invalid(
                `This result would cost ${cost} message units, more than one call may spend (${Metering.blockUnits}). Attach fewer files, or offer some first with complete_transfer.`,
              );
            for (const record of pending) {
              yield* TalkTo.verifyUpload(transfers, access.serverId, record);
              uploaded.add(record.id);
            }
            offering = pending.length;
          }
        }
        const box = Domain.outbox();
        const operation = run(access, "updateTask", (tx) =>
          Effect.gen(function* () {
            const settings = yield* requireBoard(tx);
            const agent = yield* Actors.requireOwnAgent(tx, access, input.participantId);
            yield* Domain.expire(tx, box, ids, at);
            const prior = yield* tx.board.request(access.grantId, requestKey);
            if (prior !== null) {
              if (prior.operation !== "update" || prior.inputHash !== inputHash)
                return yield* conflict();
              const stored = yield* tx.board.task(input.taskId);
              if (stored === null) return yield* Effect.die("An updated task is missing");
              // A replayed note is not posted again, but it still renews a lease the caller
              // holds: an agent that reuses its heartbeat's key keeps its claim.
              const holds =
                stored.state === "claimed" &&
                stored.claimerId === agent.id &&
                stored.leaseEpoch === prior.epoch &&
                "leaseToken" in input &&
                stored.leaseToken === input.leaseToken &&
                stored.leaseExpiresAt !== null &&
                stored.leaseExpiresAt > at;
              const seconds = stored.leaseSeconds ?? T.defaultLeaseSeconds;
              const row =
                holds && input.action === "progress"
                  ? yield* tx.board
                      .renewLease(stored, at + seconds * 1000)
                      .pipe(Effect.as({ ...stored, leaseExpiresAt: at + seconds * 1000 }))
                  : stored;
              if (row !== stored) Domain.arm(box, at + seconds * 1000);
              const lease =
                row.state === "claimed" && row.claimerId === agent.id ? View.lease(row) : null;
              return {
                outcome: empty<T.UpdatedTask>({
                  task: yield* View.one(tx, place(access, origin), row),
                  ...present("lease", lease?.epoch === prior.epoch ? lease : null),
                  unlocked: [],
                  canceled: [],
                  changed: false,
                }),
                messages: [],
              };
            }
            const row = yield* tx.board.task(input.taskId);
            if (row === null) return yield* notFound();
            const channelId = settings.channelId;
            if (channelId === null) return yield* Effect.die("A board with tasks has no channel");
            // The owner's actions need no claim: the agent that created the task withdraws or
            // retries it.
            if (input.action === "cancel" || input.action === "reopen") {
              const verb = input.action === "cancel" ? "cancel" : "reopen";
              if (row.ownerId !== agent.id)
                return yield* new E.Forbidden({
                  message: `Only the agent that created task ${name(row)} can ${verb} it. Ask its owner, or a person on the TalkTo dashboard.`,
                });
              if (input.expectedRevision !== undefined && row.revision !== input.expectedRevision)
                return yield* new E.RevisionConflict({
                  message: `Task ${name(row)} changed (revision ${row.revision}). Read it again with read_tasks before you ${verb} it.`,
                });
              const actor: Domain.Actor = { kind: "agent", id: agent.id };
              const common = {
                row,
                sender: agent,
                actor,
                reason: "by_owner",
                body,
                channelId,
                metered: true,
                at,
              } as const;
              let outcome: M.Outcome<T.UpdatedTask>;
              let message: M.Outcome<M.Created<M.Message>> | null;
              if (input.action === "cancel") {
                if (row.state !== "waiting" && row.state !== "ready")
                  return yield* new E.TaskStateConflict({
                    message: Model.isFinal(row.state)
                      ? `Task ${name(row)} is already ${row.state}.`
                      : `Task ${name(row)} is ${row.state}: an agent works on it, so its owner cannot cancel it. Wait for it to finish, or ask a person to cancel it on the TalkTo dashboard.`,
                    state: row.state,
                  });
                const done = yield* cancelRow(tx, box, access, common);
                message = done.message;
                outcome = {
                  data: {
                    task: yield* View.one(tx, place(access, origin), done.after),
                    ...present("message", done.message?.data.item),
                    unlocked: [],
                    canceled: done.canceled.slice(0, T.maxListed).map(View.summary),
                    changed: true,
                  },
                  included: done.message?.included ?? { participants: [], conversations: [] },
                };
              } else {
                if (row.state !== "failed") return yield* notFailed(row);
                const done = yield* reopenRow(tx, box, access, common);
                message = done.message;
                outcome = {
                  data: {
                    task: yield* View.one(tx, place(access, origin), done.after),
                    ...present("message", done.message?.data.item),
                    unlocked: [],
                    canceled: [],
                    reopened: done.reopened.slice(0, T.maxListed).map(View.summary),
                    changed: true,
                  },
                  included: done.message?.included ?? { participants: [], conversations: [] },
                };
              }
              yield* record(tx, access, requestKey, "update", inputHash, row, at);
              return { outcome, messages: message === null ? [] : [message] };
            }
            // Fencing: only the holder of this exact claim writes, and only while its lease lasts.
            if (!holds(row, agent.id, input, at))
              return yield* claimLost(tx, row, agent.id, input.epoch);
            const kinds = {
              progress: "note",
              release: "note",
              complete: "result",
              fail: "failure",
            } as const satisfies Record<(typeof input)["action"], Model.MessageKind>;
            const message =
              body === null
                ? null
                : yield* post(tx, box, access, {
                    sender: agent,
                    channelId,
                    task: row,
                    kind: kinds[input.action],
                    body,
                    at,
                    metered: true,
                  });
            const actor: Domain.Actor = { kind: "agent", id: agent.id };
            const seconds = row.leaseSeconds ?? T.defaultLeaseSeconds;
            const offers: M.Outcome<M.Created<M.Message>>[] = [];
            let after: Model.TaskRow;
            let finished: Domain.Finished = { unlocked: [], canceled: [] };
            switch (input.action) {
              case "progress": {
                // A renewal is not an event and keeps the revision. A note also marks activity
                // (the Board's Stalled view); a bare renewal writes the lease alone (pricing E1).
                after =
                  message === null
                    ? yield* tx.board
                        .renewLease(row, at + seconds * 1000)
                        .pipe(Effect.as({ ...row, leaseExpiresAt: at + seconds * 1000 }))
                    : yield* Domain.save(tx, row, {
                        ...row,
                        leaseExpiresAt: at + seconds * 1000,
                        lastNoteAt: at,
                        updatedAt: at,
                      });
                Domain.arm(box, at + seconds * 1000);
                break;
              }
              case "release": {
                after = yield* Domain.save(tx, row, {
                  ...row,
                  claimerId: null,
                  leaseToken: null,
                  leaseSeconds: null,
                  claimedAt: null,
                  leaseExpiresAt: null,
                  state: "ready",
                  readyAt: at,
                  lastNoteAt: message === null ? row.lastNoteAt : at,
                  revision: row.revision + 1,
                  updatedAt: at,
                });
                yield* Domain.announceReady(
                  tx,
                  box,
                  ids,
                  after,
                  "released",
                  actor,
                  at,
                  "by_claimer",
                  [],
                  true,
                );
                break;
              }
              case "complete":
              case "fail": {
                // The result's files after its details, each offered in the thread unless it
                // was offered before; then the attempt's result row, the task and its events, so
                // readers see the event after the messages it names (spec 2.2, rule 3).
                const kind = kinds[input.action];
                const files: Model.ResultFileRecord[] = [];
                for (const id of transferIds) {
                  const found = yield* ownTransfer(tx, id, agent.id, at);
                  let offered = found.messageId;
                  if (offered === null) {
                    if (!uploaded.has(found.id))
                      return yield* Effect.die("A result file was not checked in the store");
                    const offer = yield* post(tx, box, access, {
                      sender: agent,
                      channelId,
                      task: row,
                      kind,
                      body: offerBody(row, found, kind),
                      at,
                      metered: true,
                      transfer: { id: found.id, units: shareUnits },
                    });
                    offers.push(offer);
                    offered = offer.data.item.id;
                  }
                  files.push(resultFile(found, offered));
                }
                yield* tx.board.addResult({
                  taskId: row.id,
                  epoch: row.leaseEpoch,
                  kind: input.action === "complete" ? "completed" : "failed",
                  summary: input.summary,
                  participantId: agent.id,
                  links,
                  files,
                  createdAt: at,
                });
                after = yield* Domain.save(tx, row, {
                  ...row,
                  claimerId: null,
                  leaseToken: null,
                  leaseSeconds: null,
                  claimedAt: null,
                  leaseExpiresAt: null,
                  state: input.action === "complete" ? "completed" : "failed",
                  outcomeSummary: input.summary,
                  outcomeReason: "by_claimer",
                  outcomeMessageId: message?.data.item.id ?? null,
                  finishedAt: at,
                  revision: row.revision + 1,
                  updatedAt: at,
                });
                yield* Domain.emitEnded(
                  tx,
                  box,
                  ids,
                  after,
                  input.action === "complete" ? "completed" : "failed",
                  actor,
                  at,
                  Domain.parties(after, actor),
                  "by_claimer",
                );
                finished = yield* Domain.finish(tx, box, ids, after, at);
                break;
              }
            }
            // A bare renewal is not recorded, so the same key renews again on its next use.
            if (input.action !== "progress" || message !== null)
              yield* record(tx, access, requestKey, "update", inputHash, row, at);
            const lease = View.lease(after);
            return {
              outcome: {
                data: {
                  task: yield* View.one(tx, place(access, origin), after),
                  ...present("lease", lease),
                  ...present("message", message?.data.item),
                  unlocked: finished.unlocked.slice(0, T.maxListed).map(View.summary),
                  canceled: finished.canceled.slice(0, T.maxListed).map(View.summary),
                  changed: true,
                },
                included: message?.included ?? { participants: [], conversations: [] },
              } satisfies M.Outcome<T.UpdatedTask>,
              messages: [...(message === null ? [] : [message]), ...offers],
            };
          }),
        );
        // Only a call that posts a message spends; renewals and state changes are free. A finish
        // reserves its details message and its offers at once: at most one block, checked above
        // whenever files can take it past one.
        const units = Metering.Units.make(
          Math.min(
            Metering.blockUnits,
            Math.max(1, (body === null ? 0 : 1) + offering * shareUnits),
          ),
        );
        const result = yield* Metering.withCapacity(meter, units)(operation);
        yield* announce(box, result.messages);
        // Swarm memory: a claim that ended revokes its write token, and its holder's update reads
        // memory's head, so new commits are posted and checked now.
        yield* memory.afterUpdate(input.participantId);
        return result.outcome;
      },
    );

    type ListInput = Extract<T.ReadTasks, { readonly mode: "list" }>;
    type TaskInput = Extract<T.ReadTasks, { readonly mode: "task" }>;
    const listTasks: Interface["listTasks"] = Effect.fn("Board.listTasks")(
      function* (access, input, origin) {
        return yield* run(access, "listTasks", (tx) =>
          Effect.gen(function* () {
            yield* requireBoard(tx);
            yield* Actors.requireAgent(tx, input.participantId);
            const mine = input.mine === true ? input.participantId : null;
            const filter = JSON.stringify({
              states: input.states?.toSorted() ?? null,
              labels: input.labels?.toSorted() ?? [],
              assigneeId: input.assigneeId ?? null,
              ownerId: input.ownerId ?? null,
              mine,
            });
            let after: { readonly updatedAt: number; readonly number: number } | null = null;
            if (input.cursor !== undefined) {
              const cursor = yield* parse(ListCursor, input.cursor);
              if (cursor.serverId !== access.serverId || cursor.filter !== filter)
                return yield* invalidCursor();
              after = { updatedAt: cursor.updatedAt, number: cursor.number };
            }
            const limit = input.limit ?? 25;
            const rows = yield* tx.board.list({
              states: input.states ?? null,
              labels: input.labels ?? [],
              assigneeId: input.assigneeId ?? null,
              ownerId: input.ownerId ?? null,
              mine,
              after,
              limit: limit + 1,
            });
            const shown = yield* View.tasks(tx, place(access, origin), rows.slice(0, limit));
            // Results make tasks large, so a page also ends before the task that would take it
            // past get_updates' byte budget; the cursor continues from there (scope 2.3).
            let used = 0;
            let kept = 0;
            for (const item of shown) {
              used += taskBytes(item);
              if (kept > 0 && used > listBudget) break;
              kept += 1;
            }
            const selected = rows.slice(0, kept);
            const last = selected.at(-1);
            return empty<T.TaskList>({
              items: shown.slice(0, kept),
              nextCursor:
                (rows.length > limit || kept < shown.length) && last !== undefined
                  ? encode({
                      version: 1,
                      serverId: access.serverId,
                      kind: "task_list",
                      filter,
                      updatedAt: last.updatedAt,
                      number: last.number,
                    })
                  : null,
              counts: yield* tx.board.counts(),
            });
          }),
        );
      },
    );
    /**
     * One task with its needs, events and thread. `reader` checks who reads: an agent reads as a
     * registered agent, a person on the website as themselves.
     */
    const detail = <F>(
      access: AccessContext,
      operation: string,
      input: { readonly task: T.TaskSelector; readonly before?: M.Cursor },
      origin: string,
      reader: (tx: Store.Session) => Effect.Effect<unknown, F>,
    ) =>
      run(access, operation, (tx) =>
        Effect.gen(function* () {
          yield* requireBoard(tx);
          yield* reader(tx);
          const row =
            "id" in input.task
              ? yield* tx.board.task(input.task.id)
              : yield* tx.board.taskByNumber(input.task.number);
          if (row === null) return yield* notFound();
          let boundary: number | null = null;
          if (input.before !== undefined) {
            const cursor = yield* parse(ThreadCursor, input.before);
            if (cursor.serverId !== access.serverId || cursor.taskId !== row.id)
              return yield* invalidCursor();
            boundary = cursor.boundary;
          }
          const needs = (yield* tx.board.needs([row.id])).get(row.id) ?? [];
          const page = yield* thread(tx, access, row, boundary);
          const events = yield* View.events(tx, yield* tx.board.taskEvents(row.id, T.taskEvents));
          const named = View.eventParticipants(events);
          const known = new Set(page.included.participants.map((item) => item.id));
          const extra = [...named].filter((id) => !known.has(id));
          const participants =
            extra.length === 0
              ? page.included.participants
              : [...page.included.participants, ...(yield* tx.participantsByIds(extra))];
          return {
            data: {
              task: yield* View.one(tx, place(access, origin), row),
              needs: (yield* tx.board.tasks(needs)).map(View.summary),
              neededBy: (yield* tx.board.neededBy(row.id)).slice(0, T.maxListed).map(View.summary),
              thread: page.data,
              events,
            },
            included: { ...page.included, participants },
          } satisfies M.Outcome<T.TaskDetail>;
        }),
      );
    const readTask: Interface["readTask"] = Effect.fn("Board.readTask")(
      function* (access, input, origin) {
        return yield* detail(access, "readTask", input, origin, (tx) =>
          Actors.requireAgent(tx, input.participantId),
        );
      },
    );
    const boardTask: Interface["boardTask"] = Effect.fn("Board.boardTask")(
      function* (access, input, origin) {
        return yield* detail(access, "boardTask", input, origin, () => Effect.void);
      },
    );
    const readTasks: Interface["readTasks"] = (access, input, origin) =>
      input.mode === "list"
        ? listTasks(access, input satisfies ListInput, origin).pipe(
            Effect.map((outcome) => ({
              ...outcome,
              data: { mode: "list" as const, ...outcome.data },
            })),
          )
        : readTask(access, input satisfies TaskInput, origin).pipe(
            Effect.map((outcome) => ({
              ...outcome,
              data: { mode: "task" as const, ...outcome.data },
            })),
          );

    const context: Interface["context"] = Effect.fn("Board.context")(
      function* (access, participantId) {
        if (!deployment.enabled) return null;
        yield* ensureMemory(access, participantId);
        return yield* run(access, "boardContext", (tx) =>
          Effect.gen(function* () {
            const settings = yield* tx.board.settings();
            if (settings === null) return null;
            const yours = participantId === null ? [] : yield* tx.board.yours(participantId, 25);
            // Memory comes with the board: shown while it is on, wherever memory is offered.
            const remembered = settings.enabled ? yield* memory.context(tx) : null;
            return {
              enabled: settings.enabled,
              ...present("channelId", settings.channelId),
              counts: yield* tx.board.counts(),
              ...present("claimCap", settings.claimCap),
              yours: yours.map(View.summary),
              ...present("memory", remembered),
            } satisfies T.ContextBoard;
          }),
        );
      },
    );

    const board: Interface["board"] = Effect.fn("Board.board")(function* (access, input) {
      const at = yield* Clock.currentTimeMillis;
      return yield* run(access, "board", (tx) =>
        Effect.gen(function* () {
          const settings = yield* tx.board.settings();
          if (!deployment.enabled || settings === null)
            return yield* boardOff(settings, deployment.enabled);
          // Whether memory was set up is part of the version, so Settings sees it change.
          const remembered = memory.offered ? yield* memory.settings(tx) : null;
          const memoryState = !memory.offered ? "" : remembered === null ? ".0" : ".1";
          const after = T.BoardVersion.make(
            `${yield* tx.board.version(at)}.${settings.enabled ? 1 : 0}.${settings.claimCap ?? 0}${memoryState}`,
          );
          if (input.after === after) return empty<T.Board>({ changed: false, after });
          const top = yield* tx.board.summary(at);
          const counts = top.counts;
          const total =
            counts.waiting +
            counts.ready +
            counts.claimed +
            counts.blocked +
            counts.completed +
            counts.failed +
            counts.canceled;
          const blocked = top.counts.blocked;
          const stalled = yield* View.boardRows(tx, top.stalledRows, at);
          const failed = yield* View.boardRows(tx, top.failedRows, at);
          const named = rowAgents([...stalled, ...failed]);
          const participants = named.length === 0 ? [] : yield* tx.participantsByIds(named);
          return withAgents<T.Board>(participants, {
            changed: true,
            after,
            enabled: settings.enabled,
            ...present("channelId", settings.channelId),
            ...present("claimCap", settings.claimCap),
            total,
            counts: { ...top.counts, stalled: top.stalled },
            finishedLastHour: top.finishedSince,
            agents: {
              ...top.agents,
              idle: Math.max(0, top.agents.total - top.agents.working),
            },
            // Asking a person comes with Needs you (phase 2); until then nothing is blocked.
            needs: [],
            needsTotal: blocked,
            needsRows: blocked,
            stalled: { items: stalled, total: top.stalled },
            failed: { items: failed, total: top.counts.failed },
            ...present("memory", memory.offered ? { started: remembered !== null } : null),
          });
        }),
      );
    });

    const boardTasks: Interface["boardTasks"] = Effect.fn("Board.boardTasks")(
      function* (access, input) {
        const at = yield* Clock.currentTimeMillis;
        return yield* run(access, "boardTasks", (tx) =>
          Effect.gen(function* () {
            const settings = yield* tx.board.settings();
            if (!deployment.enabled || settings === null)
              return yield* boardOff(settings, deployment.enabled);
            const view = input.view ?? "open";
            const search = searchTerms(input.q);
            const filter = JSON.stringify({
              view,
              state: input.state ?? null,
              agentId: input.agentId ?? null,
              label: input.label ?? null,
              askKey: input.askKey ?? null,
              q: input.q ?? null,
            });
            let after: ReadonlyArray<number> | null = null;
            if (input.cursor !== undefined) {
              const cursor = yield* parse(BoardCursor, input.cursor);
              if (
                cursor.serverId !== access.serverId ||
                cursor.filter !== filter ||
                cursor.key.length !== 4
              )
                return yield* invalidCursor();
              after = cursor.key;
            }
            const limit = input.limit ?? 50;
            const entries = yield* tx.board.boardList({
              view,
              state: input.state ?? null,
              agentId: input.agentId ?? null,
              label: input.label ?? null,
              askKey: input.askKey ?? null,
              title: search.title,
              number: search.number,
              after,
              now: at,
              limit: limit + 1,
            });
            const selected = entries.slice(0, limit);
            const last = selected.at(-1);
            const items = yield* View.boardRows(
              tx,
              selected.map((entry) => entry.row),
              at,
            );
            const named = rowAgents(items);
            return withAgents<T.BoardTasks>(
              named.length === 0 ? [] : yield* tx.participantsByIds(named),
              {
                items,
                nextCursor:
                  entries.length > limit && last !== undefined
                    ? encode({
                        version: 1,
                        serverId: access.serverId,
                        kind: "board_tasks",
                        filter,
                        key: last.key,
                      })
                    : null,
              },
            );
          }),
        );
      },
    );

    const boardLabels: Interface["boardLabels"] = Effect.fn("Board.boardLabels")(
      function* (access) {
        return yield* run(access, "boardLabels", (tx) =>
          Effect.gen(function* () {
            const settings = yield* tx.board.settings();
            if (!deployment.enabled || settings === null)
              return yield* boardOff(settings, deployment.enabled);
            const labels = yield* tx.board.labelNames(T.maxBoardLabels + 1);
            return empty<T.BoardLabels>({
              items: labels.slice(0, T.maxBoardLabels),
              more: labels.length > T.maxBoardLabels,
            });
          }),
        );
      },
    );

    /**
     * A person's Cancel or Reopen on the dashboard: the same request key, revision and replay rules
     * for both, and a reason or note posted to the thread unmetered.
     */
    const personAction = Effect.fn("Board.personAction")(function* (
      access: AccessContext,
      profile: TalkTo.PersonProfile,
      taskId: T.TaskId,
      input:
        | ({ readonly kind: "cancel" } & T.CancelTask)
        | ({ readonly kind: "reopen" } & T.ReopenTask),
      origin: string,
    ) {
      const at = yield* Clock.currentTimeMillis;
      yield* expireDue(at);
      const inputHash = yield* fingerprint(
        input.kind === "cancel"
          ? { taskId, reason: input.reason ?? null }
          : { taskId, reopen: input.note ?? null },
      );
      const personId = M.ParticipantId.make(yield* ids.uuid());
      const box = Domain.outbox();
      const result = yield* run(
        access,
        input.kind === "cancel" ? "cancelTask" : "reopenTask",
        (tx) =>
          Effect.gen(function* () {
            const settings = yield* requireBoard(tx);
            yield* Domain.expire(tx, box, ids, at);
            const prior = yield* tx.board.request(access.grantId, input.requestKey);
            if (prior !== null) {
              if (prior.operation !== "person" || prior.inputHash !== inputHash)
                return yield* conflict();
              const row = yield* tx.board.task(taskId);
              if (row === null) return yield* Effect.die("A changed task is missing");
              return {
                outcome: empty<T.PersonResult>({
                  task: yield* View.one(tx, place(access, origin), row),
                  changed: false,
                  canceled: [],
                }),
                message: null,
              };
            }
            const row = yield* tx.board.task(taskId);
            if (row === null) return yield* notFound();
            if (input.kind === "cancel" && Model.isFinal(row.state))
              return yield* new E.TaskStateConflict({
                message: `Task ${name(row)} is already ${row.state}.`,
                state: row.state,
              });
            if (input.kind === "reopen" && row.state !== "failed") return yield* notFailed(row);
            if (row.revision !== input.expectedRevision)
              return yield* new E.RevisionConflict({
                message: `This task changed. Read it again before ${input.kind === "cancel" ? "canceling" : "reopening"}.`,
              });
            const person =
              (yield* tx.person(access.principalKey)) ??
              (yield* TalkTo.addPerson(tx, access, profile, personId, Model.iso(at)));
            const channelId = settings.channelId;
            if (channelId === null) return yield* Effect.die("A board with tasks has no channel");
            const common = {
              row,
              sender: person,
              actor: { kind: "person", id: person.id },
              reason: "by_person",
              channelId,
              metered: false,
              at,
            } as const;
            const done =
              input.kind === "cancel"
                ? {
                    ...(yield* cancelRow(tx, box, access, {
                      ...common,
                      body: input.reason ?? null,
                    })),
                    reopened: null,
                  }
                : {
                    ...(yield* reopenRow(tx, box, access, { ...common, body: input.note ?? null })),
                    canceled: [],
                  };
            yield* record(tx, access, input.requestKey, "person", inputHash, done.after, at);
            return {
              outcome: {
                data: {
                  task: yield* View.one(tx, place(access, origin), done.after),
                  changed: true,
                  canceled: done.canceled.slice(0, T.maxListed).map(View.summary),
                  ...present(
                    "reopened",
                    done.reopened?.slice(0, T.maxListed).map(View.summary) ?? null,
                  ),
                },
                included: done.message?.included ?? { participants: [], conversations: [] },
              } satisfies M.Outcome<T.PersonResult>,
              message: done.message,
            };
          }),
      ).pipe(
        // A person's note is never metered, so the meter is never asked for capacity here.
        Effect.catchTag("CapacityRequired", () => Effect.die("A person's note was metered")),
      );
      yield* announce(box, result.message === null ? [] : [result.message]);
      return result.outcome;
    });
    const cancel: Interface["cancel"] = (access, profile, taskId, input, origin) =>
      personAction(access, profile, taskId, { kind: "cancel", ...input }, origin);
    const reopen: Interface["reopen"] = (access, profile, taskId, input, origin) =>
      personAction(access, profile, taskId, { kind: "reopen", ...input }, origin);

    const setBoard: Interface["setBoard"] = Effect.fn("Board.setBoard")(
      function* (access, profile, input) {
        if (!deployment.enabled) return yield* boardOff(null, false);
        // The same rule as grants and deletion: only the server's creator.
        const creator = yield* deployment.creator();
        if (creator === null || creator !== access.principalKey)
          return yield* new E.Forbidden({
            message: "Only the person who created this server can change this.",
          });
        // A deployment without swarm memory knows no memory settings, as before it shipped.
        if (input.memory !== undefined && !memory.offered)
          return yield* invalid("Swarm memory is not available on this TalkTo deployment yet.");
        // Memory has no switch: a change to its settings sets it up first if it is not yet (from
        // the template, or a copy of `from`). Git is reached outside the server's transactions.
        if (input.memory !== undefined) yield* memory.provision(access, input.memory.from);
        const at = yield* Clock.currentTimeMillis;
        const personId = M.ParticipantId.make(yield* ids.uuid());
        const box = Domain.outbox();
        const result = yield* run(access, "setBoard", (tx) =>
          Effect.gen(function* () {
            const settings = yield* tx.board.settings();
            // Absent, the board switch stays as it is: memory or the cap can change alone.
            const enabled = input.enabled ?? settings?.enabled ?? false;
            const claimCap =
              input.claimCap === undefined ? (settings?.claimCap ?? null) : input.claimCap;
            // Memory's settings: what is stored, and whether this call changes them (its budget,
            // or a memory channel still to create).
            const stored = yield* memory.settings(tx);
            const askedMemory = input.memory;
            const memoryChanged =
              askedMemory !== undefined &&
              stored !== null &&
              ((askedMemory.tokens ?? stored.tokens) !== stored.tokens ||
                stored.channelId === undefined);
            const boardChanged =
              !(
                settings !== null &&
                settings.enabled === enabled &&
                settings.claimCap === claimCap
              ) && !(settings === null && !enabled);
            const unchanged = {
              enabled: settings?.enabled ?? false,
              ...present("channelId", settings?.channelId),
              ...present("claimCap", settings?.claimCap),
              released: 0,
              ...present("memory", stored),
            };
            if (!boardChanged && !memoryChanged)
              return {
                setting: empty<T.BoardSetting>({ ...unchanged, changed: false }),
                notices: [],
                boardChanged,
              };
            const person =
              (yield* tx.person(access.principalKey)) ??
              (yield* TalkTo.addPerson(tx, access, profile, personId, Model.iso(at)));
            const saved =
              memoryChanged && askedMemory !== undefined
                ? yield* memory.save(tx, access, person, askedMemory, at)
                : null;
            const memoryNotices = saved?.notice === null || saved === null ? [] : [saved.notice];
            const memorySetting = saved?.settings ?? stored;
            if (!boardChanged)
              return {
                setting: empty<T.BoardSetting>({
                  ...unchanged,
                  ...present("memory", memorySetting),
                  changed: true,
                }),
                notices: memoryNotices,
                boardChanged,
              };
            const base: Model.Settings = settings ?? {
              enabled: false,
              channelId: null,
              claimCap: null,
            };
            let channelId = base.channelId;
            let notice: M.Outcome<M.Created<M.Message>> | null = null;
            if (enabled && channelId === null) {
              const made = yield* ensureChannel(tx, access, base, person, at);
              channelId = made.channel.id;
              notice = made.notice;
            }
            let released = 0;
            if (!enabled) {
              const actor: Domain.Actor = { kind: "person", id: person.id };
              yield* Domain.expire(tx, box, ids, at);
              for (const task of yield* tx.board.claimedTasks()) {
                yield* Domain.releaseClaim(tx, box, ids, task, actor, "board_off", at, true);
                released += 1;
              }
              yield* tx.board.removeInterests();
            }
            yield* tx.board.saveSettings({
              enabled,
              channelId,
              claimCap,
              changedBy: person.id,
              at,
            });
            return {
              setting: empty<T.BoardSetting>({
                enabled,
                ...present("channelId", channelId),
                ...present("claimCap", claimCap),
                released,
                changed: true,
                ...present("memory", memorySetting),
              }),
              notices: notice === null ? memoryNotices : [notice, ...memoryNotices],
              boardChanged,
            };
          }),
        );
        yield* announce(box, result.notices);
        if (result.boardChanged) yield* deployment.record(result.setting.data.enabled);
        return result.setting;
      },
    );

    const tick: Interface["tick"] = Effect.fn("Board.tick")(function* () {
      const at = yield* Clock.currentTimeMillis;
      const box = Domain.outbox();
      const next = yield* persistence.transaction("board.tick", (tx) =>
        Effect.gen(function* () {
          const settings = yield* tx.board.settings();
          if (settings === null) return null;
          yield* Domain.expire(tx, box, ids, at);
          yield* Domain.continueBacklog(tx, box, ids, at);
          yield* tx.board.removeExpired(at);
          return yield* due(tx, at);
        }),
      );
      yield* announce(box);
      // Memory's write tokens end with their claims: revoke them, and read the head once after.
      const owed = yield* memory.sweep();
      const tokens = owed > 0 ? at + 60_000 : yield* memory.nextDue();
      return [next, box.armAt, tokens].reduce<number | null>(
        (soonest, value) =>
          value === null ? soonest : soonest === null ? value : Math.min(soonest, value),
        null,
      );
    });
    const due = Effect.fn("Board.due")(function* (tx: Store.Session, at: number) {
      const expiry = yield* tx.board.nextExpiry();
      const backlog =
        (yield* tx.board.cascadeBacklog(1)).length > 0 ||
        (yield* tx.board.unlockBacklog(1)).length > 0 ||
        (yield* tx.board.reviveBacklog(1)).length > 0;
      const soonest = [expiry, backlog ? at : null].filter((value) => value !== null);
      return soonest.length === 0 ? null : Math.min(...soonest);
    });
    const nextDue: Interface["nextDue"] = Effect.fn("Board.nextDue")(function* () {
      const at = yield* Clock.currentTimeMillis;
      const board = yield* persistence.transaction("board.nextDue", (tx) =>
        Effect.gen(function* () {
          if ((yield* tx.board.settings()) === null) return null;
          return yield* due(tx, at);
        }),
      );
      const tokens = yield* memory.nextDue();
      return board === null ? tokens : tokens === null ? board : Math.min(board, tokens);
    });

    return Board.of({
      memory: memory.offered,
      createTasks,
      claimTask,
      updateTask,
      readTasks,
      readMemory: (access, input) =>
        ensureMemory(access, input.participantId).pipe(Effect.andThen(memory.read(access, input))),
      memoryAccess: (access, input) =>
        ensureMemory(access, input.participantId).pipe(
          Effect.andThen(memory.access(access, input)),
        ),
      listTasks,
      readTask,
      context,
      board,
      boardTasks,
      boardLabels,
      boardTask,
      cancel,
      reopen,
      setBoard,
      tick,
      nextDue,
    });
  }),
);

/**
 * Tasks of one call on a cycle of needs, by index; empty when there is none. Kahn's algorithm
 * removes every task whose needs can finish, then every task nothing left needs, so what stays
 * is the cycle (or cycles), not the tasks waiting below it.
 */
export const cycleOf = (needs: ReadonlyArray<ReadonlyArray<number>>): ReadonlyArray<number> => {
  const left = new Set(needs.keys());
  let progress = true;
  while (progress) {
    progress = false;
    for (const index of left) {
      if ((needs[index] ?? []).every((need) => !left.has(need))) {
        left.delete(index);
        progress = true;
      }
    }
  }
  progress = true;
  while (progress) {
    progress = false;
    for (const index of left) {
      if (![...left].some((other) => (needs[other] ?? []).includes(index))) {
        left.delete(index);
        progress = true;
      }
    }
  }
  return [...left].toSorted((a, b) => a - b);
};
