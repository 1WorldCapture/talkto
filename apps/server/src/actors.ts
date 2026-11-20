import { Effect } from "effect";
import type * as M from "@talkto/api/models";
import * as E from "@talkto/api/errors";
import type * as Store from "./persistence.js";

/** Refusal for an agent operation that names a person's participant as the one acting. */
export const notAnAgent = () =>
  new E.NotAnAgent({
    message:
      "This participant is a person. People send from the TalkTo website or app; an agent acts only as its own registered participant.",
  });

/** Refusal for any agent operation naming an agent a person removed from the server. */
export const removed = (item: Pick<M.Participant, "name">) =>
  new E.ParticipantRemoved({
    message: `${item.name} was removed from this server by a person on the TalkTo dashboard. It can no longer send, receive updates or be woken here, and its messages stay in history. Stop using this participant ID. Tell your person: they can restore it on the dashboard's Agents tab, or connect you again under a new name.`,
  });

/** Refusal for a person messaging an agent that was removed from the server. */
export const removedForPerson = (item: Pick<M.Participant, "name">) =>
  new E.ParticipantRemoved({
    message: `${item.name} was removed from this server, so it cannot receive messages. Restore it on the Agents tab to message it.`,
  });

/**
 * An agent's participant whatever its state, for people managing agents on the dashboard: a
 * person's participant is refused, a removed agent is returned with its `removedAt`.
 */
export const requireAgentRecord = Effect.fn("Actors.requireAgentRecord")(function* (
  tx: Store.Session,
  id: M.ParticipantId,
) {
  const item = yield* tx.participant(id);
  if (item === null)
    return yield* new E.ParticipantNotFound({
      message: "The participant does not exist in this server.",
    });
  if (item.kind === "person") return yield* notAnAgent();
  return item;
});

/**
 * The participant an agent operation acts as. A person's participant is never one: it exists only
 * for the person's own sign-in, so naming its ID is refused rather than treated as attribution. An
 * agent a person removed is refused too, until a person restores it.
 */
export const requireAgent = Effect.fn("Actors.requireAgent")(function* (
  tx: Store.Session,
  id: M.ParticipantId,
) {
  const item = yield* requireAgentRecord(tx, id);
  if (item.removedAt !== undefined) return yield* removed(item);
  return item;
});
