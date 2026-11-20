import { Schema } from "effect";
import * as M from "./models.js";
import * as U from "./updates.js";

/**
 * Wakes reach a participant's cloud agent while it is not running. TalkTo sends a signed notice
 * that carries only counts and IDs, never message text, sender names or conversation names; the
 * woken agent then reads its messages through its own signed-in MCP connection with get_updates.
 *
 * ChatGPT subscribes itself through MCP events. The other hosts need a fire URL and a token copied
 * from that service; a person adds those on the TalkTo dashboard, so the token never passes through
 * an agent's chat. No MCP tool accepts one.
 */
/** End one or all of a participant's wakes. */
export const revokeToolName = "revoke_wake";
/** Read a participant's wakes, including why a wake was turned off. */
export const listToolName = "list_wakes";

/** Hosts that subscribe by themselves through MCP events (ChatGPT). */
export const subscribedKinds = ["mcp_events"] as const;
/** Hosts where a person pastes a fire URL and token into the TalkTo dashboard. */
export const TokenKind = Schema.Literals(["claude_routine", "grok_bot", "town"]);
/** Parsed token kind. */
export type TokenKind = typeof TokenKind.Type;
/** Every kind of wake target. */
export const Kind = Schema.Literals([...subscribedKinds, ...TokenKind.literals]);
/** Parsed wake kind. */
export type Kind = typeof Kind.Type;
/** What a person reads for each kind. */
export const labels = {
  mcp_events: "ChatGPT",
  claude_routine: "Claude Code routine",
  grok_bot: "Grok Bot routine",
  town: "Town routine",
} satisfies { readonly [K in Kind]: string };
/** The service itself, for sentences such as "Grok Bot accepted it". */
export const hostNames = {
  mcp_events: "ChatGPT",
  claude_routine: "Claude Code",
  grok_bot: "Grok Bot",
  town: "Town",
} satisfies { readonly [K in Kind]: string };

/** Where a kind's URLs may point. Compared after URL parsing. */
export interface Address {
  /** Exact hostnames. No suffix matching, no ports, no IP literals. */
  readonly hosts: ReadonlyArray<string>;
  /** The whole path must match. */
  readonly path: RegExp;
  /** Whether the URL may carry a query string. */
  readonly query: boolean;
}
/**
 * The only addresses TalkTo sends pasted tokens to. The server enforces these before storing a
 * wake and again before every request; the dashboard reads the kind of a pasted URL from them.
 */
export const addresses = {
  // https://platform.claude.com/docs/en/api/claude-code/routines-fire
  claude_routine: {
    hosts: ["api.anthropic.com"],
    path: /^\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]{1,64}\/fire$/,
    query: false,
  },
  // The official page names no host; `api2.cursor.sh` comes from third-party write-ups and must
  // be confirmed against a real routine's "POST to" field before this kind is enabled.
  grok_bot: {
    hosts: ["api2.cursor.sh"],
    path: /^\/automations\/webhook\/[A-Za-z0-9_-]{1,128}$/,
    query: false,
  },
  // The docs show only `https://your-town-url/…`; `api.town.com` is inferred and must be
  // confirmed against a real Webhook card before this kind is enabled.
  town: {
    hosts: ["api.town.com"],
    path: /^\/workflow-webhooks\/whk_[A-Za-z0-9_-]{1,128}$/,
    query: false,
  },
} satisfies { readonly [K in TokenKind]: Address };

/** A URL an address accepts, or why it was refused, phrased for the person who pasted it. */
export type UrlCheck =
  | { readonly _tag: "Allowed"; readonly url: URL }
  | { readonly _tag: "Refused"; readonly problem: string };
const refused = (problem: string): UrlCheck => ({ _tag: "Refused", problem });
/** Check a URL against one exact allowlist. */
export const checkUrl = (address: Address, raw: string): UrlCheck => {
  if (!URL.canParse(raw)) return refused("This is not a URL. Paste the whole URL the host shows.");
  const url = new URL(raw);
  if (url.protocol !== "https:") return refused("Only https:// URLs are accepted.");
  if (url.username !== "" || url.password !== "")
    return refused("The URL must not contain credentials.");
  if (url.port !== "") return refused("The URL must use the default HTTPS port.");
  if (!address.hosts.includes(url.hostname))
    return refused(`TalkTo only sends to ${address.hosts.join(" or ")} for this kind of wake.`);
  if (!address.path.test(url.pathname))
    return refused("The URL path does not match this host's fire URL.");
  if (url.hash !== "") return refused("The URL must not contain a fragment.");
  if (!address.query && url.search !== "")
    return refused("The URL must not contain a query string.");
  return { _tag: "Allowed", url };
};
/** The kind whose address accepts this pasted URL, or null when TalkTo cannot send to it. */
export const kindOf = (raw: string): TokenKind | null =>
  TokenKind.literals.find((kind) => checkUrl(addresses[kind], raw.trim())._tag === "Allowed") ??
  null;

