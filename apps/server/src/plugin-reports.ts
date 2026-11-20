import { DateTime, Effect } from "effect";
import type * as M from "@talkto/api/models";
import * as P from "@talkto/api/plugins";
import type * as Store from "./persistence.js";

/**
 * A plugin report that has not changed is written again at most this often, only to refresh
 * `seenAt`. Plugins poll every few seconds, so writing on every call would cost a row each time.
 */
export const refreshMillis = 86_400_000;

const epoch = (timestamp: M.Timestamp) => DateTime.toEpochMillis(DateTime.makeUnsafe(timestamp));

/**
 * Record the plugin a call named for this participant, and return the newest published version of
 * that plugin, or null when the call named none or a plugin this server does not know. Run it in
 * the call's transaction after the participant was checked, so it never records an unknown one.
 */
export const note = Effect.fn("PluginReports.note")(function* (
  tx: Store.Session,
  participantId: M.ParticipantId,
  release: string | null,
  at: M.Timestamp,
) {
  const report = release === null ? null : P.parseRelease(release);
  if (report === null) return null;
  const stored = yield* tx.pluginReport(participantId);
  if (
    stored === null ||
    stored.name !== report.name ||
    stored.version !== report.version ||
    epoch(at) - epoch(stored.seenAt) >= refreshMillis
  )
    yield* tx.notePlugin(participantId, report, at);
  return P.latestVersionOf(report.name);
});
