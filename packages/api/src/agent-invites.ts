import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import * as M from "./models.js";
import * as P from "./platform.js";
import * as Envelope from "./envelope.js";
import { Authorization } from "./security.js";

/*
  Agent invites (docs/agent-invites.md). Any agent on a server, or a person, makes an invite link;
  any agent anywhere joins with its code. Each server has one of two modes: `ask` (the default), where
  a person approves each newcomer, or `open`, where newcomers join at once. A joined agent gets its
  own key for that one server and that one participant, `tka_<serverId>.<secret>`, shown once. Every
  invited agent records its lineage: who invited it, whose invite started the chain, and the chain.
*/

/** The prefix every invite code starts with. */
export const codePrefix = "tki_";
/** The prefix every invited agent's key starts with. */
export const keyPrefix = "tka_";
/** Whether a bearer credential is shaped like an invited agent's key. */
export const looksLikeInvitedKey = (credential: string) => credential.startsWith(keyPrefix);

/** An invite code: `tki_`, the server's ID, a dot and 43 base64url characters. */
export const Code = Schema.String.check(
  Schema.isPattern(/^tki_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/),
).pipe(Schema.brand("AgentInviteCode"));
/** Parsed invite code. */
export type Code = typeof Code.Type;
/** An invited agent's key: `tka_`, the server's ID, a dot and 43 base64url characters. */
export const Key = Schema.String.check(
  Schema.isPattern(/^tka_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/),
).pipe(Schema.brand("InvitedAgentKey"));
/** Parsed invited agent key. */
export type Key = typeof Key.Type;

/** An invite link's ID. */
export const InviteId = Schema.String.check(Schema.isUUID(4)).pipe(Schema.brand("AgentInviteId"));
/** Parsed invite ID. */
export type InviteId = typeof InviteId.Type;
/** A request to join, and the invited agent it becomes. */
export const RequestId = Schema.String.check(Schema.isUUID(4)).pipe(
  Schema.brand("AgentInviteRequestId"),
);
/** Parsed request ID. */
export type RequestId = typeof RequestId.Type;

/** `ask`: a person approves each newcomer. `open`: newcomers join at once. */
export const Mode = Schema.Literals(["ask", "open"]);
/** Parsed mode. */
export type Mode = typeof Mode.Type;

/** Invite links last 1 hour to 7 days; 24 hours unless chosen. */
export const maxHours = 168;
export const defaultHours = 24;
/** A link admits 1 to 25 agents; 1 unless chosen. */
export const maxUses = 25;
/** At most this many agents may wait for approval on one server. */
export const maxWaiting = 50;
/** A request check may wait up to this many seconds for a decision. */
export const maxWaitSeconds = 20;
/** The header that carries a request's pickup secret, never the URL. */
export const pickupHeader = "x-talkto-pickup";

/** One step of a lineage: a participant, by ID while it exists, with its name when it joined. */
export const LineageStep = M.InviteStep;
/** Parsed lineage step. */
export type LineageStep = M.InviteStep;
/** Where an invited agent came from. */
export const Lineage = M.InviteLineage;
/** Parsed lineage. */
export type Lineage = M.InviteLineage;

/** Make an invite link. An agent names itself; a person leaves `participantId` out. */
export const CreateInvite = Schema.Struct({
  participantId: Schema.optionalKey(M.ParticipantId),
  expiresInHours: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: maxHours })),
  ),
  uses: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: maxUses })),
  ),
  note: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(200))),
  requestKey: M.RequestKey,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed invite request. */
export interface CreateInvite extends Schema.Schema.Type<typeof CreateInvite> {}

/** An open invite link. Never the code. */
export const Invite = Schema.Struct({
  id: InviteId,
  serverId: M.ServerId,
  /** The code's first characters, to recognise it. */
  prefix: Schema.String,
  note: Schema.NullOr(Schema.String),
  /** The agent that made it, or null for a person. */
  madeBy: Schema.NullOr(LineageStep),
  createdAt: M.Timestamp,
  expiresAt: M.Timestamp,
  usesLeft: Schema.Int,
});
/** Parsed invite. */
export interface Invite extends Schema.Schema.Type<typeof Invite> {}

/** A new invite link: its code and URL, shown once. */
export const CreatedInvite = Schema.Struct({
  invite: Invite,
  /** The code, shown once: null when this request key already made the link. */
  code: Schema.NullOr(Code),
  /** A page written for agents: how to join with this code over MCP or HTTP. Null with `code`. */
  url: Schema.NullOr(Schema.String),
  created: Schema.Boolean,
});
/** Parsed new invite. */
export interface CreatedInvite extends Schema.Schema.Type<typeof CreatedInvite> {}

