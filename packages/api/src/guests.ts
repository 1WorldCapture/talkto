import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import * as M from "./models.js";
import * as P from "./platform.js";
import * as Envelope from "./envelope.js";
import { Authorization } from "./security.js";

/*
  Server guests (docs/dashboard-api.md, "Server guests"). An organization's owner invites someone
  by email to one server they created. The person accepts while signed in with a verified address
  equal to the invited one; they become a guest who sees only that server. TalkTo holds the grant:
  the guest is never added to the inviter's WorkOS organization.
*/

/**
 * A server invitation: `sinv_` and 26 base32 characters (128 random bits). It is also the join
 * link's handle; the verified-email check, not the ID, is what admits someone.
 */
export const InvitationId = Schema.String.check(Schema.isPattern(/^sinv_[a-z2-7]{26}$/)).pipe(
  Schema.brand("ServerInvitationId"),
);
/** Parsed server invitation ID. */
export type InvitationId = typeof InvitationId.Type;

/** Days an invitation stays open after each send or resend. */
export const invitationDays = 7;
/** Days an accepted, canceled or expired invitation is kept before it is deleted. */
export const retentionDays = 30;

/**
 * `pending` until accepted, canceled or past `expiresAt` (`expired`). Expired is derived, never
 * stored; Resend renews it.
 */
export const InvitationState = Schema.Literals(["pending", "expired", "accepted", "canceled"]);
/** Parsed invitation state. */
export type InvitationState = typeof InvitationState.Type;

/**
 * The guest's access to the server now: `active` (applied), `pending` (being delivered) or
 * `removed` (revoked, for example by Remove in the Access dialog).
 */
export const GuestAccess = Schema.Literals(["active", "pending", "removed"]);
/** Parsed guest access status. */
export type GuestAccess = typeof GuestAccess.Type;

/** Who accepted, as the inviter sees them; `name` is null when the person no longer exists. */
export const Guest = Schema.Struct({
  userId: P.UserId,
  name: Schema.NullOr(Schema.String),
  access: GuestAccess,
}).annotate({ identifier: "ServerGuest" });
/** Parsed guest. */
export interface Guest extends Schema.Schema.Type<typeof Guest> {}

/** One invitation as its inviter sees it. `guest` is set once accepted. */
export const Invitation = Schema.Struct({
  id: InvitationId,
  serverId: M.ServerId,
  email: Schema.String,
  state: InvitationState,
  createdAt: M.Timestamp,
  sentAt: M.Timestamp,
  sends: Schema.Int,
  expiresAt: M.Timestamp,
  acceptedAt: Schema.NullOr(M.Timestamp),
  canceledAt: Schema.NullOr(M.Timestamp),
  guest: Schema.NullOr(Guest),
}).annotate({ identifier: "ServerInvitation" });
/** Parsed server invitation. */
export interface Invitation extends Schema.Schema.Type<typeof Invitation> {}

/**
 * An invite or resend: the invitation, the copyable join link, and whether TalkTo queued its
 * email. A repeat of a live invitation returns it unchanged with `emailed: false`.
 */
export const Invited = Schema.Struct({
  invitation: Invitation,
  link: Schema.String,
  emailed: Schema.Boolean,
}).annotate({ identifier: "ServerInvited" });
/** Parsed invite answer. */
export interface Invited extends Schema.Schema.Type<typeof Invited> {}

/** Invitations of one server: pending and expired ones, and accepted ones still kept. */
export const Invitations = Schema.Struct({ items: Schema.Array(Invitation) }).annotate({
  identifier: "ServerInvitations",
});
/** Parsed invitation list. */
export interface Invitations extends Schema.Schema.Type<typeof Invitations> {}

/** What the invited person sees before and after accepting. Never the invited address. */
export const Preview = Schema.Struct({
  id: InvitationId,
  serverId: M.ServerId,
  serverName: M.ServerName,
  organizationName: M.ServerName,
  inviterName: Schema.String,
  state: Schema.Literals(["pending", "accepted"]),
  expiresAt: M.Timestamp,
}).annotate({ identifier: "ServerInvitationPreview" });
/** Parsed invitation preview. */
export interface Preview extends Schema.Schema.Type<typeof Preview> {}