/** A subscription ID (`sub_` and 32 hex digits) or a UUID v4 for a pasted target. */
export const WakeId = Schema.String.check(
  Schema.isPattern(
    /^(?:sub_[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/,
  ),
).pipe(Schema.brand("WakeId"));
/** Parsed wake identity. */
export type WakeId = typeof WakeId.Type;

/** A third-party fire URL as pasted; each kind checks its exact host and path. */
export const FireUrl = Schema.String.check(Schema.isMaxLength(2048)).annotate({
  description:
    "The fire or webhook URL exactly as the host shows it. HTTPS only, on that host's documented hostname.",
});
/** A third-party token as pasted. Stored encrypted; never returned, logged or shown beyond 4 characters. */
export const FireToken = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{8,512}$/)).annotate({
  description:
    "The token the host showed once. TalkTo stores it encrypted and never shows it again.",
});
/** How long a pasted target lasts before it must be registered again. */
export const TtlDays = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 90 })).annotate({
  description: "Days until this wake ends, 1–90; defaults to 30.",
});
/** Default lifetime of a pasted target. */
export const defaultTtlDays = 30;

/** What every wake says. Counts and IDs only. */
export const Notice = Schema.Struct({
  serverId: M.ServerId,
  participantId: M.ParticipantId,
  /** Incoming messages since the previous wake, at most `countLimit`. */
  pending: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  urgent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  /** More than `countLimit` are waiting. */
  more: Schema.Boolean,
  /**
   * A get_updates checkpoint positioned at the previous wake, for runs that keep no state of their
   * own: `mode: "poll"` with it returns exactly these messages. A position, not a credential; an
   * agent with its own saved checkpoint should keep using that one.
   */
  checkpoint: M.Cursor,
}).annotate({ identifier: "WakeNotice" });
/** Parsed notice. */
export interface Notice extends Schema.Schema.Type<typeof Notice> {}
/**
 * What a test wake says: a person chose "Send a test" on the dashboard. The same fields as a
 * notice, with nothing waiting and `test: true` where the host's body allows extra fields. Its
 * checkpoint is positioned at the newest message, so a run that polls with it finds nothing new
 * and ends; the next real wake still carries its own checkpoint.
 */
export const TestNotice = Schema.Struct({
  serverId: M.ServerId,
  participantId: M.ParticipantId,
  test: Schema.Literal(true),
  pending: Schema.Literal(0),
  urgent: Schema.Literal(0),
  more: Schema.Literal(false),
  checkpoint: M.Cursor,
}).annotate({ identifier: "WakeTestNotice" });
/** Parsed test notice. */
export interface TestNotice extends Schema.Schema.Type<typeof TestNotice> {}
/** Most messages one notice counts. */
export const countLimit = 100;
/** The MCP event a ChatGPT subscription receives. */
export const eventName = "messages.waiting";

