import { Context, Effect, Encoding, Schema } from "effect";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as G from "@talkto/api/guests";
import * as Platform from "../platform/model.js";

/*
  Server guests (docs/dashboard-api.md, "Server guests"): the application's ports. D1 owns
  invitations, guest memberships and the grants they lead to; `Mail` queues the invitation and
  "joined" emails. Grant delivery and invitation budgets reuse the platform's own operations.
*/

/** A guest invitation refused for a reason only these endpoints answer. */
export class Refusal extends Schema.TaggedError<Refusal>()("GuestRefusal", {
  code: Schema.Literals([
    "invitation_email_mismatch",
    "email_unverified",
    "invitation_unavailable",
  ]),
  message: Schema.String,
  /** Only for `invitation_email_mismatch`: the invited address, masked. */
  sentTo: Schema.optionalKey(Schema.String),
}) {}

/** Every failure a guest operation can end with. */
export type Failure = Platform.Failure | Platform.InvitationLimited | Refusal;

/** One stored invitation. */
export const Row = Schema.Struct({
  id: G.InvitationId,
  serverId: M.ServerId,
  accountId: P.AccountId,
  organizationId: P.OrganizationId,
  inviterId: P.UserId,
  /** The active member this address belonged to when invited, if checked and found. */
  memberId: Schema.NullOr(P.UserId),
  email: Schema.String,
  emailKey: Schema.String,
  state: Schema.Literals(["pending", "accepted", "canceled"]),
  createdAt: M.Timestamp,
  sentAt: M.Timestamp,
  sends: Schema.Int,
  expiresAt: M.Timestamp,
  acceptedUserId: Schema.NullOr(P.UserId),
  acceptedAt: Schema.NullOr(M.Timestamp),
  canceledAt: Schema.NullOr(M.Timestamp),
});
/** Parsed stored invitation. */
export interface Row extends Schema.Schema.Type<typeof Row> {}

/** An invitation with what the invitee is shown and whether its server is still open. */
export const Found = Schema.Struct({
  ...Row.fields,
  serverName: M.ServerName,
  organizationName: M.ServerName,
  /** 1 while the server is ready and not being deleted. */
  live: Schema.Int,
});
/** Parsed invitation with its server. */
export interface Found extends Schema.Schema.Type<typeof Found> {}

/** An invitation as its inviter lists it, with the accepted person's grant on that server. */
export const Listed = Schema.Struct({
  ...Row.fields,
  revokedAt: Schema.NullOr(M.Timestamp),
  revision: Schema.NullOr(Schema.Int),
  appliedRevision: Schema.NullOr(Schema.Int),
});
/** Parsed listed invitation. */
export interface Listed extends Schema.Schema.Type<typeof Listed> {}

/** A server shared with a guest. */
export const SharedRow = Schema.Struct({
  ...P.Server.fields,
  organizationName: M.ServerName,
  readable: Schema.Int,
});
/** Parsed shared server. */
export interface SharedRow extends Schema.Schema.Type<typeof SharedRow> {}

/** The membership an acceptance grants through: a TalkTo guest row, or the person's real one. */
export interface Through {
  readonly id: P.MembershipId;
  readonly guest: boolean;
}

