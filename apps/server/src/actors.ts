import { Clock, Context, Effect, Schema } from "effect";
import type * as M from "@talkto/api/models";
import * as E from "@talkto/api/errors";
import type { AccessContext } from "./access.js";
import type * as Store from "./persistence.js";
import * as Telemetry from "./telemetry.js";

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

/** Refusal for an agent operation naming an agent another person's access registered. */
export const notOwnAgent = () =>
  new E.AgentNotOwned({
    message:
      "This agent was registered through another person's access, so you cannot act as it. Use your own participant ID, or register your own agent with register_participant.",
  });

/**
 * `TALKTO_AGENT_OWNERSHIP`: `enforce` refuses an agent operation acting as another person's agent;
 * `watch` lets it through and reports a Sentry warning, so hosted TalkTo can see who relied on it
 * before refusing. Unset means `enforce`.
 */
export const OwnershipMode = Schema.Literals(["watch", "enforce"]);
export type OwnershipMode = typeof OwnershipMode.Type;

/** The deployment's ownership mode, read when a check runs; the composition root supplies it. */
export const AgentOwnership = Context.Reference<{ readonly mode: () => OwnershipMode }>(
  "talkto/server/Actors/AgentOwnership",
  { defaultValue: () => ({ mode: () => "enforce" }) },
);

/** The transaction an ownership check runs in, a fixed operation name for its watch report. */
export const Operation = Context.Reference<string>("talkto/server/Actors/Operation", {
  defaultValue: () => "unknown",
});

/** How long one person acting as one other person's agent is reported once, per isolate. */
const watchWindowMillis = 5 * 60_000;
/** Bound on remembered pairs, so a burst cannot grow the isolate's memory without limit. */
const watchPairLimit = 1_000;
/** When each (caller, agent) pair was last reported. Memory only: never stored or sent. */
const watched = new Map<string, number>();

/** Whether this pair is due a report now, recording it when it is. */
const due = (key: string, at: number) => {
  const last = watched.get(key);
  if (last !== undefined && at - last < watchWindowMillis) return false;
  watched.delete(key);
  if (watched.size >= watchPairLimit) {
    for (const [pair, when] of watched) if (at - when >= watchWindowMillis) watched.delete(pair);
    const oldest = watched.keys().next();
    if (watched.size >= watchPairLimit && oldest.done !== true) watched.delete(oldest.value);
  }
  watched.set(key, at);
  return true;
};

/** In watch mode, report an operation that enforce mode would refuse, at most once a window. */
const watch = Effect.fn("Actors.watchNotOwned")(function* (
  access: AccessContext,
  id: M.ParticipantId,
) {
  const at = yield* Clock.currentTimeMillis;
  if (!due(`${access.principalKey}\n${id}`, at)) return;
  const operation = yield* Operation;
  yield* Effect.sync(() => {
    console.warn("actors: an agent operation acted as another person's agent", operation);
    Telemetry.agentNotOwned(operation);
  });
});

/**
 * The agent an agent operation writes or acts as, which must have been registered through the
 * caller's own person's access. TalkTo cannot tell apart agents that share one person's connection,
 * so that person's agents may act as one another; another person's agents are refused, so nobody
 * can speak as, or change the state of, someone else's agent. An agent with no recorded registrant
 * is not refused. In watch mode the operation goes ahead and is reported instead.
 */
export const requireOwnAgent = Effect.fn("Actors.requireOwnAgent")(function* (
  tx: Store.Session,
  access: AccessContext,
  id: M.ParticipantId,
) {
  const item = yield* requireAgent(tx, id);
  const registrant = yield* tx.registeredBy(item.id);
  if (registrant === null || registrant === access.principalKey) return item;
  if ((yield* AgentOwnership).mode() === "enforce") return yield* notOwnAgent();
  yield* watch(access, item.id);
  return item;
});
