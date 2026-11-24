import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import * as M from "./models.js";
import * as P from "./platform.js";
import * as B from "./billing.js";
import * as Envelope from "./envelope.js";
import { Authorization } from "./security.js";

/** An organization the person created, and what deleting their account does to it. */
export const OwnedOrganization = Schema.Struct({
  accountId: P.AccountId,
  name: M.ServerName,
  /** Servers deleted with the organization, counting any still being created. */
  servers: M.Count,
  /** Active members besides the person; more than zero blocks deletion. */
  otherMembers: M.Count,
  /** The plan of a subscription that would be canceled at once; null without one. */
  plan: Schema.NullOr(B.Plan),
});
/** Parsed owned organization. */
export interface OwnedOrganization extends Schema.Schema.Type<typeof OwnedOrganization> {}
/**
 * A server the person created in an organization someone else owns. It stays with that
 * organization when the account is deleted; the person can delete it first.
 */
export const CreatedServer = Schema.Struct({
  serverId: M.ServerId,
  name: M.ServerName,
  accountId: P.AccountId,
  organization: M.ServerName,
});
/** Parsed server created in another person's organization. */
export interface CreatedServer extends Schema.Schema.Type<typeof CreatedServer> {}
/**
 * What deleting the account would do, read fresh on every request. `blocked` lists organizations
 * with other members: ownership cannot be transferred, so their other members must be removed
 * first. `website` is false when the caller used an API token, which can never delete an account.
 */
export const DeletionPlan = Schema.Struct({
  email: Schema.String,
  status: Schema.Literals(["ready", "blocked", "in_progress"]),
  deleted: Schema.Array(OwnedOrganization),
  blocked: Schema.Array(OwnedOrganization),
  /** Organizations owned by other people that the person leaves; their messages stay there. */
  memberships: M.Count,
  /** Servers the person created in organizations they still belong to but do not own. */
  servers: Schema.Array(CreatedServer),
  website: Schema.Boolean,
});
/** Parsed deletion plan. */
export interface DeletionPlan extends Schema.Schema.Type<typeof DeletionPlan> {}
/** The person's account email, typed to confirm an irreversible deletion. */
export const DeleteAccount = Schema.Struct({
  confirmation: Schema.String.check(Schema.isMaxLength(320)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed deletion confirmation. */
export interface DeleteAccount extends Schema.Schema.Type<typeof DeleteAccount> {}
/**
 * `deleted`: everything listed is gone. `finishing`: sign-in has ended and the remaining steps
 * continue automatically within minutes; nothing needs the person to return.
 */
export const DeletedAccount = Schema.Struct({ status: Schema.Literals(["deleted", "finishing"]) });
/** Parsed deletion outcome. */
export interface DeletedAccount extends Schema.Schema.Type<typeof DeletedAccount> {}

/** A server erased with its organization; `agents` is null when the server did not answer. */
export const OrganizationServer = Schema.Struct({
  id: M.ServerId,
  name: M.ServerName,
  agents: Schema.NullOr(M.Count),
});
/** Parsed server of an organization being deleted. */
export interface OrganizationServer extends Schema.Schema.Type<typeof OrganizationServer> {}
/**
 * What deleting one organization would do, read fresh for its owner. Deletion is immediate and
 * permanent: every server is erased, members and guests lose access, a paid plan is canceled at
 * once without a refund, and usage and any free start stay spent. `lastOrganization` is true when
 * the person belongs to no other organization; their TalkTo account stays either way.
 */
export const OrganizationDeletionPlan = Schema.Struct({
  accountId: P.AccountId,
  name: M.ServerName,
  status: Schema.Literals(["ready", "in_progress"]),
  servers: Schema.Array(OrganizationServer),
  /** Active members besides the owner, from the first page of up to 100. */
  otherMembers: M.Count,
  /** People who can open one server here without being members. */
  guests: M.Count,
  pendingInvitations: M.Count,
  plan: Schema.NullOr(B.Plan),
  /** End of the paid period covering now; null without one. */
  paidThrough: Schema.NullOr(M.Timestamp),
  /** The organization holds the free start or the Free plan, which does not return. */
  freeStart: Schema.Boolean,
  lastOrganization: Schema.Boolean,
  website: Schema.Boolean,
});
/** Parsed organization deletion plan. */
export interface OrganizationDeletionPlan extends Schema.Schema.Type<
  typeof OrganizationDeletionPlan
> {}
/** The organization's current name, typed to confirm deleting it. */
export const DeleteOrganization = Schema.Struct({
  confirmation: Schema.String.check(Schema.isMaxLength(400)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed organization deletion confirmation. */
export interface DeleteOrganization extends Schema.Schema.Type<typeof DeleteOrganization> {}
/** `finishing`: the organization is gone from every view; erasure completes within minutes. */
export const DeletedOrganization = Schema.Struct({
  accountId: P.AccountId,
  status: Schema.Literals(["deleted", "finishing"]),
});
/** Parsed organization deletion outcome. */
export interface DeletedOrganization extends Schema.Schema.Type<typeof DeletedOrganization> {}

/** The person's own account. Website session only for deletion; no MCP surface. */
export const Api = HttpApi.make("talkto-account").add(
  HttpApiGroup.make("account")
    .add(
      HttpApiEndpoint.get("deletionPlan", "/v1/me/deletion", {
        success: P.response(DeletionPlan),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("deleteAccount", "/v1/me/delete", {
        payload: DeleteAccount,
        success: P.response(DeletedAccount),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.get("organizationDeletionPlan", "/v1/accounts/:accountId/deletion", {
        params: { accountId: P.AccountId },
        success: P.response(OrganizationDeletionPlan),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("deleteOrganization", "/v1/accounts/:accountId/delete", {
        params: { accountId: P.AccountId },
        payload: DeleteOrganization,
        success: P.response(DeletedOrganization),
        error: Envelope.failures,
      }),
    )
    .middleware(Authorization),
);
