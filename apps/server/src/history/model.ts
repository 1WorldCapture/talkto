import { Schema } from "effect";
import * as M from "@talkto/api/models";
import {
  archiveAfterDays,
  history,
  historyGigabytes,
  historyGraceDays,
  serverHistoryGigabytes,
} from "@talkto/api/pricing";

/** One day in milliseconds. */
export const day = 86_400_000;
/** The grace before a shorter window applies, in milliseconds. */
export const graceMillis = historyGraceDays * day;
/** The shortest window any plan has; younger history is never due, so no server checks before. */
export const shortestWindow =
  Math.min(...Object.values(history).map((terms) => terms.days ?? archiveAfterDays)) * day;
/**
 * The history window a server applies: delete (or, with `archive`, move to the archive) messages
 * older than `days`. `plan: null` keeps everything, as every server did before retention.
 */
export const Policy = Schema.Struct({
  plan: Schema.NullOr(M.HistoryPlan),
  days: Schema.NullOr(M.Count),
  archive: Schema.Boolean,
});
/** Parsed history window. */
export interface Policy extends Schema.Schema.Type<typeof Policy> {}
/** Everything stays: trials, no plan, owner-pilot and self-hosted organizations. */
export const keepAll: Policy = { plan: null, days: null, archive: false };
/** The window a plan's history promise means on the server. */
export const forPlan = (plan: M.HistoryPlan): Policy => {
  const terms = history[plan];
  return terms.archive
    ? { plan, days: M.Count.make(archiveAfterDays), archive: true }
    : { plan, days: M.Count.make(terms.days ?? archiveAfterDays), archive: false };
};
const span = (policy: Policy) => (policy.plan === null ? Infinity : (policy.days ?? Infinity));
/** Whether moving from `current` to `next` could remove something `current` would have kept. */
export const shortens = (current: Policy, next: Policy) =>
  span(next) < span(current) || (span(next) === span(current) && current.archive && !next.archive);
const same = (a: Policy, b: Policy) =>
  a.plan === b.plan && a.days === b.days && a.archive === b.archive;

/**
 * What a server remembers about its window. `pending` is a shorter window it has seen but not
 * applied yet; it applies `graceMillis` after `pendingSince`. `nextPruneAt` spaces out passes once
 * a server has caught up, so a busy server does not scan its oldest messages after every send.
 */
