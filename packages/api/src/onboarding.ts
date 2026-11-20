import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import * as M from "./models.js";
import * as P from "./platform.js";
import * as Envelope from "./envelope.js";
import { Authorization } from "./security.js";

/** One person's recoverable setup intent, independent of client authorization. */
export const RunId = Schema.String.check(Schema.isUUID(4)).pipe(Schema.brand("OnboardingRunId"));
/** Parsed setup identifier. */
export type RunId = typeof RunId.Type;
/** Presentation can be replayed without changing resources or completion history. */
export const Step = Schema.Literals(["server", "agents", "share", "done"]);
/** Current wizard step. */
export type Step = typeof Step.Type;
/** Committed server creation choices. */
export const Draft = Schema.Struct({
  accountId: Schema.NullOr(P.AccountId),
  organizationName: M.ServerName,
  serverName: M.ServerName,
});
/** Parsed server choices. */
export interface Draft extends Schema.Schema.Type<typeof Draft> {}
/** Exactly one resource target; creating retains its immutable retry input. */
export const Setup = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("draft"), ...Draft.fields }),
  Schema.Struct({ kind: Schema.Literal("creating"), ...Draft.fields }),
  Schema.Struct({ kind: Schema.Literal("ready"), accountId: P.AccountId, serverId: M.ServerId }),
]);
/** Which setup guide the person picked for a slot: a lowercase slug such as `claude-code`. */
export const SetupId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/)).pipe(
  Schema.brand("OnboardingSetupId"),
);
/** Parsed setup guide slug. */
export type SetupId = typeof SetupId.Type;
/**
 * Fills the v1-required `agentType` of a slot nobody has picked yet. Readers decide whether a slot
 * is picked from `setup`, never from this value.
 */
export const unchosenAgentType = M.AgentType.make("generic");
/**
 * Keep the v1 name and agentType fields for old readers; current prompts never assign the name to
 * an agent. `setup` is present only after the person picked an agent for this slot, so runs saved
 * before it existed (whose types were filled in for them) start with nothing picked.
 */
export const Slot = Schema.Struct({
  name: M.Name,
  agentType: M.AgentType,
  registrationKey: Schema.optional(M.RequestKey),
  setup: Schema.optional(SetupId),
});
/** Whether the person picked an agent for this slot in the current flow. */
export const chosen = (slot: Slot): boolean => slot.setup !== undefined;
/**
 * Onboarding connects up to six agents: the two v1 slots, then up to four more. More agents are
 * connected from the server's Connect agents, which has no such limit.
 */
export const maxAgents = 6;
/** One of the run's invitation slots: 0 and 1 are v1's, 2 to 5 are `moreAgents`. */
export const SlotIndex = Schema.Literals([0, 1, 2, 3, 4, 5]);
/** A parsed slot index. */
export type SlotIndex = typeof SlotIndex.Type;
/** Persisted agent selection. */
export interface Slot extends Schema.Schema.Type<typeof Slot> {}
/** Stable correlation for one invitation, independent of the participant's chosen name. */
export const agentRequestKey = (runId: RunId, slot: SlotIndex): M.RequestKey =>
  M.RequestKey.make(`onboarding:${runId}:agent:${slot}`);
