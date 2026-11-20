import { Clock, Context, DateTime, Effect, Layer } from "effect";
import * as G from "@talkto/api/guests";
import type * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as Platform from "../platform/service.js";
import * as PlatformModel from "../platform/model.js";
import * as People from "../platform/people.js";
import * as Model from "./model.js";

/*
  Server guests (docs/dashboard-api.md, "Server guests"). The organization's owner invites someone
  by email to a server they created; that person accepts while signed in with the same verified
  address and becomes a guest of that one server. The grant is TalkTo's own (a guest membership
  row), so the guest never joins the WorkOS organization and every organization page stays closed
  to them. Removing a guest is the Access dialog's Remove, which revokes like any other grant.
*/

type Operation<A> = Effect.Effect<A, Model.Failure>;
/** Guest invitations, reusable by any adapter. */
export class Service extends Context.Service<
  Service,
  {
    readonly list: (actor: PlatformModel.Actor, serverId: M.ServerId) => Operation<G.Invitations>;
    readonly invite: (
      actor: PlatformModel.Actor,
      serverId: M.ServerId,
      input: P.Invite,
    ) => Operation<G.Invited>;
    readonly resend: (
      actor: PlatformModel.Actor,
      serverId: M.ServerId,
      id: G.InvitationId,
    ) => Operation<G.Invited>;
    readonly cancel: (
      actor: PlatformModel.Actor,
      serverId: M.ServerId,
      id: G.InvitationId,
    ) => Operation<G.Invitation>;
    readonly preview: (actor: PlatformModel.Actor, id: G.InvitationId) => Operation<G.Preview>;
    readonly accept: (actor: PlatformModel.Actor, id: G.InvitationId) => Operation<G.Joined>;
    readonly shared: (actor: PlatformModel.Actor) => Operation<G.Shared>;
  }
>()("@talkto/guests/Service") {}

const now = Clock.currentTimeMillis.pipe(
  Effect.map((ms) => M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(ms)))),
);
const expiry = (at: M.Timestamp) =>
  M.Timestamp.make(
    DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(at), { days: G.invitationDays })),
  );
const denied = () =>
  new PlatformModel.Failure({
    code: "not_found",
    message: "The organization or server is unavailable.",
  });
const missing = () =>
  new PlatformModel.Failure({ code: "not_found", message: "This invitation is unavailable." });
const invalid = (message: string) => new PlatformModel.Failure({ code: "invalid_input", message });
const unavailable = (message = "This invitation was canceled or has expired. Ask for a new one.") =>
  new Model.Refusal({ code: "invitation_unavailable", message });
/** A stored pending invitation past its expiry is expired; nothing else is derived. */
const state = (row: Model.Row, at: M.Timestamp): G.InvitationState =>
  row.state === "pending" && row.expiresAt <= at ? "expired" : row.state;

