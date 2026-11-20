import { Context, Effect } from "effect";
import type { Arrival } from "./store.js";

/**
 * Application port the message path calls after a send commits. The server object marks matching
 * wake targets due and arms its alarm; ordinary messaging never waits on an outbound call.
 */
export class WakeSchedule extends Context.Service<
  WakeSchedule,
  {
    readonly notify: (arrival: Arrival) => Effect.Effect<void>;
    /** Make sure the alarm fires by `at`, after a change moved a due wake earlier. */
    readonly arm: (at: number) => Effect.Effect<void>;
  }
>()("@talkto/WakeSchedule") {}
/** Compositions without wakes. */
export const none = WakeSchedule.of({ notify: () => Effect.void, arm: () => Effect.void });
