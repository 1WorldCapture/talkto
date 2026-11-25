import { Schema } from "effect";
import * as AI from "@talkto/api/agent-invites";
import * as M from "@talkto/api/models";

/*
  What the Worker asks a server object when it admits an invited agent (docs/agent-invites.md):
  create the agent's one grant and one participant, and keep its key's hash and lineage. Admitting
  the same agent again replaces only the key's hash, so a lost answer is safe to retry.
*/

/** The invited agent's ID: its principal's (`invited:<id>`) and its grant's. */
export const InvitedId = Schema.String.check(Schema.isUUID(4)).pipe(Schema.brand("InvitedId"));
export type InvitedId = typeof InvitedId.Type;

/**
 * Lineage as TalkTo stores it: the public Lineage, plus the WorkOS user at the root of the chain,
 * so invites an invited agent makes keep the same origin. Never shown.
 */
export const StoredLineage = Schema.Struct({
  ...AI.Lineage.fields,
  originUserId: Schema.String,
});
export interface StoredLineage extends Schema.Schema.Type<typeof StoredLineage> {}
/** The public part of a stored lineage. */
export const shown = (lineage: StoredLineage): AI.Lineage => ({
  invitedBy: lineage.invitedBy,
  origin: lineage.origin,
  chain: lineage.chain,
});

/** Admit one invited agent. */
export const Admit = Schema.Struct({
  serverId: M.ServerId,
  id: InvitedId,
  name: M.Name,
  agentType: M.AgentType,
  note: Schema.NullOr(M.JoinedNote),
  /** SHA-256 of the agent's whole key, hex. */
  keyHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  lineage: StoredLineage,
});
export interface Admit extends Schema.Schema.Type<typeof Admit> {}

/** The server's answer. */
export type Admitted =
  | { readonly kind: "joined"; readonly participantId: M.ParticipantId }
  | { readonly kind: "name_taken"; readonly message: string }
  /** The agent that made the link was removed before this one joined. */
  | { readonly kind: "revoked" }
  | { readonly kind: "unavailable" };

/** The agents a person removed because one agent invited them. */
export type RemovedInvited =
  | { readonly kind: "removed"; readonly participantIds: ReadonlyArray<M.ParticipantId> }
  | { readonly kind: "denied" }
  | { readonly kind: "unavailable" };

/**
 * Who is making an invite on a server, as its server object answers: the inviting agent (null for
 * a person) and the lineage a newcomer inherits. `originUserId` and `origin` are null when a person
 * invites directly or through one of their own agents: the Worker fills them from the person.
 */
export type Inviter =
  | { readonly kind: "denied" }
  | { readonly kind: "not_own_agent" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "inviter";
      readonly invitedBy: AI.LineageStep | null;
      readonly chain: ReadonlyArray<AI.LineageStep>;
      readonly origin: { readonly userId: string; readonly name: string } | null;
    };