/** Private observation input; a legacy name only recovers an older saved run. */
export const AgentLookup = Schema.Struct({
  requestKey: M.RequestKey,
  legacyName: Schema.NullOr(M.Name),
});
/** The two invitation receipts expected by a run. */
export const AgentLookups = Schema.Tuple([AgentLookup, AgentLookup]);
/** Parsed invitation correlation, never an access credential. */
export type AgentLookups = typeof AgentLookups.Type;
/** The receipts of the slots after the first two, in slot order. */
export const MoreLookups = Schema.Array(AgentLookup).check(Schema.isMaxLength(maxAgents - 2));
/** Parsed lookups for slots 2 and up. */
export type MoreLookups = typeof MoreLookups.Type;
/** An unconfirmed send is reconciled, never implicitly sent again. */
export const InvitationIntent = Schema.Struct({
  email: P.Invite.fields.email,
  requestedAt: M.Timestamp,
  id: Schema.NullOr(P.InvitationId),
});
/** Current run retains confirmed choices across presentation replay. */
export const Run = Schema.Struct({
  id: RunId,
  createdAt: M.Timestamp,
  step: Step,
  setup: Setup,
  agents: Schema.Tuple([Slot, Slot]),
  /**
   * Slots 2 and up, added one at a time with "Connect another agent". Optional and outside the
   * v1 tuple, so deployed readers still decode the run; a v1 rewrite drops only these slots.
   */
  moreAgents: Schema.optional(Schema.Array(Slot).check(Schema.isMaxLength(maxAgents - 2))),
  invitation: Schema.NullOr(InvitationIntent),
});
/** Parsed current run. */
export interface Run extends Schema.Schema.Type<typeof Run> {}
/** Every slot of a run in order: the v1 pair, then the ones added after it. */
export const runSlots = (run: Run): ReadonlyArray<Slot> => [
  ...run.agents,
  ...(run.moreAgents ?? []),
];
/** D1-owned user preference. It grants no resource access. */
export const State = Schema.Struct({
  version: Schema.Literal(1),
  revision: M.Count,
  completedAt: Schema.NullOr(M.Timestamp),
  dismissedAt: Schema.NullOr(M.Timestamp),
  run: Schema.NullOr(Run),
});
/** Persisted progress for the authenticated person only. */
export interface State extends Schema.Schema.Type<typeof State> {}
/** Absence is distinct from a failed read; GET does not create a row. */
export const initial = (): State => ({
  version: 1,
  revision: 0,
  completedAt: null,
  dismissedAt: null,
  run: null,
});
/** An authorized, bounded observation of the exact two selected identities. */
export const ServerProgress = Schema.Struct({
  server: M.Server,
  agents: Schema.Tuple([Schema.NullOr(M.Participant), Schema.NullOr(M.Participant)]),
  /** The arrivals for `moreAgents`, in the same order; absent when the run has none. */
  moreAgents: Schema.optional(
    Schema.Array(Schema.NullOr(M.Participant)).check(Schema.isMaxLength(maxAgents - 2)),
  ),
});
/** Current server evidence, not a client-reported connection receipt. */
export interface ServerProgress extends Schema.Schema.Type<typeof ServerProgress> {}
/** Every slot's arrival in slot order, or null where nobody joined yet. */
export const progressAgents = (server: ServerProgress): ReadonlyArray<M.Participant | null> => [
  ...server.agents,
  ...(server.moreAgents ?? []),
];
/** Optional invitation evidence is only read on the sharing step. */
export const Progress = Schema.Struct({
  runId: RunId,
  server: Schema.NullOr(ServerProgress),
  invitation: Schema.NullOr(P.Invitation),
  invitee: Schema.NullOr(P.User),
  grant: Schema.NullOr(P.Grant),
});
/** Parsed fresh resource evidence. */
export interface Progress extends Schema.Schema.Type<typeof Progress> {}
const revision = { revision: M.Count };
const strict = { parseOptions: { onExcessProperty: "error" } } as const;
/** Intent commands prevent clients from assigning resources or asserting arrivals themselves. */
export const Command = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("configure"), ...revision, ...Draft.fields }).annotate(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("provision"), ...revision }).annotate(strict),
  Schema.Struct({
    kind: Schema.Literal("use_server"),
    ...revision,
    accountId: P.AccountId,
    serverId: M.ServerId,
  }).annotate(strict),
  Schema.Struct({
    kind: Schema.Literal("agents"),
    ...revision,
    types: Schema.Tuple([M.AgentType, M.AgentType]),
  }).annotate(strict),
  /** Pick the agent for one slot: the guide the person follows and the type it implies. */
  Schema.Struct({
    kind: Schema.Literal("choose"),
    ...revision,
    slot: SlotIndex,
    setup: SetupId,
    agentType: M.AgentType,
  }).annotate(strict),
  Schema.Struct({ kind: Schema.Literal("step"), ...revision, step: Step }).annotate(strict),
  Schema.Struct({ kind: Schema.Literal("invite"), ...revision, ...P.Invite.fields }).annotate(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("check_invitation"), ...revision }).annotate(strict),
  Schema.Struct({ kind: Schema.Literal("grant"), ...revision }).annotate(strict),
  Schema.Struct({ kind: Schema.Literal("finish"), ...revision }).annotate(strict),
  Schema.Struct({ kind: Schema.Literal("dismiss"), ...revision }).annotate(strict),
  Schema.Struct({ kind: Schema.Literal("replay"), ...revision }).annotate(strict),
  Schema.Struct({ kind: Schema.Literal("new_run"), ...revision }).annotate(strict),
]);
/** Parsed user intent. */
export type Command = typeof Command.Type;
/** Protected onboarding API; the caller identity is always supplied by authentication. */
export const Api = HttpApi.make("talkto-onboarding").add(
  HttpApiGroup.make("onboarding")
    .add(
      HttpApiEndpoint.get("state", "/v1/onboarding", {
        success: P.response(State),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("command", "/v1/onboarding", {
        payload: Schema.Struct({ command: Command }).annotate(strict),
        success: P.response(State),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.get("progress", "/v1/onboarding/progress", {
        query: Schema.Struct({ runId: RunId }).annotate(strict),
        success: P.response(Progress),
        error: Envelope.failures,
      }),
    )
    .middleware(Authorization),
);
