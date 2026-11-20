import type * as M from "@talkto/api/models";
import { formatActivityTime } from "./activity-time.js";
import "./removed-tag.css";

/** The quiet label beside a removed agent's name, in lists and in message history. */
export function RemovedTag({ participant }: { readonly participant?: M.Participant | undefined }) {
  if (participant?.removedAt === undefined) return null;
  return (
    <span
      className="removed-tag"
      title={`Removed from this server ${formatActivityTime(participant.removedAt)}`}
    >
      Removed
    </span>
  );
}
