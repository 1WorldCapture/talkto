import * as M from "@talkto/api/models";
import * as W from "@talkto/api/wake";

/**
 * Outbound rules for one kind of wake target. Every value here comes from the host's own
 * documentation (see each kind's module); TalkTo never sends to a host outside `hosts`. Pasted
 * kinds take their address from `W.addresses`, which the dashboard reads too.
 */
export interface Policy extends W.Address {
  /** Smallest gap between two attempts to the same target, retries included. */
  readonly minIntervalMs: number;
  /** Consecutive failed attempts before the target is turned off. */
  readonly maxAttempts: number;
  /**
   * Whether a timeout is retried. Hosts without an idempotency key may already have started a
   * run when the response is lost, so a retry could start a second one.
   */
  readonly retryOnTimeout: boolean;
}

/** Messages that arrive within this window share one wake. Urgent direct messages skip it. */
export const debounceMs = 10_000;
/**
 * The target's participant's wake cadence in milliseconds, as SQL over a `wake_targets` row. No
 * stored choice is the default, once a minute. The literals come from the shared schema only.
 */
export const cadenceMsSql = `COALESCE((SELECT CASE cadence ${Object.entries(M.wakeCadenceSeconds)
  .map(([cadence, seconds]) => `WHEN '${cadence}' THEN ${seconds * 1000}`)
  .join(
    " ",
  )} END FROM participant_wake_cadence WHERE participant_id=wake_targets.participant_id), ${
  M.wakeCadenceSeconds[M.defaultWakeCadence] * 1000
})`;
/** Least time between two normal wakes of a target: the host's minimum or the cadence, the longer. */
export const gapSql = `MAX(min_interval_ms, ${cadenceMsSql})`;
/**
 * An urgent message may move a due wake earlier only when nothing but the cadence holds it: never
 * during a retry backoff (which includes a host's Retry-After), the wake budget or the read limit.
 */
export const advanceableSql =
  "failures=0 AND COALESCE(last_error,'') NOT IN ('budget','read_limit')";
/** Outbound calls one participant's wakes may make in an hour, retries included. */
export const participantHourlyBudget = 60;
/** Outbound calls one participant's wakes may make in a day, retries included. */
export const participantDailyBudget = 480;
/** Wakes one participant may hold at once, across every kind. */
export const participantTargetLimit = 8;
/** MCP event subscriptions one participant may hold at once. */
export const participantSubscriptionLimit = 5;
/** Targets one alarm pass delivers; the rest wait for the next pass a moment later. */
export const passLimit = 16;
/** Outbound requests end after this long; the response body is never read. */
export const timeoutMs = 5_000;
/** Wait before the next retry: 30 s, 1 min, 2 min, 4 min, then 8 min at most. */
export const backoffMs = (failures: number) =>
  Math.min(30_000 * 2 ** Math.max(0, failures - 1), 8 * 60_000);

/** Every delivery problem TalkTo records. Stored as these codes, never as host responses. */
export const reasons = [
  "timeout",
  "connection",
  "redirect",
  "rate_limited",
  "unauthorized",
  "not_found",
  "gone",
  "too_large",
  "rejected",
  "server_error",
  "not_allowed",
  "challenge_failed",
  "credential_unreadable",
] as const;
/** One delivery problem. */
export type Reason = (typeof reasons)[number];

/**
 * What the participant reads in list_wakes and the dashboard. Plain words for the person who
 * added the wake, naming the service; never a response body from the host.
 */
export const describe = (reason: Reason, kind: W.Kind): string => {
  const host = W.hostNames[kind];
  switch (reason) {
    case "timeout":
      return `Couldn't reach ${host} in time. It may still have started a run.`;
    case "connection":
      return `Couldn't reach ${host}.`;
    case "redirect":
      return `${host} sent TalkTo to another address, which TalkTo never follows. Copy the URL from ${host} again.`;
    case "rate_limited":
      return `${host} said it was started too often.`;
    case "unauthorized":
      return `The key was refused. Copy a new key from ${host} and paste it again.`;
    case "not_found":
      // Town answers 404 for a wrong secret too.
      return kind === "town"
        ? "That address wasn't found, or the secret is wrong. Check that the routine still exists and is on, then copy its URL and secret from Town again."
        : `That address wasn't found. Check that the routine still exists and is on, then copy its URL from ${host} again.`;
    case "gone":
      return `${host} says this address no longer exists. Copy the routine's URL again.`;
    case "too_large":
      return `${host} refused the wake as too large.`;
    case "rejected":
      return `${host} refused the wake. A paused routine does this.`;
    case "server_error":
      return `${host} had an error on its side.`;
    case "not_allowed":
      return "TalkTo no longer sends to this address.";
    case "challenge_failed":
      return "The callback did not answer the verification challenge.";
    case "credential_unreadable":
      return "TalkTo can no longer read the saved key. Paste it again.";
  }
};
/** Problems that pass on their own, so a person may simply try again later. */
export const transient: ReadonlySet<Reason> = new Set([
  "timeout",
  "connection",
  "rate_limited",
  "server_error",
]);
/**
 * Least time between two tests of one wake; the host's own minimum applies when longer. Each test
 * starts a real run on the person's account, so only a person's click sends one, and not often.
 */
export const testIntervalMs = 60_000;
/** The categories MCP events allows in `deliveryStatus.lastError`. */
export const eventCategory = (
  reason: Reason,
):
  | "connection_refused"
  | "timeout"
  | "tls_error"
  | "http_4xx"
  | "http_5xx"
  | "challenge_failed" => {
  switch (reason) {
    case "timeout":
      return "timeout";
    case "connection":
    case "not_allowed":
    case "credential_unreadable":
      return "connection_refused";
    case "server_error":
      return "http_5xx";
    case "challenge_failed":
      return "challenge_failed";
    default:
      return "http_4xx";
  }
};

/** Content-free sentence for hosts that start a run from free text. IDs and counts only. */
export const sentence = (notice: W.Notice | W.TestNotice) => {
  if ("test" in notice)
    return `TalkTo test wake for participant ${notice.participantId} on server ${notice.serverId}. A person chose "Send a test" on the TalkTo dashboard to check that this routine starts. Nothing new is waiting, and this notice carries no message text. Call get_updates through your TalkTo MCP connection with serverId ${notice.serverId} and participantId ${notice.participantId}: resume your own saved checkpoint if you keep one, otherwise use mode "poll" with checkpoint ${notice.checkpoint}. If it returns nothing new, end the run.`;
  const count = notice.more ? `More than ${notice.pending}` : String(notice.pending);
  const plural = notice.pending === 1 && !notice.more ? "message is" : "messages are";
  const urgent = notice.urgent > 0 ? ` (${notice.urgent} urgent)` : "";
  return `TalkTo wake: ${count} new ${plural} waiting${urgent} for participant ${notice.participantId} on server ${notice.serverId}. This notice carries no message text. Call get_updates through your TalkTo MCP connection with serverId ${notice.serverId} and participantId ${notice.participantId} to read them: resume your own saved checkpoint if you keep one, otherwise use mode "poll" with checkpoint ${notice.checkpoint}.`;
};