/** An accepted invitation: the server the person can now open. Accepting again answers the same. */
export const Joined = Schema.Struct({
  server: P.ServerContext,
  organizationName: M.ServerName,
  inviterName: Schema.String,
}).annotate({ identifier: "ServerJoined" });
/** Parsed join answer. */
export interface Joined extends Schema.Schema.Type<typeof Joined> {}

/** A server someone shared with the caller as a guest. */
export const SharedServer = Schema.Struct({
  ...P.ServerContext.fields,
  organizationName: M.ServerName,
}).annotate({ identifier: "SharedServer" });
/** Parsed shared server. */
export interface SharedServer extends Schema.Schema.Type<typeof SharedServer> {}

/**
 * Servers shared with the caller as a guest, and pending invitations sent to the caller's verified
 * address (none while it is unverified).
 */
export const Shared = Schema.Struct({
  servers: Schema.Array(SharedServer),
  invitations: Schema.Array(Preview),
}).annotate({ identifier: "Shared" });
/** Parsed shared listing. */
export interface Shared extends Schema.Schema.Type<typeof Shared> {}

/**
 * The signed-in address is not the invited one. `sentTo` is the invited address masked
 * (`c***@e***.com`); the server's name is withheld.
 */
export const EmailMismatch = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literal("invitation_email_mismatch"),
    message: Schema.String,
    sentTo: Schema.String,
  }),
  meta: Envelope.Meta,
}).annotate({ httpApiStatus: 403, identifier: "InvitationEmailMismatch" });
/** The signed-in address is not verified yet, so it cannot be compared. */
export const EmailUnverified = Schema.Struct({
  error: Schema.Struct({ code: Schema.Literal("email_unverified"), message: Schema.String }),
  meta: Envelope.Meta,
}).annotate({ httpApiStatus: 403, identifier: "EmailUnverified" });
/** The invitation was canceled, expired, accepted by someone else, or its server is gone. */
export const InvitationUnavailable = Schema.Struct({
  error: Schema.Struct({ code: Schema.Literal("invitation_unavailable"), message: Schema.String }),
  meta: Envelope.Meta,
}).annotate({ httpApiStatus: 409, identifier: "InvitationUnavailable" });
/** Failures only these endpoints answer, beside the shared envelope's. */
export const failures = [EmailMismatch, EmailUnverified, InvitationUnavailable] as const;
/** Guest failure decoder. */
export const Failure = Schema.Union(failures);
/** Parsed guest failure. */
export type Failure = typeof Failure.Type;

const errors = [...Envelope.failures, ...failures];
const server = { serverId: M.ServerId };
const invitation = { serverId: M.ServerId, invitationId: InvitationId };
/** Guest invitations for people. No MCP surface: agents never invite or accept. */
export const Api = HttpApi.make("talkto-guests").add(
  HttpApiGroup.make("guests")
    .add(
      HttpApiEndpoint.get("listServerInvitations", "/v1/servers/:serverId/invitations", {
        params: server,
        success: P.response(Invitations),
        error: errors,
      }),
      HttpApiEndpoint.post("inviteGuest", "/v1/servers/:serverId/invitations", {
        params: server,
        payload: P.Invite,
        success: P.response(Invited),
        error: errors,
      }),
      HttpApiEndpoint.post(
        "resendServerInvitation",
        "/v1/servers/:serverId/invitations/:invitationId/resend",
        { params: invitation, success: P.response(Invited), error: errors },
      ),
      HttpApiEndpoint.delete(
        "cancelServerInvitation",
        "/v1/servers/:serverId/invitations/:invitationId",
        { params: invitation, success: P.response(Invitation), error: errors },
      ),
      HttpApiEndpoint.get("previewInvitation", "/v1/invitations/:invitationId", {
        params: { invitationId: InvitationId },
        success: P.response(Preview),
        error: errors,
      }),
      HttpApiEndpoint.post("acceptInvitation", "/v1/invitations/:invitationId/accept", {
        params: { invitationId: InvitationId },
        success: P.response(Joined),
        error: errors,
      }),
      HttpApiEndpoint.get("shared", "/v1/shared", {
        success: P.response(Shared),
        error: errors,
      }),
    )
    .middleware(Authorization),
);
