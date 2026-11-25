import { Schema } from "effect";
import * as M from "./models.js";

/** Versioned courtesy capacity; not an additional billed product. */
export const overdraftMessages = 500;
/** Shared billing state distinguishes observed usage from capacity still held by servers. */
export const Usage = Schema.Struct({
  status: Schema.Literals([
    "unmetered",
    "payment_required",
    "ready",
    "overdraft",
    "exhausted",
    "confirming",
  ]),
  periodStart: Schema.NullOr(M.Timestamp),
  periodEnd: Schema.NullOr(M.Timestamp),
  allowance: M.Count,
  overdraft: M.Count,
  used: M.Count,
  outstanding: M.Count,
  usageUpperBound: M.Count,
  available: M.Count,
  asOf: M.Timestamp,
  lastReportedAt: Schema.NullOr(M.Timestamp),
  /**
   * What funds the current allowance. A `starter` allowance has no end, so `periodEnd` is null
   * while it is current. A `free` allowance is the Free plan's month; absent on older responses.
   */
  kind: Schema.optionalKey(Schema.Literals(["paid", "trial", "starter", "free"])),
  /**
   * Free-start messages left unused when the organization first paid. They are already included
   * in `allowance` and last for that first paid period only. Zero when nothing carried over; absent
   * where messages are not counted and on older responses.
   */
  carriedOver: Schema.optionalKey(M.Count),
  /**
   * Share-link messages added to this free allowance (docs/share-links-spec.md). Already included
   * in `allowance`. Absent when none were added and on older responses.
   */
  bonus: Schema.optionalKey(M.Count),
  /**
   * The exact count while servers hold capacity (`outstanding` above zero): reported `used` plus
   * what those servers have committed but not reported yet, within `used` and `usageUpperBound`.
   * Absent when nothing is outstanding (then `used` is exact), when a server could not be asked,
   * and on older responses.
   */
  counted: Schema.optionalKey(M.Count),
}).annotate({ identifier: "MessageUsage" });
/** Parsed workspace usage; outstanding capacity can contain unreported commits. */
export interface Usage extends Schema.Schema.Type<typeof Usage> {}
/** Recovery fields do not reveal other servers, participants, or billing identities. */
export const Recovery = Schema.Struct({
  periodEnd: Schema.NullOr(M.Timestamp),
  retryable: Schema.Boolean,
  action: Schema.Literals(["contact_workspace_owner", "retry_same_request"]),
});
/** What an agent needs to act on a full stored-file pool; it names no other server or person. */
export const StoragePoolRecovery = Schema.Struct({
  retryable: Schema.Literal(false),
  action: Schema.Literal("send_smaller_or_wait"),
  limitBytes: M.Count,
  reservedBytes: M.Count,
  requestedBytes: M.Count,
  nextExpiryAt: Schema.NullOr(M.Timestamp),
});
/** When a read or poll may be retried, and which limit refused it. */
export const RateLimitRecovery = Schema.Struct({
  retryable: Schema.Literal(true),
  action: Schema.Literal("retry_after"),
  retryAfterSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 })),
  /**
   * `network`: too many bad API keys from one network (docs/dashboard-api.md, "API keys").
   * `organization` and `server` also answer too many renames of one in an hour.
   */
  scope: Schema.Literals(["participant", "organization", "network", "server"]),
});
