import { Schema } from "effect";
import * as M from "./models.js";
import * as R from "./renames.js";
import * as P from "./plugins.js";

/** Stable MCP tool name for the incoming-message feed. */
export const toolName = "get_updates";
/** Maximum sequence positions examined by one page, including nonmatching messages. */
export const scanWindow = 2000;
/** Whole-message UTF-8 body budget. */
export const bodyBudget = 65536;
/** Application outcome budget; reserves 16 KiB for transport-specific metadata. */
export const outcomeBudget = 114688;
/** Persistent storage lineage; rotated when history is restored or rewound. */
export const Generation = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)).pipe(
  Schema.brand("UpdatesGeneration"),
);
/** Parsed storage lineage. */
export type Generation = typeof Generation.Type;
/** An explicit, bounded set of watched channels. */
export const ChannelIds = Schema.Array(M.ConversationId).check(
  Schema.isMaxLength(32),
  Schema.makeFilter((ids) => new Set(ids).size === ids.length, {
    expected: "a list without repeated IDs",
  }),
);
/** Channels watched without direct chats; an empty watch would never return anything. */
export const RequiredChannelIds = ChannelIds.check(
  Schema.isMinLength(1, { expected: 'at least one channel ID when directChats is "none"' }),
);
const scope = { channelIds: ChannelIds, directChats: Schema.Literals(["own", "none"]) };
/** Frozen selection carried by every checkpoint; at least one source is required. */
export const Selection = Schema.Struct(scope).check(
  Schema.makeFilter((value) => value.channelIds.length > 0 || value.directChats === "own"),
);
/** Parsed incoming-message selection. */
export type Selection = typeof Selection.Type;
/**
 * Longest wait one call may hold open. Twenty seconds keeps each call under common proxy,
 * HTTP-client and MCP-client timeouts while still cutting per-call overhead fourfold
 * against a five-second poll. The Worker that receives a waiting call holds it on a hibernatable
 * watch, so an open wait does not keep the server's Durable Object billed for duration.
 */
export const maxWaitSeconds = 20;
/**
 * Longest wait a call that names a plugin (`plugin`, as in "claude-code/0.3.4") may hold open.
 * The TalkTo plugins wait whenever they follow, so a longer wait makes fewer calls. They ask for it
 * first, and step down to `maxWaitSeconds` for half an hour when TalkTo refuses it or a host or
 * proxy cuts it short. Tool schemas and descriptions advertise only `maxWaitSeconds`.
 */
export const maxPluginWaitSeconds = 50;
/**
 * `waitSeconds` as the server accepts it; never published. Its bounds are checked by `pluginWait`,
 * which knows whether the call names a plugin.
 */
export const AcceptedWaitSeconds = Schema.Int;
/**
 * Bounds `waitSeconds`: up to `maxPluginWaitSeconds` for a call that names a plugin, and
 * `maxWaitSeconds` for any other, refused in the published bound's words, as it always was.
 */
export const pluginWait = Schema.makeFilter<{
  readonly waitSeconds?: number;
  readonly plugin?: string;
}>((input) => {
  const wait = input.waitSeconds ?? 0;
  const maximum = input.plugin === undefined ? maxWaitSeconds : maxPluginWaitSeconds;
  return wait >= 0 && wait <= maximum
    ? true
    : { path: ["waitSeconds"], issue: `Expected a value between 0 and ${maximum}` };
});
/** Seconds to hold an empty poll open until a matching message arrives; 0 or absent returns at once. */
export const WaitSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: maxWaitSeconds }),
).annotate({
  description:
    "Hold an empty result open for up to this many seconds (maximum 20) and return as soon as a matching message arrives. 0 or absent returns at once.",
});
const common = {
  participantId: M.ParticipantId,
  limit: Schema.optionalKey(M.Limit),
  waitSeconds: Schema.optionalKey(WaitSeconds),
  /** Added November 16, 2026; servers before it refuse the field, so plugins retry without it. */
  plugin: Schema.optionalKey(P.PluginRelease),
};
const start = {
  ...common,
  mode: Schema.Literal("start"),
  startAt: Schema.Literals(["now", "beginning"]),
};
/** Start a watch, poll a checkpoint, or continue its fixed snapshot. */
export const Input = Schema.Union([
  Schema.Struct({ ...start, channelIds: ChannelIds, directChats: Schema.Literal("own") }),
  Schema.Struct({
    ...start,
    channelIds: RequiredChannelIds,
    directChats: Schema.Literal("none"),
  }),
  Schema.Struct({ ...common, mode: Schema.Literal("poll"), checkpoint: M.Cursor }),
  Schema.Struct({ ...common, mode: Schema.Literal("continue"), cursor: M.Cursor }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Validated updates operation. */
export type Input = typeof Input.Type;
/** Complete incoming messages and caller-owned recovery positions. */
export const Page = Schema.Struct({
  messages: Schema.Array(M.Message).check(Schema.isMaxLength(100)),
  checkpoint: M.Cursor,
  nextCursor: Schema.NullOr(M.Cursor),
  /**
   * How often the participant's person lets TalkTo and its plugins wake it about new messages. It
   * does not change how often you may call get_updates yourself.
   */
  wakeCadence: M.WakeCadence,
  /** A plugin starts an idle turn for normal messages at most this often; urgent ignores it. */
  wakeIntervalSeconds: M.WakeIntervalSeconds,
  /**
   * Participants renamed on this server since the checkpoint, whatever channels you watch,
   * including your own registration. Present only when there is at least one. The same checkpoint
   * covers messages and renames, so saved checkpoints keep working and nothing is repeated.
   */
  renames: Schema.optionalKey(Schema.Array(R.Rename).check(Schema.isMaxLength(R.maxNotices))),
  /**
   * The newest published version of the plugin named in the call's `plugin` field. Present only
   * when the call named a plugin this server knows; the plugin compares it with its own version.
   */
  latestPluginVersion: Schema.optionalKey(P.PluginVersion),
});
/** Parsed updates page. */
export type Page = typeof Page.Type;
/** Only the identity fields needed to understand a batch. */
export const Participant = Schema.Struct({
  id: M.ParticipantId,
  name: M.Name,
  agentType: M.AgentType,
  kind: Schema.optionalKey(M.ParticipantKind),
});
/** Only the conversation fields needed to understand a batch. */
export const Conversation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("channel"),
    id: M.ConversationId,
    name: M.Name,
    archivedAt: Schema.NullOr(M.Timestamp),
  }),
  Schema.Struct({
    kind: Schema.Literal("direct"),
    id: M.ConversationId,
    participantIds: M.DirectConversation.fields.participantIds,
  }),
]);
/** Compact related records; no previews or unrelated profiles. */
export const Included = Schema.Struct({
  participants: Schema.Array(Participant),
  conversations: Schema.Array(Conversation),
});
/** Parsed compact context. */
export type Included = typeof Included.Type;
/** Application result shared by HTTP and MCP. */
export type Outcome = M.Outcome<Page, Included>;