/** Guest invitations over the platform's directory, identity, servers and email budgets. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const directory = yield* Platform.Directory;
    const identity = yield* Platform.Identity;
    const servers = yield* Platform.Servers;
    const budgets = yield* Platform.Invitations;
    const store = yield* Model.Store;
    const mail = yield* Model.Mail;
    const { origin } = yield* Model.Settings;
    const link = (id: G.InvitationId) => `${origin}/app/join/${id}`;
    const userOrNull = (userId: P.UserId) =>
      identity
        .user(userId)
        .pipe(
          Effect.catch((error) =>
            error.code === "not_found" ? Effect.succeed(null) : Effect.fail(error),
          ),
        );
    const nameOf = (userId: P.UserId) =>
      userOrNull(userId).pipe(
        Effect.map((user) => (user === null ? "Someone" : Model.personName(user))),
      );
    const publicInvitation = (
      row: Model.Row,
      at: M.Timestamp,
      guest: G.Guest | null,
    ): G.Invitation => ({
      id: row.id,
      serverId: row.serverId,
      email: row.email,
      state: state(row, at),
      createdAt: row.createdAt,
      sentAt: row.sentAt,
      sends: row.sends,
      expiresAt: row.expiresAt,
      acceptedAt: row.acceptedAt,
      canceledAt: row.canceledAt,
      guest,
    });
    const invited = (row: Model.Row, at: M.Timestamp, emailed: boolean): G.Invited => ({
      invitation: publicInvitation(row, at, null),
      link: link(row.id),
      emailed,
    });

    /**
     * Who may invite to a server: its creator, who is also the creator (owner) of its organization
     * and an active member. Anyone else who cannot manage the server sees nothing.
     */
    const inviter = Effect.fn("Guests.inviter")(function* (
      actor: PlatformModel.Actor,
      serverId: M.ServerId,
    ) {
      const server = yield* directory.server(serverId);
      if (server === null || server.createdBy !== actor.userId) return yield* denied();
      const found = yield* Platform.accountMembership(directory, identity, actor, server.accountId);
      if (found === null) return yield* denied();
      if (found.membership !== null) yield* directory.recordMembership(found.membership);
      if (found.membership === null || found.membership.status !== "active") return yield* denied();
      if (found.account.createdBy !== actor.userId)
        return yield* new PlatformModel.Failure({
          code: "forbidden",
          message: "Only the organization's owner can invite people to a server.",
        });
      return { server, account: found.account };
    });
    /** The invitation of this server, for its inviter. */
    const owned = Effect.fn("Guests.owned")(function* (serverId: M.ServerId, id: G.InvitationId) {
      const found = yield* store.find(id);
      if (found === null || found.serverId !== serverId) return yield* missing();
      return found;
    });
    /** The active member whose address this is, from the organization's first 100 members. */
    const memberAt = Effect.fn("Guests.memberAt")(function* (
      organizationId: P.OrganizationId,
      key: string,
    ) {
      const page = yield* identity.members(organizationId, undefined, 100);
      const users = yield* Effect.forEach(
        page.items.filter((member) => member.status === "active"),
        (member) => userOrNull(member.userId),
        { concurrency: 5 },
      );
      return users.find((user) => user !== null && Model.emailKey(user.email) === key)?.id ?? null;
    });
    /**
     * Fail unless one more address fits the organization's people limit. An active member's
     * address, or one that already holds a place (a live invitation to another server, or a
     * guest), takes no new one. Answers the place taken, so the caller can recount after a
     * concurrent invite, and the member found. Plans without a limit check nothing.
     */
    const ensurePlace = Effect.fn("Guests.ensurePlace")(function* (
      account: P.Account,
      key: string,
      at: M.Timestamp,
    ) {
      const standing = yield* directory.standing(account.id, at);
      const limit = People.limit(standing);
      if (limit === null) return { place: null, memberId: null };
      const memberId = yield* memberAt(account.organizationId, key);
      if (memberId !== null) return { place: null, memberId };
      if (yield* store.holdsPlace(account.organizationId, key, at))
        return { place: null, memberId: null };
      const name = People.limitName(standing);
      yield* People.ensureRoom(
        identity,
        directory.guestPlaces,
        account.organizationId,
        at,
        limit,
        1,
        name,
      );
      return { place: { limit, name }, memberId: null };
    });
    /** Resend, or a repeat invite of an expired invitation: budgets, then a new email. */
    const renew = Effect.fn("Guests.renew")(function* (
      actor: PlatformModel.Actor,
      account: P.Account,
      row: Model.Row,
      at: M.Timestamp,
    ) {
      // An expired invitation no longer holds a place; renewing it takes one again.
      if (row.expiresAt <= at && row.memberId === null)
        yield* ensurePlace(account, row.emailKey, at);
      yield* Platform.admitInvitation(identity, budgets, actor, account, row.email, "resend", at);
      const renewed = yield* store.renew(row.id, at, expiry(at));
      if (renewed === null || renewed.state !== "pending")
        return yield* invalid("Only pending invitations can be resent.");
      return invited(renewed, at, yield* mail.invited(renewed));
    });
    /** The signed-in person must be the invitee: a verified address equal to the invited one. */
    const invitee = Effect.fn("Guests.invitee")(function* (
      actor: PlatformModel.Actor,
      found: Model.Found,
    ) {
      const user = yield* identity.user(actor.userId);
      if (!user.emailVerified)
        return yield* new Model.Refusal({
          code: "email_unverified",
          message: "Verify your email address, then open the invitation again.",
        });
      if (Model.emailKey(user.email) !== found.emailKey) {
        const sentTo = Model.mask(found.email);
        return yield* new Model.Refusal({
          code: "invitation_email_mismatch",
          message: `This invitation was sent to ${sentTo}. Sign in with that address to accept it.`,
          sentTo,
        });
      }
      return user;
    });
    /** An invitation the caller may still act on: pending and open, or accepted by them. */
    const usable = (actor: PlatformModel.Actor, found: Model.Found, at: M.Timestamp) =>
      found.state === "accepted"
        ? found.acceptedUserId === actor.userId
        : found.state === "pending" && found.expiresAt > at && found.live === 1;
    const preview = (found: Model.Found, inviterName: string): G.Preview => ({
      id: found.id,
      serverId: found.serverId,
      serverName: found.serverName,
      organizationName: found.organizationName,
      inviterName,
      state: found.state === "accepted" ? "accepted" : "pending",
      expiresAt: found.expiresAt,
    });
    /** The accepted person's server, delivering their grant first if it is still pending. */
    const joined = Effect.fn("Guests.joined")(function* (
      actor: PlatformModel.Actor,
      found: Model.Found,
    ) {
      const grant = yield* directory.grant(found.serverId, actor.userId);
      if (grant === null || grant.revokedAt !== null)
        return yield* unavailable(
          "Your access to this server was removed. Ask the person who invited you for a new invitation.",
        );
      if (grant.appliedRevision < grant.revision)
        yield* Platform.deliver(directory, servers, grant);
      const server = yield* directory.server(found.serverId);
      if (server === null) return yield* unavailable();
      return {
        server: {
          id: server.id,
          accountId: server.accountId,
          name: server.name,
          createdBy: server.createdBy,
          createdAt: server.createdAt,
          status: "ready" as const,
          permissions: {
            readMessages: true,
            manageAccess: server.createdBy === actor.userId,
            resume: false,
          },
        },
        organizationName: found.organizationName,
        inviterName: yield* nameOf(found.inviterId),
      };
    });

    return Service.of({
      list: Effect.fn("Guests.list")(function* (actor, serverId) {
        yield* inviter(actor, serverId);
        const at = yield* now;
        const rows = yield* store.list(serverId);
        const items = yield* Effect.forEach(
          rows,
          Effect.fn("Guests.listed")(function* (row) {
            if (row.acceptedUserId === null) return publicInvitation(row, at, null);
            const user = yield* userOrNull(row.acceptedUserId);
            const access: G.GuestAccess =
              row.revokedAt !== null || row.revision === null
                ? "removed"
                : row.appliedRevision === row.revision
                  ? "active"
                  : "pending";
            return publicInvitation(row, at, {
              userId: row.acceptedUserId,
              name: user === null ? null : Model.personName(user),
              access,
            });
          }),
          { concurrency: 5 },
        );
        return { items };
      }),
      invite: Effect.fn("Guests.invite")(function* (actor, serverId, input) {
        const { server, account } = yield* inviter(actor, serverId);
        if (server.status !== "ready")
          return yield* invalid("The server is still being set up. Try again in a moment.");
        const key = Model.emailKey(input.email);
        if (Model.emailKey((yield* identity.user(actor.userId)).email) === key)
          return yield* invalid("That is your own address; you already have this server.");
        if (yield* store.hasAccess(serverId, key))
          return yield* invalid("Someone at this address already has access to this server.");
        const at = yield* now;
        // A repeat of a live invitation sends nothing; one that expired is renewed like Resend.
        const existing = yield* store.pending(serverId, key);
        if (existing !== null)
          return existing.expiresAt > at
            ? invited(existing, at, false)
            : yield* renew(actor, account, existing, at);
        const { place, memberId } = yield* ensurePlace(account, key, at);
        if (memberId !== null) {
          const grant = yield* directory.grant(serverId, memberId);
          if (grant !== null && grant.revokedAt === null)
            return yield* invalid("Someone at this address already has access to this server.");
        }
        yield* Platform.admitInvitation(identity, budgets, actor, account, input.email, "send", at);
        const id = yield* Model.invitationId;
        const row = yield* store.create({
          id,
          serverId,
          accountId: account.id,
          organizationId: account.organizationId,
          inviterId: actor.userId,
          memberId,
          email: input.email,
          emailKey: key,
          state: "pending",
          createdAt: at,
          sentAt: at,
          sends: 1,
          expiresAt: expiry(at),
          acceptedUserId: null,
          acceptedAt: null,
          canceledAt: null,
        });
        // A concurrent invite to the same address wrote first: answer with that one.
        if (row.id !== id) return invited(row, at, false);
        if (place !== null) {
          // Two concurrent invites can both pass the first count. Recount and withdraw this one.
          const people = yield* People.count(
            identity,
            directory.guestPlaces,
            account.organizationId,
            yield* now,
            place.limit,
          );
          if (people > place.limit) {
            yield* store.cancel(row.id, yield* now);
            return yield* People.reached(people, place.limit, true, place.name);
          }
        }
        return invited(row, at, yield* mail.invited(row));
      }),
      resend: Effect.fn("Guests.resend")(function* (actor, serverId, id) {
        const { account } = yield* inviter(actor, serverId);
        const found = yield* owned(serverId, id);
        if (found.state !== "pending")
          return yield* invalid("Only pending invitations can be resent.");
        return yield* renew(actor, account, found, yield* now);
      }),
      cancel: Effect.fn("Guests.cancel")(function* (actor, serverId, id) {
        yield* inviter(actor, serverId);
        const found = yield* owned(serverId, id);
        const at = yield* now;
        if (found.state === "canceled") return publicInvitation(found, at, null);
        if (found.state !== "pending")
          return yield* invalid("Only pending invitations can be canceled.");
        const canceled = yield* store.cancel(id, at);
        if (canceled === null || canceled.state !== "canceled")
          return yield* invalid("Only pending invitations can be canceled.");
        return publicInvitation(canceled, at, null);
      }),
      preview: Effect.fn("Guests.preview")(function* (actor, id) {
        const found = yield* store.find(id);
        if (found === null) return yield* missing();
        yield* invitee(actor, found);
        if (!usable(actor, found, yield* now)) return yield* unavailable();
        return preview(found, yield* nameOf(found.inviterId));
      }),
      accept: Effect.fn("Guests.accept")(function* (actor, id) {
        const found = yield* store.find(id);
        if (found === null) return yield* missing();
        const user = yield* invitee(actor, found);
        const at = yield* now;
        if (!usable(actor, found, at)) return yield* unavailable();
        // Accepting again answers the same, and finishes a delivery an earlier attempt left.
        if (found.state === "accepted") return yield* joined(actor, found);
        // An active member keeps their own membership; anyone else is a guest of this server.
        const member = yield* identity.membership(found.organizationId, actor.userId);
        if (member !== null) yield* directory.recordMembership(member);
        const through: Model.Through =
          member !== null && member.status === "active"
            ? { id: member.id, guest: false }
            : {
                id: yield* Model.guestMembershipId(found.organizationId, actor.userId),
                guest: true,
              };
        yield* store.accept(found, actor.userId, through, at);
        const after = yield* store.find(id);
        if (after === null || after.state !== "accepted" || after.acceptedUserId !== actor.userId)
          return yield* unavailable();
        const answer = yield* joined(actor, after);
        if (after.acceptedAt === at) yield* mail.joined(after, user);
        return answer;
      }),
      shared: Effect.fn("Guests.shared")(function* (actor) {
        const at = yield* now;
        const [rows, user] = yield* Effect.all(
          [store.shared(actor.userId), identity.user(actor.userId)],
          { concurrency: 2 },
        );
        const pending = user.emailVerified
          ? yield* store.invitedTo(Model.emailKey(user.email), at)
          : [];
        const invitations = yield* Effect.forEach(
          pending,
          (found) => nameOf(found.inviterId).pipe(Effect.map((name) => preview(found, name))),
          { concurrency: 5 },
        );
        return {
          servers: rows.map(({ readable, ...server }) => ({
            ...server,
            permissions: { readMessages: readable === 1, manageAccess: false, resume: false },
          })),
          invitations,
        };
      }),
    });
  }),
);