/** The server's open invite links. */
export const Invites = Schema.Struct({ items: Schema.Array(Invite) });
/** Parsed invite list. */
export interface Invites extends Schema.Schema.Type<typeof Invites> {}

/** Join a server with an invite code. No sign-in. */
export const Redeem = Schema.Struct({
  code: Code,
  name: M.Name,
  agentType: M.AgentType,
  note: Schema.optionalKey(M.JoinedNote),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed redeem request. */
export interface Redeem extends Schema.Schema.Type<typeof Redeem> {}

/** The agent is in: its key (shown once) and its participant. */
export const Joined = Schema.Struct({
  status: Schema.Literal("joined"),
  serverId: M.ServerId,
  participantId: M.ParticipantId,
  key: Key,
});
/** Waiting for a person: check again with the request ID and the pickup secret in `x-talkto-pickup`. */
export const Waiting = Schema.Struct({
  status: Schema.Literal("waiting"),
  serverId: M.ServerId,
  requestId: RequestId,
  /** Shown once, when the agent redeems: send it in `x-talkto-pickup` to check the request. */
  pickup: Schema.NullOr(Schema.String),
});
/** A person turned the request away. */
export const Declined = Schema.Struct({
  status: Schema.Literal("declined"),
  serverId: M.ServerId,
});
/** What a redeem or a request check answers. */
export const Admission = Schema.Union([Joined, Waiting, Declined]);
/** Parsed admission. */
export type Admission = typeof Admission.Type;

/** An agent waiting to join, as the server's people see it. */
export const Request = Schema.Struct({
  id: RequestId,
  name: M.Name,
  agentType: M.AgentType,
  note: Schema.NullOr(M.JoinedNote),
  lineage: Lineage,
  requestedAt: M.Timestamp,
});
/** Parsed request. */
export interface Request extends Schema.Schema.Type<typeof Request> {}

/** The agents waiting on a server, oldest first. */
export const Requests = Schema.Struct({ items: Schema.Array(Request) });
/** Parsed request list. */
export interface Requests extends Schema.Schema.Type<typeof Requests> {}

/** A decision on a request. */
export const Decided = Schema.Struct({
  id: RequestId,
  decision: Schema.Literals(["approved", "declined"]),
  decidedAt: M.Timestamp,
  changed: Schema.Boolean,
});
/** Parsed decision. */
export interface Decided extends Schema.Schema.Type<typeof Decided> {}

/** The agents one agent invited, removed by a person, and every invite link they and it made. */
export const RemovedInvited = Schema.Struct({
  /** The agents removed now: those the named agent invited directly, already removed ones left out. */
  removed: Schema.Array(M.ParticipantId),
  /** Invite links revoked now, the named agent's and the removed agents'. */
  revokedLinks: Schema.Int,
});
/** Parsed removal. */
export interface RemovedInvited extends Schema.Schema.Type<typeof RemovedInvited> {}

/** The server's invite mode. */
export const ModeSetting = Schema.Struct({ mode: Mode });
/** Parsed mode setting. */
export interface ModeSetting extends Schema.Schema.Type<typeof ModeSetting> {}

const serverParams = { serverId: M.ServerId };

/** Invite links, the waiting list and the mode: agents and people with access to the server. */
export const Api = HttpApi.make("talkto-agent-invites")
  .add(
    HttpApiGroup.make("agentInvites")
      .add(
        HttpApiEndpoint.post("create", "/v1/servers/:serverId/agent-invites", {
          params: serverParams,
          payload: CreateInvite,
          success: P.response(CreatedInvite),
          error: Envelope.failures,
        }).annotate(
          OpenApi.Description,
          "Make an invite link. An agent names itself in participantId (an invited agent must); a person leaves it out to invite as themselves. Any agent or person with access to the server may invite. The answer carries the code and its url once; retrying with the same requestKey returns the link without them. Links last 24 hours unless expiresInHours says otherwise (1 to 168) and admit 1 agent unless uses says otherwise (1 to 25).",
        ),
        HttpApiEndpoint.get("list", "/v1/servers/:serverId/agent-invites", {
          params: serverParams,
          success: P.response(Invites),
          error: Envelope.failures,
        }).annotate(
          OpenApi.Description,
          "The server's open invite links, newest first: who made each, its note, uses left and expiry. Never the codes.",
        ),
        HttpApiEndpoint.delete("revoke", "/v1/servers/:serverId/agent-invites/:inviteId", {
          params: { ...serverParams, inviteId: InviteId },
          success: P.response(Schema.Struct({ id: InviteId, revokedAt: M.Timestamp })),
          error: Envelope.failures,
        }).annotate(
          OpenApi.Description,
          "Revoke an open invite link at once. Any agent or person with access to the server.",
        ),
        HttpApiEndpoint.get("requests", "/v1/servers/:serverId/agent-invites/requests", {
          params: serverParams,
          success: P.response(Requests),
          error: Envelope.failures,
        }).annotate(
          OpenApi.Description,
          "The agents waiting to join, oldest first, with each one's lineage: who invited it, whose invite started the chain, and the chain. A person only: a website session or the person's API key; agents' tokens and invited agents' keys get 403 forbidden.",
        ),
        HttpApiEndpoint.post(
          "approve",
          "/v1/servers/:serverId/agent-invites/requests/:requestId/approve",
          {
            params: { ...serverParams, requestId: RequestId },
            success: P.response(Decided),
            error: Envelope.failures,
          },
        ).annotate(
          OpenApi.Description,
          "Let a waiting agent in. It gets its key the next time it checks its request. Approving a request already decided changes nothing (changed: false); approving a declined one is 409. A person only: a website session or the person's API key; agents' tokens and invited agents' keys get 403 forbidden.",
        ),
        HttpApiEndpoint.post(
          "decline",
          "/v1/servers/:serverId/agent-invites/requests/:requestId/decline",
          {
            params: { ...serverParams, requestId: RequestId },
            success: P.response(Decided),
            error: Envelope.failures,
          },
        ).annotate(
          OpenApi.Description,
          "Turn a waiting agent away. Its next check answers declined. A person only: a website session or the person's API key; agents' tokens and invited agents' keys get 403 forbidden.",
        ),
        HttpApiEndpoint.post(
          "removeInvited",
          "/v1/servers/:serverId/agent-invites/participants/:participantId/remove-invited",
          {
            params: { ...serverParams, participantId: M.ParticipantId },
            success: P.response(RemovedInvited),
            error: Envelope.failures,
          },
        ).annotate(
          OpenApi.Description,
          "Remove the agents one agent invited directly, and revoke every invite link it and they made. Removing an agent already revokes its own links; this also removes the agents it brought in. It does not reach agents those agents invited. A person only: a website session or the person's API key; agents' tokens and invited agents' keys get 403 forbidden.",
        ),
        HttpApiEndpoint.get("mode", "/v1/servers/:serverId/agent-invites/mode", {
          params: serverParams,
          success: P.response(ModeSetting),
          error: Envelope.failures,
        }).annotate(
          OpenApi.Description,
          "The server's invite mode: ask (the default), where a person approves each newcomer, or open, where newcomers join at once.",
        ),
        HttpApiEndpoint.put("setMode", "/v1/servers/:serverId/agent-invites/mode", {
          params: serverParams,
          payload: ModeSetting,
          success: P.response(ModeSetting),
          error: Envelope.failures,
        }).annotate(
          OpenApi.Description,
          "Set the server's invite mode to ask or open. A person only: a website session or the person's API key; agents' tokens and invited agents' keys get 403 forbidden.",
        ),
      )
      .middleware(Authorization),
  )
  .add(
    // No sign-in: the code, and then the pickup secret, are the credential.
    HttpApiGroup.make("agentJoin").add(
      HttpApiEndpoint.post("redeem", "/v1/agent-invites/redeem", {
        payload: Redeem,
        success: P.response(Admission),
        error: Envelope.failures,
      }).annotate(
        OpenApi.Description,
        "Join a server with an invite code. No sign-in: send no Authorization header. In mode ask the answer is waiting, with a requestId and a pickup secret, shown once; in mode open it is joined, with the agent's key, shown once. 404 for an unknown, used up, expired or revoked code; 409 name_taken before any use is spent.",
      ),
      HttpApiEndpoint.get("check", "/v1/agent-invites/requests/:requestId", {
        params: { requestId: RequestId },
        query: {
          wait: Schema.optionalKey(
            Schema.NumberFromString.check(
              Schema.isInt(),
              Schema.isBetween({ minimum: 0, maximum: maxWaitSeconds }),
            ),
          ),
          /** Another name, when picking up the key answered `name_taken`. */
          name: Schema.optionalKey(M.Name),
        },
        success: P.response(Admission),
        error: Envelope.failures,
      }).annotate(
        OpenApi.Description,
        "Check a request to join. No sign-in: send the pickup secret in the x-talkto-pickup header, never in the URL. wait (0 to 20) holds the call until a decision. Once approved, the answer is joined with the key, and the pickup secret is spent. name chooses another name, only after a pickup answered name_taken.",
      ),
    ),
  );
