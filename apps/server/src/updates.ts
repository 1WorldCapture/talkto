import { Effect } from "effect";
import * as M from "@talkto/api/models";
import * as U from "@talkto/api/updates";
import * as R from "@talkto/api/renames";
import * as E from "@talkto/api/errors";
import * as Navigation from "./navigation.js";
import * as Actors from "./actors.js";
import type * as Store from "./persistence.js";
import * as T from "@talkto/api/tasks";
import * as BoardView from "./board/view.js";
import { present } from "./present.js";

const invalidCursor = () =>
  new E.InvalidCursor({
    message:
      "This updates checkpoint does not match the server, participant, or stored history. Recover your saved checkpoint or explicitly replay from the beginning; do not silently start at now.",
  });
const bytes = (value: U.Outcome) => new TextEncoder().encode(JSON.stringify(value)).length;

const describe = (
  included: U.Included,
  messages: ReadonlyArray<M.Message>,
  tasks: ReadonlyArray<T.TaskEvent>,
): U.Included => {
  const conversationIds = new Set(messages.map((message) => message.conversationId));
  const conversations = included.conversations.filter((item) => conversationIds.has(item.id));
  const participantIds = new Set(messages.map((message) => message.senderId));
  for (const id of BoardView.eventParticipants(tasks)) participantIds.add(id);
  for (const item of conversations) {
    if (item.kind === "direct") for (const id of item.participantIds) participantIds.add(id);
  }
  return {
    conversations,
    participants: included.participants.filter((item) => participantIds.has(item.id)),
  };
};

/**
 * The rule every incoming selection satisfies, for get_updates and signal links alike: the reader
 * is a registered agent, and every selected ID is an existing channel.
 */
export const checkSelection = Effect.fn("Updates.checkSelection")(function* (
  tx: Store.Session,
  participantId: M.ParticipantId,
  selection: U.Selection,
): Effect.fn.Return<
  void,
  | E.StorageUnavailable
  | E.ParticipantNotFound
  | E.NotAnAgent
  | E.ParticipantRemoved
  | E.ConversationNotFound
  | E.WrongConversationKind
> {
  yield* Actors.requireAgent(tx, participantId);
  const channels = yield* tx.updateConversations(selection.channelIds);
  if (channels.length !== selection.channelIds.length)
    return yield* new E.ConversationNotFound({
      message: "A selected channel does not exist in this server.",
    });
  if (channels.some((item) => item.kind !== "channel"))
    return yield* new E.WrongConversationKind({
      message: "Select channel IDs; own direct chats are included through directChats.",
    });
});

