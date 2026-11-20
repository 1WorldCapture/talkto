import { Schema } from "effect";
import * as M from "./models.js";
import * as P from "./plugins.js";
import * as U from "./updates.js";

/**
 * Signal links let a host's hook scripts learn that messages are waiting without holding any
 * TalkTo credential. A registered participant mints one through its own authenticated MCP
 * connection; the link answers only counts for that participant's own selection.
 */
export const createToolName = "create_signal";
/** Revoke a participant's signal link. */
export const revokeToolName = "revoke_signal";
/**
 * Path prefix of every signal link. A link reads `/v1/signals/<serverId>/<signalId>.<secret>`.
 * A hook checks it as `GET /v1/signals/<serverId>/<signalId>` with the secret in
 * `Authorization: Bearer <secret>`, so the secret stays out of request URLs, which hosting logs
 * record. The secret in the path still answers for hooks installed before this form.
 */
export const pathPrefix = "/v1/signals/";
/** Most messages one check counts; above it `more` is true. Counts are a notice, not a feed. */
export const countLimit = 100;
/** Default link lifetime: one working day. */
export const defaultTtlSeconds = 86_400;
/** Shortest and longest link lifetimes; rotation is calling create_signal again. */
export const TtlSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 300, maximum: 604_800 }),
).annotate({
  description: "Link lifetime in seconds, 300–604,800 (7 days); defaults to 86,400 (24 hours).",
});
/** Stable identity of one signal link; not a credential on its own. */
export const SignalId = Schema.String.check(
  Schema.isUUID(4),
  Schema.isPattern(/^[0-9a-f-]+$/),
).pipe(Schema.brand("SignalId"));
/** Parsed signal identity. */
export type SignalId = typeof SignalId.Type;
/** The random half of a link: 32 bytes, base64url. Only its SHA-256 is stored. */
export const Secret = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)).pipe(
  Schema.brand("SignalSecret"),
);
/** Parsed link secret. */
export type Secret = typeof Secret.Type;
/** The last path segment of a link, and of a legacy check that carries its secret in the path. */
export const tokenPattern = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
/** The last path segment of a check that carries its secret in the Authorization header. */
export const idPattern = /^([0-9a-f-]{36})$/;
/** The header form of a check: `Authorization: Bearer <secret>`. */
export const authorizationPattern = /^Bearer ([A-Za-z0-9_-]{43})$/;

/** What a hook reads. Never message text, senders, names or conversation identities. */
export const Counts = Schema.Struct({
  /** Incoming messages after `since` (or after the link was created), at most `countLimit`. */
  pending: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: countLimit })),
  /** How many of those were sent with priority urgent. */
  urgent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: countLimit })),
  /**
   * How many of those should wake an idle agent (added November 18, 2026): its direct messages,
   * channel messages that @mention it, and TalkTo's own notices. The rest of `pending` are other
   * channel messages, which a hook holds and mentions only when the agent next has a turn. Hooks
   * that predate the field wake for every pending message.
   */
  waking: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: countLimit })),
  /** More than `countLimit` are waiting. */
  more: Schema.Boolean,
  /** Pass back as `since` to count only newer messages; null while nothing has arrived. */
  cursor: Schema.NullOr(M.MessageId),
  expiresAt: M.Timestamp,
  /** How often the participant's person lets TalkTo wake it; added November 14, 2026. */
  wakeCadence: M.WakeCadence,
  /**
   * Start an idle turn for normal messages at most this often (0: whenever they arrive). Urgent
   * messages ignore it. Hooks that predate the field ignore it too.
   */
  wakeIntervalSeconds: M.WakeIntervalSeconds,
  /**
   * The newest published version of the plugin named in the check's `TalkTo-Plugin` header
   * (added November 16, 2026). Present only for a plugin this server knows.
   */
  latestPluginVersion: Schema.optionalKey(P.PluginVersion),
}).annotate({ identifier: "SignalCounts" });
/** Parsed signal counts. */
export interface Counts extends Schema.Schema.Type<typeof Counts> {}

/** What create_signal returns to the agent. */
export const Link = Schema.Struct({
  signalId: SignalId,
  url: Schema.String,
  expiresAt: M.Timestamp,
  selection: U.Selection,
  /** Hooks should not check more often than this. */
  minIntervalSeconds: Schema.Int,
  procedure: Schema.String,
}).annotate({ identifier: "SignalLink" });
/** Parsed signal link. */
export interface Link extends Schema.Schema.Type<typeof Link> {}
/** What revoke_signal returns. */
export const Revoked = Schema.Struct({ revoked: M.Count }).annotate({
  identifier: "SignalRevoked",
});
/** Parsed revocation result. */
export interface Revoked extends Schema.Schema.Type<typeof Revoked> {}
/** Hooks check at most this often; the participant read limit stays far away. */
export const minIntervalSeconds = 10;
