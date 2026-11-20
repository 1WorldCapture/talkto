import type * as A from "@talkto/api/agent";

/**
 * Readers that keep asking `get_updates` from one checkpoint while messages wait there. A client
 * that can read a page moves on to the page's checkpoint, so asking again and again from the same
 * one means it cannot take the page: on November 16, 2026 a Claude Code session whose MCP client
 * refused an added reply field polled one checkpoint for three and a half hours, and nothing on
 * the server showed it (docs/incidents/2026-11-16-follow-stopped.md).
 *
 * Kept in the server object's memory only: entries exist while messages wait for a reader, a
 * restart forgets them, and each participant and checkpoint is reported at most once.
 */

/** Answers from one checkpoint, each with messages waiting, after which the reader is reported. */
export const stuckPolls = 5;

interface Reader {
  readonly checkpoint: string;
  polls: number;
  reported: boolean;
}

/** One reader to report: who, and the plugin its calls named, if any. */
export interface Stuck {
  readonly serverId: string;
  readonly participantId: string;
  readonly plugin: string | null;
  readonly polls: number;
}

export class StuckReaders {
  private readonly readers = new Map<string, Reader>();

  /** Records one `get_updates` call and its answer; the reader to report, or null. */
  observe(input: typeof A.GetUpdates.Type, reply: A.Reply): Stuck | null {
    if (input.mode !== "poll") return null;
    const waiting = "data" in reply && "messages" in reply.data && reply.data.messages.length > 0;
    if (!waiting) {
      this.readers.delete(input.participantId);
      return null;
    }
    const seen = this.readers.get(input.participantId);
    if (seen === undefined || seen.checkpoint !== input.checkpoint) {
      this.readers.set(input.participantId, {
        checkpoint: input.checkpoint,
        polls: 1,
        reported: false,
      });
      return null;
    }
    seen.polls += 1;
    if (seen.reported || seen.polls < stuckPolls) return null;
    seen.reported = true;
    return {
      serverId: input.serverId,
      participantId: input.participantId,
      plugin: input.plugin ?? null,
      polls: seen.polls,
    };
  }
}