/** What an MCP events subscription selects: the same scope as get_updates and create_signal. */
export const EventArguments = Schema.Union([
  Schema.Struct({
    serverId: M.ServerId,
    participantId: M.ParticipantId,
    channelIds: U.ChannelIds,
    directChats: Schema.Literal("own"),
  }),
  Schema.Struct({
    serverId: M.ServerId,
    participantId: M.ParticipantId,
    channelIds: U.ChannelIds.check(Schema.isMinLength(1)),
    directChats: Schema.Literal("none"),
  }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed subscription arguments. */
export type EventArguments = typeof EventArguments.Type;

/** How the latest "Send a test" ended, in plain words for the person who sent it. */
export const TestResult = Schema.Struct({
  at: M.Timestamp,
  /** The service answered that it started a run. */
  accepted: Schema.Boolean,
  message: Schema.String,
}).annotate({ identifier: "WakeTestResult" });
/** Parsed test result. */
export interface TestResult extends Schema.Schema.Type<typeof TestResult> {}

/** One wake as its participant sees it. Never the token, never the full URL. */
export const Wake = Schema.Struct({
  wakeId: WakeId,
  kind: Kind,
  host: Schema.String,
  /** The last 4 characters of the stored token or signing secret. */
  credentialHint: Schema.String,
  selection: U.Selection,
  state: Schema.Literals(["active", "disabled"]),
  addedAt: M.Timestamp,
  lastSentAt: Schema.NullOr(M.Timestamp),
  lastError: Schema.NullOr(Schema.String),
  disabledReason: Schema.NullOr(Schema.String),
  expiresAt: M.Timestamp,
  /** TalkTo never wakes this target more often than this. */
  minIntervalSeconds: Schema.Int,
  /** The latest test a person sent from the dashboard, or null. */
  lastTest: Schema.NullOr(TestResult),
}).annotate({ identifier: "Wake" });
/** Parsed wake status. */
export interface Wake extends Schema.Schema.Type<typeof Wake> {}
/**
 * What the dashboard sends to add a wake for the participant named in the path. The token travels
 * only in this body, never in a URL. Direct chats, at least one channel, or both.
 */
export const Register = Schema.Struct({
  kind: TokenKind,
  url: FireUrl,
  token: FireToken,
  ttlDays: Schema.optionalKey(TtlDays),
  channelIds: U.ChannelIds,
  directChats: Schema.Literals(["own", "none"]),
})
  .check(Schema.makeFilter((value) => value.channelIds.length > 0 || value.directChats === "own"))
  .annotate({ identifier: "WakeRegistration", parseOptions: { onExcessProperty: "error" } });
/** Parsed dashboard registration. */
export type Register = typeof Register.Type;
/** What list_wakes returns. */
export const List = Schema.Struct({
  items: Schema.Array(Wake),
  /** How often TalkTo may wake this agent; only a person changes it, on the dashboard. */
  cadence: M.WakeCadence,
}).annotate({ identifier: "WakeList" });
/** Parsed list result. */
export interface List extends Schema.Schema.Type<typeof List> {}
/**
 * How often TalkTo may wake one agent about new messages: outbound wakes, and the idle turns the
 * TalkTo plugins and hooks start. A minimum gap between wakes, not a delay: the first message
 * after a quiet period still wakes promptly. Urgent direct messages ignore it.
 */
export const Cadence = M.WakeCadence;
/** Parsed wake cadence. */
export type Cadence = typeof Cadence.Type;
/** Today's behavior: at most one wake a minute. Agents without a stored choice use it. */
export const defaultCadence = M.defaultWakeCadence;
/** The least seconds between two wakes for each choice; the host's own minimum still applies. */
export const cadenceSeconds = M.wakeCadenceSeconds;
/** What a person reads for each choice. */
export const cadenceLabels = {
  right_away: "Right away",
  every_minute: "At most once a minute",
  every_5_minutes: "At most every 5 minutes",
  every_15_minutes: "At most every 15 minutes",
} satisfies { readonly [K in Cadence]: string };
/** One plain sentence per choice, for the dashboard. */
export const cadenceDescriptions = {
  right_away: "Every new message wakes it, as soon as its app allows.",
  every_minute: "The default. Messages that arrive close together share one wake.",
  every_5_minutes: "New messages wait up to 5 minutes and arrive together.",
  every_15_minutes: "New messages wait up to 15 minutes and arrive together.",
} satisfies { readonly [K in Cadence]: string };
/** What the dashboard or API sends to change one agent's cadence. */
export const SetCadence = Schema.Struct({ cadence: Cadence }).annotate({
  identifier: "WakeCadenceInput",
  parseOptions: { onExcessProperty: "error" },
});
/** Parsed cadence change. */
export type SetCadence = typeof SetCadence.Type;
/** One agent's cadence, as the API returns it. */
export const CadenceSetting = Schema.Struct({
  participantId: M.ParticipantId,
  cadence: Cadence,
  /** The least seconds between two wakes; urgent direct messages ignore it. */
  intervalSeconds: M.WakeIntervalSeconds,
}).annotate({ identifier: "WakeCadenceSetting" });
/** Parsed cadence setting. */
export interface CadenceSetting extends Schema.Schema.Type<typeof CadenceSetting> {}

/** What the dashboard reads: the participant's wakes and whether pasted tokens can be added. */
export const Overview = Schema.Struct({
  ...List.fields,
  /** TALKTO_WAKE_TOKENS=on: Claude Code routine, Grok Bot and Town wakes can be added. */
  tokensEnabled: Schema.Boolean,
}).annotate({ identifier: "WakeOverview" });
/** Parsed dashboard listing. */
export interface Overview extends Schema.Schema.Type<typeof Overview> {}
/** What revoke_wake returns. */
export const Revoked = Schema.Struct({ revoked: M.Count }).annotate({ identifier: "WakeRevoked" });
/** Parsed revocation result. */
export interface Revoked extends Schema.Schema.Type<typeof Revoked> {}
