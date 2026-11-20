import { Effect } from "effect";
import * as TalkTo from "./talkto.js";
import * as Reads from "./reads.js";
import type * as Signals from "./signals.js";

/**
 * Answer one signal link check: open the link, admit the read under the participant's own read
 * limit (the same bucket its get_updates calls use), then count with the get_updates rule.
 */
export const check = Effect.fn("SignalCheck.check")(function* (request: Signals.Request) {
  const service = yield* TalkTo.Service;
  const opened = yield* service.openSignal(request.serverId, request.signalId, request.secret);
  yield* (yield* Reads.Reads).admit(opened.access, {
    operation: "signal",
    transport: "signal",
    participantId: opened.signal.participantId,
  });
  return yield* service.countSignal(opened, request.since, request.plugin ?? null);
});