/** Read one bounded incoming batch inside the caller's already-authorized transaction. */
export const read = Effect.fn("Updates.read")(function* (
  tx: Store.Session,
  serverId: M.ServerId,
  input: U.Input,
): Effect.fn.Return<
  U.Outcome,
  | E.StorageUnavailable
  | E.InvalidCursor
  | E.ParticipantNotFound
  | E.NotAnAgent
  | E.ParticipantRemoved
  | E.ConversationNotFound
  | E.WrongConversationKind
> {
  const head = yield* tx.updatesHead();
  let selection: U.Selection;
  let boundary: number;
  let ceiling = head.sequence;
  if (input.mode === "start") {
    selection = {
      channelIds: input.channelIds.toSorted(),
      directChats: input.directChats,
      // Present only when chosen, so checkpoints without it keep their exact shape (read as mine).
      ...present("tasks", input.tasks),
    };
    boundary = input.startAt === "now" ? head.sequence : 0;
  } else {
    const token = yield* Navigation.parseCursor(
      Navigation.UpdatesCursor,
      input.mode === "poll" ? input.checkpoint : input.cursor,
    );
    if (
      token.serverId !== serverId ||
      token.participantId !== input.participantId ||
      token.generation !== head.generation ||
      token.boundary > head.sequence
    )
      return yield* invalidCursor();
    if (
      token.kind === "updates_page" &&
      (token.ceiling > head.sequence || token.boundary > token.ceiling)
    )
      return yield* invalidCursor();
    if (input.mode === "continue") {
      if (token.kind !== "updates_page")
        return yield* new E.InvalidCursor({
          message:
            'This token is an updates checkpoint. Use mode="poll" and pass the same unchanged token as checkpoint. Keep your saved bookmark; no replay is needed.',
        });
      ceiling = token.ceiling;
    } else if (token.kind !== "updates_checkpoint")
      return yield* new E.InvalidCursor({
        message:
          'This token is an updates continuation. Use mode="continue" and pass the same unchanged token as cursor to finish its snapshot. Keep your saved checkpoint; no replay is needed.',
      });
    selection = token.selection;
    boundary = token.boundary;
  }
  yield* checkSelection(tx, input.participantId, selection);

  const end = boundary + Math.min(U.scanWindow, ceiling - boundary);
  const limit = input.limit ?? 25;
  const candidates =
    end === boundary
      ? []
      : yield* tx.updateCandidates({
          ...selection,
          participantId: input.participantId,
          boundary,
          ceiling: end,
          limit: limit + 1,
        });
  const messages: M.Message[] = [];
  let bodyBytes = 0;
  for (const id of candidates.slice(0, limit)) {
    const message = yield* tx.message(id);
    if (message === null)
      return yield* Effect.die("Updates candidate disappeared inside its transaction");
    const size = new TextEncoder().encode(message.body).length;
    if (bodyBytes + size > U.bodyBudget) break;
    messages.push(message);
    bodyBytes += size;
  }
  // Renames share the message sequence, so the same window and checkpoint cover both. Every reader
  // receives every rename, its own included, whatever its selection.
  const renameLimit = Math.min(limit, R.maxNotices);
  const renameRows =
    end === boundary ? [] : yield* tx.renamesBetween(boundary, end, renameLimit + 1);
  let through = end;
  const lastMessage = messages.at(-1);
  if (candidates.length > messages.length) {
    if (lastMessage === undefined)
      return yield* Effect.die("A valid updates message must fit the response budget");
    through = lastMessage.sequence;
  }
  const lastRename = renameRows[renameLimit - 1];
  if (renameRows.length > renameLimit && lastRename !== undefined)
    through = Math.min(through, lastRename.sequence);
  // Task events share the sequence too: the reader's own (`mine`, the default), every one (`all`)
  // or none.
  const taskSelection = selection.tasks ?? "mine";
  const eventLimit = Math.min(limit, T.maxEventsPerPage);
  const eventRows =
    end === boundary || taskSelection === "none"
      ? []
      : yield* tx.board.eventsBetween(
          taskSelection === "all" ? null : input.participantId,
          boundary,
          end,
          eventLimit + 1,
        );
  const lastEvent = eventRows[eventLimit - 1];
  if (eventRows.length > eventLimit && lastEvent !== undefined)
    through = Math.min(through, lastEvent.seq);
  const tasks = [
    ...(yield* BoardView.events(
      tx,
      eventRows.filter((item) => item.seq <= through),
    )),
  ];
  const renames = renameRows.filter((item) => item.sequence <= through);
  const pageMessages = messages.filter((item) => item.sequence <= through);
  const conversations =
    pageMessages.length === 0
      ? []
      : yield* tx.updateConversations([
          ...new Set(pageMessages.map((item) => item.conversationId)),
        ]);
  const participantIds = new Set(pageMessages.map((item) => item.senderId));
  for (const item of conversations) {
    if (item.kind === "direct") for (const id of item.participantIds) participantIds.add(id);
  }
  for (const id of BoardView.eventParticipants(tasks)) participantIds.add(id);
  const included: U.Included = {
    conversations,
    participants:
      participantIds.size === 0 ? [] : yield* tx.updateParticipants([...participantIds]),
  };
  const cadence = yield* tx.wakeCadence(input.participantId);
  const wake = { wakeCadence: cadence, wakeIntervalSeconds: M.wakeCadenceSeconds[cadence] };
  const state = {
    version: 1 as const,
    serverId,
    generation: head.generation,
    participantId: input.participantId,
    selection,
  };
  for (;;) {
    const checkpoint = Navigation.encodeCursor({
      ...state,
      kind: "updates_checkpoint",
      boundary: through,
    });
    const nextCursor =
      through < ceiling
        ? Navigation.encodeCursor({ ...state, kind: "updates_page", boundary: through, ceiling })
        : null;
    const page: U.Page = {
      messages: [...pageMessages],
      checkpoint,
      nextCursor,
      ...wake,
      // Present only when there is one, so pages without renames or task events keep their shape.
      ...present("renames", renames.length === 0 ? null : [...renames]),
      ...present("tasks", tasks.length === 0 ? null : [...tasks]),
    };
    const result: U.Outcome = {
      data: page,
      included: describe(included, pageMessages, tasks),
    };
    if (bytes(result) <= U.outcomeBudget) return result;
    // Drop the newest item, message, rename or task event, and end the page just before it.
    const messageAt = pageMessages.at(-1)?.sequence ?? 0;
    const renameAt = renames.at(-1)?.sequence ?? 0;
    const taskAt = tasks.at(-1)?.sequence ?? 0;
    if (messageAt > renameAt && messageAt > taskAt) pageMessages.pop();
    else if (renameAt > taskAt) renames.pop();
    else tasks.pop();
    through = Math.max(
      pageMessages.at(-1)?.sequence ?? 0,
      renames.at(-1)?.sequence ?? 0,
      tasks.at(-1)?.sequence ?? 0,
    );
    if (through <= boundary)
      return yield* Effect.die("A valid updates item must fit the response budget");
  }
});

/**
 * The selection a call reads, known before reading so a wait can be armed first. Null when the
 * token does not parse; the read that follows reports the precise error.
 */
export const selectionOf = (input: U.Input): Effect.Effect<U.Selection | null> =>
  input.mode === "start"
    ? Effect.succeed({
        channelIds: input.channelIds,
        directChats: input.directChats,
        ...present("tasks", input.tasks),
      })
    : Navigation.parseCursor(
        Navigation.UpdatesCursor,
        input.mode === "poll" ? input.checkpoint : input.cursor,
      ).pipe(
        Effect.map((token) => token.selection),
        Effect.orElseSucceed(() => null),
      );
