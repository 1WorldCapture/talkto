import type * as M from "@talkto/api/models";
import { isPerson } from "../api/me";
import type { Sender } from "./message-row";

/** Look up a participant from whichever records a response included. */
export type Directory = ReadonlyMap<M.ParticipantId, M.Participant>;

/** How a message's sender is shown; unknown senders keep a short ID rather than vanish. */
export function senderOf(
  participants: Directory,
  id: M.ParticipantId,
  me: M.ParticipantId | null | undefined,
): Sender {
  const participant = participants.get(id);
  return {
    name: participant?.name ?? `Participant ${id.slice(0, 8)}`,
    agentType: participant?.agentType ?? "",
    person: participant !== undefined && isPerson(participant),
    mine: me !== null && me !== undefined && id === me,
  };
}

/** Who is in a direct chat, from the reader's side. */
export function sidesOf(
  conversation: M.DirectConversation,
  participants: Directory,
  me: M.ParticipantId | null | undefined,
) {
  const [low, high] = conversation.participantIds;
  const mine = me !== null && me !== undefined && (low === me || high === me);
  const other = mine ? (low === me ? high : low) : null;
  // In someone else's chat with an agent, the agent is whichever side is not a person.
  const people = conversation.participantIds.filter((id) => {
    const participant = participants.get(id);
    return participant !== undefined && isPerson(participant);
  });
  const agents = conversation.participantIds.filter((id) => !people.includes(id));
  return { mine, other, agents };
}

/** A conversation's name: the channel, the agent in the reader's own chat, or both sides. */
export function titleOf(
  conversation: M.Conversation,
  participants: Directory,
  me: M.ParticipantId | null | undefined,
) {
  if (conversation.kind === "channel") return conversation.name;
  const sides = sidesOf(conversation, participants, me);
  const name = (id: M.ParticipantId) => participants.get(id)?.name ?? "Unknown";
  if (sides.other !== null) return name(sides.other);
  return conversation.participantIds.map(name).join(" & ");
}