export const State = Schema.Struct({
  applied: Policy,
  pending: Schema.NullOr(Policy),
  pendingSince: Schema.NullOr(Schema.Number),
  checkedAt: Schema.Number,
  nextPruneAt: Schema.Number,
  /** Whether the archive may hold objects for this server, so cleanup can be skipped otherwise. */
  archiveUsed: Schema.Boolean,
  /** The most this server may keep in place, as last answered; absent or null: no cap. */
  capBytes: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
/** Parsed retention memory. */
export interface State extends Schema.Schema.Type<typeof State> {}

/**
 * Fold the organization's current window into what the server applies. A longer window applies at
 * once. A shorter one (a downgrade, or retention reaching a server for the first time) waits
 * `graceMillis` from when the server first saw it, so nothing is deleted the moment a plan
 * changes; seeing a different shorter window keeps the original start, so changing plans back and
 * forth cannot extend the grace forever. A server with no memory starts from keeping everything.
 */
export const advance = (state: State | null, fetched: Policy, now: number): State => {
  const base: State = state ?? {
    applied: keepAll,
    pending: null,
    pendingSince: null,
    checkedAt: now,
    nextPruneAt: 0,
    archiveUsed: false,
  };
  if (!shortens(base.applied, fetched))
    return { ...base, applied: fetched, pending: null, pendingSince: null, checkedAt: now };
  const since = base.pending !== null && base.pendingSince !== null ? base.pendingSince : now;
  if (now >= since + graceMillis)
    return { ...base, applied: fetched, pending: null, pendingSince: null, checkedAt: now };
  return {
    ...base,
    pending: base.pending !== null && same(base.pending, fetched) ? base.pending : fetched,
    pendingSince: since,
    checkedAt: now,
  };
};

/** Where a server's stored history begins, as the retention row records it. */
export interface Stored {
  readonly plan: M.HistoryPlan;
  readonly days: number;
  readonly archived: boolean;
  readonly throughAt: M.Timestamp;
  readonly throughSequence: number;
  /** The storage cap, not only the time window, removed messages (history-size.sql). */
  readonly capped: boolean;
}
const planNames: Record<M.HistoryPlan, string> = {
  free: "Free",
  shop: "Shop",
  studio: "Studio",
  factory: "Factory",
};
/** The reader-facing description: what is gone, why, and what to do instead of paging back. */
const capLabel = (plan: M.HistoryPlan) =>
  `${historyGigabytes[plan]} GB of history per organization and ${serverHistoryGigabytes} GB per server`;
export const describe = (stored: Stored): M.HistoryLimit => ({
  plan: stored.plan,
  days: M.Count.make(stored.days),
  before: stored.throughAt,
  archived: stored.archived,
  message: stored.capped
    ? stored.archived
      ? `This is the oldest history this server keeps in place. The organization's ${planNames[stored.plan]} plan keeps up to ${capLabel(stored.plan)} in place, so older messages moved to the organization's history archive early; messages up to ${stored.throughAt} are there. Do not page further back here.`
      : `This is the oldest history this server keeps. The organization's ${planNames[stored.plan]} plan keeps up to ${capLabel(stored.plan)}, so messages up to ${stored.throughAt} were deleted before their ${stored.days} days were up. Do not page further back; nothing older will return.`
    : stored.archived
      ? `This is the oldest history this server keeps in place. On the organization's ${planNames[stored.plan]} plan, messages older than ${stored.days} days move to the organization's history archive; messages up to ${stored.throughAt} are there. Do not page further back here.`
      : `This is the oldest history this server keeps. The organization's ${planNames[stored.plan]} plan keeps ${stored.days} days of history, so messages up to ${stored.throughAt} were deleted. Do not page further back; nothing older will return.`,
});
/** Added to a missing-message answer once a server has removed old history. */
export const missingHint = (stored: Stored) =>
  stored.archived
    ? stored.capped
      ? ` It may be older than ${stored.days} days, or past the history kept in place, and in the organization's history archive.`
      : ` It may be older than ${stored.days} days and in the organization's history archive.`
    : stored.capped
      ? ` It may be older than the history the organization's plan keeps (${stored.days} days, up to ${capLabel(stored.plan)}).`
      : ` It may be older than the ${stored.days} days of history the organization's plan keeps.`;

/** Decimal gigabytes, as caps are sold. */
const gigabyte = 1_000_000_000;
/** What each server may hold in place at most, in bytes, on every plan. */
export const serverCapBytes = serverHistoryGigabytes * gigabyte;
/**
 * A server below this never asks about the storage cap while its messages are all younger than the
 * shortest window: 100 servers (the default server cap) this small hold less than Free's 0.5 GB.
 */
export const capFloorBytes = 4_000_000;
/** Shedding stops at this share of the target, so a server does not trim after every send. */
export const capHeadroom = 0.95;
/**
 * Record a server's size in the organization's quota object and answer the most it may keep:
 * the plan's organization cap shared in proportion to what each server last reported, and never
 * more than `serverCapBytes`. Null: no cap applies.
 */
export const recordSize = (
  storage: DurableObjectStorage,
  serverId: M.ServerId,
  bytes: number,
  plan: M.HistoryPlan | null,
  at: M.Timestamp,
  /** Replaces the plan's organization cap; only verification supplies one. */
  organizationOverride: number | null = null,
): number | null =>
  storage.transactionSync(() => {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS history_sizes(server_id TEXT PRIMARY KEY,bytes INTEGER NOT NULL CHECK(bytes>=0),at TEXT NOT NULL) STRICT",
    );
    storage.sql.exec(
      "INSERT INTO history_sizes(server_id,bytes,at) VALUES(?,?,?) ON CONFLICT(server_id) DO UPDATE SET bytes=excluded.bytes,at=excluded.at",
      serverId,
      bytes,
      at,
    );
    if (plan === null) return null;
    const { total } = Schema.decodeUnknownSync(Schema.Struct({ total: M.Count }))(
      storage.sql.exec("SELECT COALESCE(SUM(bytes),0) AS total FROM history_sizes").one(),
    );
    const organization = organizationOverride ?? historyGigabytes[plan] * gigabyte;
    const share = total > organization ? Math.floor((organization * bytes) / total) : Infinity;
    return Math.min(serverCapBytes, share);
  });
/** A deleted server's history no longer counts toward its organization's cap. */
export const forgetSize = (storage: DurableObjectStorage, serverId: M.ServerId) => {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS history_sizes(server_id TEXT PRIMARY KEY,bytes INTEGER NOT NULL CHECK(bytes>=0),at TEXT NOT NULL) STRICT",
  );
  storage.sql.exec("DELETE FROM history_sizes WHERE server_id=?", serverId);
};

const CapsSetting = Schema.Struct({ TALKTO_HISTORY_CAPS: Schema.optionalKey(Schema.String) });
/** `TALKTO_HISTORY_CAPS=off` stops the storage caps; the time windows still apply. On by default. */
export const capsEnabled = (env: Env) => {
  const parsed = Schema.decodeUnknownOption(CapsSetting)(env);
  return parsed._tag === "None" || parsed.value.TALKTO_HISTORY_CAPS !== "off";
};
