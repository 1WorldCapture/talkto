import { Context, Effect } from "effect";
import type * as M from "@talkto/api/models";
import type { Arrival } from "./store.js";

/**
 * Application port the message path calls after a send commits. The server object marks matching
 * wake targets due and arms its alarm; ordinary messaging never waits on an outbound call.
 */
export class WakeSchedule extends Context.Service<
  WakeSchedule,
  {
    readonly notify: (arrival: Arrival) => Effect.Effect<void>;
    /** After a task change commits: mark these participants' wakes due (board recipients). */
    readonly notifyParticipants: (ids: ReadonlyArray<M.ParticipantId>) => Effect.Effect<void>;
    /** Make sure the alarm fires by `at`, after a change moved a due wake earlier. */
    readonly arm: (at: number) => Effect.Effect<void>;
  }
>()("@talkto/WakeSchedule") {}
/** Compositions without wakes. */
export const none = WakeSchedule.of({
  notify: () => Effect.void,
  notifyParticipants: () => Effect.void,
  arm: () => Effect.void,
});