/** Invitation, guest membership and grant records in D1. */
export class Store extends Context.Service<
  Store,
  {
    readonly find: (id: G.InvitationId) => Effect.Effect<Found | null, Platform.Failure>;
    readonly pending: (
      serverId: M.ServerId,
      emailKey: string,
    ) => Effect.Effect<Row | null, Platform.Failure>;
    /** Insert a new pending invitation, or return the pending one a concurrent invite wrote. */
    readonly create: (row: Row) => Effect.Effect<Row, Platform.Failure>;
    /** One more send of a pending invitation: `sends` + 1, a new `sentAt` and `expiresAt`. */
    readonly renew: (
      id: G.InvitationId,
      at: M.Timestamp,
      expiresAt: M.Timestamp,
    ) => Effect.Effect<Row | null, Platform.Failure>;
    readonly cancel: (
      id: G.InvitationId,
      at: M.Timestamp,
    ) => Effect.Effect<Row | null, Platform.Failure>;
    /** A server's invitations, newest first, without canceled ones. */
    readonly list: (serverId: M.ServerId) => Effect.Effect<ReadonlyArray<Listed>, Platform.Failure>;
    /** Whether the address already holds a place in the organization (a live invitation or a guest). */
    readonly holdsPlace: (
      organizationId: P.OrganizationId,
      emailKey: string,
      at: M.Timestamp,
    ) => Effect.Effect<boolean, Platform.Failure>;
    /** Whether someone who accepted an invitation to this server at this address still has access. */
    readonly hasAccess: (
      serverId: M.ServerId,
      emailKey: string,
    ) => Effect.Effect<boolean, Platform.Failure>;
    /**
     * One atomic batch: accept the pending, unexpired invitation of a live server, write the guest
     * membership when `through.guest`, and grant (or re-grant) the person's access to the server.
     * Writes nothing when the invitation is no longer pending.
     */
    readonly accept: (
      invitation: Found,
      userId: P.UserId,
      through: Through,
      at: M.Timestamp,
    ) => Effect.Effect<void, Platform.Failure>;
    readonly shared: (
      userId: P.UserId,
    ) => Effect.Effect<ReadonlyArray<SharedRow>, Platform.Failure>;
    /** Pending, unexpired invitations on live servers sent to this address. */
    readonly invitedTo: (
      emailKey: string,
      at: M.Timestamp,
    ) => Effect.Effect<ReadonlyArray<Found>, Platform.Failure>;
  }
>()("@talkto/guests/Store") {}

/**
 * TalkTo's own email (docs/email.md, "Server invitations"). `invited` queues the invitation email
 * for one send (`sends` numbers it, so a resend is a new email) and answers whether it was queued.
 * `joined` tells the inviter the guest arrived. Neither may fail the operation that called it.
 */
export class Mail extends Context.Service<
  Mail,
  {
    readonly invited: (invitation: Row) => Effect.Effect<boolean>;
    readonly joined: (invitation: Row, guest: P.User) => Effect.Effect<void>;
  }
>()("@talkto/guests/Mail") {}

/** Where join links point. */
export class Settings extends Context.Service<Settings, { readonly origin: string }>()(
  "@talkto/guests/Settings",
) {}

const unavailable = () =>
  new Platform.Failure({
    code: "storage_unavailable",
    message: "Server invitations are temporarily unavailable.",
  });
const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
/** A new invitation ID: `sinv_` and 128 random bits in 26 lowercase base32 characters. */
export const invitationId = Effect.sync(() => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bits = 0;
  let value = 0;
  let text = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      text += alphabet[(value >>> (bits - 5)) & 31] ?? "";
      bits -= 5;
    }
  }
  if (bits > 0) text += alphabet[(value << (5 - bits)) & 31] ?? "";
  return G.InvitationId.make(`sinv_${text}`);
});

/**
 * A guest's membership ID in one organization: `om_guest` and 32 hex characters of SHA-256, so
 * every acceptance by one person in one organization names the same row. WorkOS IDs start with
 * `om_01` and the self-host Access sign-in's are hex, so neither can collide.
 */
export const guestMembershipId = (organizationId: P.OrganizationId, userId: P.UserId) =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`talkto-guest-membership:v1\n${organizationId}\n${userId}`),
      ),
    catch: unavailable,
  }).pipe(
    Effect.map((digest) =>
      P.MembershipId.make(`om_guest${Encoding.encodeHex(new Uint8Array(digest).slice(0, 16))}`),
    ),
  );

/** Addresses compare without case or surrounding space. */
export const emailKey = (email: string) => email.trim().toLowerCase();

/** An address shown to someone it may not belong to: `c***@e***.com`. */
export const mask = (email: string) => {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, Math.max(at, 0));
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const suffix = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${suffix}`;
};

/** How a person is named to others here: their name, else their address's local part. */
export const personName = (user: P.User) => {
  const name = [user.firstName, user.lastName]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "")
    .join(" ");
  return name !== "" ? name : (user.email.split("@")[0] ?? "Someone");
};
