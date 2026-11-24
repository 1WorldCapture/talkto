import { Clock, Context, DateTime, Effect, Layer } from "effect";
import type * as B from "@talkto/api/billing";
import { plans } from "@talkto/api/pricing";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as Model from "./model.js";
import * as IdentityDirectory from "./identity-directory.js";
import * as People from "./people.js";
import * as InvitationPolicy from "./invitation-policy.js";

type Operation<A> = Effect.Effect<A, Model.Failure>;
/** WorkOS operations needed for ownership and membership; no provider SDK leaks out. */
export class Identity extends Context.Service<
  Identity,
  {
    readonly user: (userId: P.UserId) => Operation<P.User>;
    readonly invitations: (
      organizationId: P.OrganizationId,
      after: string | undefined,
    ) => Operation<P.Page<P.Invitation>>;
    readonly invitation: (id: P.InvitationId) => Operation<P.Invitation>;
    readonly acceptedInvitee: (id: P.InvitationId) => Operation<P.UserId | null>;
    readonly findInvitations: (
      organizationId: P.OrganizationId,
      email: string,
    ) => Operation<P.Page<P.Invitation>>;
    readonly invite: (
      organizationId: P.OrganizationId,
      inviter: P.UserId,
      input: P.Invite,
    ) => Operation<P.Invitation>;
    readonly resend: (id: P.InvitationId) => Operation<P.Invitation>;
    readonly cancel: (id: P.InvitationId) => Operation<P.Invitation>;
    readonly deactivate: (member: P.Member) => Operation<P.Member>;
    readonly createAccount: (reservation: Model.AccountReservation) => Operation<P.OrganizationId>;
    /** Mirror an organization's TalkTo name on its identity-provider organization. */
    readonly renameOrganization: (
      organizationId: P.OrganizationId,
      name: typeof M.ServerName.Type,
    ) => Operation<void>;
    readonly membership: (
      organizationId: P.OrganizationId,
      userId: P.UserId,
    ) => Operation<P.Member | null>;
    readonly memberships: (
      userId: P.UserId,
      after: string | undefined,
      limit: number,
    ) => Operation<P.Page<P.Member>>;
    readonly members: (
      organizationId: P.OrganizationId,
      after: string | undefined,
      limit: number,
    ) => Operation<P.Page<P.Member>>;
    readonly events: (
      cursor: string | null,
      startedAt: M.Timestamp,
    ) => Operation<ReadonlyArray<Model.IdentityEvent>>;
    /** Delete the person's identity, ending sign-in. An already deleted user counts as done. */
    readonly deleteUser: (userId: P.UserId) => Operation<void>;
    /**
     * Delete the organization behind an account, found by its external ID when creation never
     * recorded it. An organization that no longer exists counts as done.
     */
    readonly deleteOrganization: (account: Model.AccountTombstone) => Operation<void>;
    /** The Connect applications the person authorized, for example their MCP agent apps. */
    readonly authorizedApplications: (
      userId: P.UserId,
    ) => Operation<ReadonlyArray<Model.AuthorizedApplication>>;
    /**
     * End the person's authorization of one Connect application, by its client ID: every grant and
     * refresh token of that user and client. An authorization already gone counts as done.
     */
    readonly revokeAuthorizedApplication: (userId: P.UserId, clientId: string) => Operation<void>;
  }
>()("@talkto/platform/Identity") {}
/** Cohesive directory persistence and durable access delivery. */
export class Directory extends Context.Service<
  Directory,
  {
    readonly reserveAccount: (
      actor: Model.Actor,
      input: P.Create,
      at: M.Timestamp,
    ) => Operation<Model.AccountReservation>;
    readonly completeAccount: (
      id: P.AccountId,
      organizationId: P.OrganizationId,
    ) => Operation<P.Account>;
    readonly account: (id: P.AccountId) => Operation<P.Account | null>;
    /**
     * Plan of the confirmed paid period covering `at`, else of the trial active at `at`, and any
     * operator grant.
     */
    readonly standing: (id: P.AccountId, at: M.Timestamp) => Operation<Model.Standing>;
    readonly accounts: (
      userId: P.UserId,
      organizations: ReadonlyArray<P.OrganizationId>,
    ) => Operation<ReadonlyArray<Model.AccountSummary>>;
    readonly recordMembership: (member: P.Member) => Operation<void>;
    /** Synchronize one bounded identity-provider page before returning organization discovery. */
    readonly recordMemberships: (members: ReadonlyArray<P.Member>) => Operation<void>;
    readonly removeMembership: (member: P.Member, at: M.Timestamp) => Operation<void>;
    readonly pendingMembership: (
      id: P.MembershipId,
    ) => Operation<ReadonlyArray<Model.AccessCommand>>;
    readonly managedServers: (
      userId: P.UserId,
      accountId: P.AccountId,
      input: P.ServerListing,
    ) => Operation<P.Page<P.ServerContext>>;
    readonly reserveServer: (
      actor: Model.Actor,
      account: P.Account,
      member: P.Member,
      input: P.Create,
      at: M.Timestamp,
    ) => Operation<Model.ServerReservation>;
    readonly server: (id: M.ServerId) => Operation<Model.ServerReservation | null>;
    readonly ready: (id: M.ServerId) => Operation<void>;
    /**
     * Rename an organization or a server and record it in one batch. The exact current name changes
     * nothing; a request key the person already used returns that rename's outcome unchanged, or
     * `idempotency_conflict` for another name.
     */
    readonly rename: (
      actor: Model.Actor,
      target: Model.RenameTarget,
      input: P.Rename,
      at: M.Timestamp,
    ) => Operation<Model.Renamed>;
    /** The target's current name and revision; null once it is deleted. */
    readonly currentName: (target: Model.RenameTarget) => Operation<Model.CurrentName | null>;
    /** Record that the target's mirror holds `revision`, confirming every rename up to it. */
    readonly nameApplied: (
      target: Model.RenameTarget,
      revision: number,
      at: M.Timestamp,
    ) => Operation<void>;
    /** Targets with a rename their mirror has not confirmed, oldest first, at most 20. */
    readonly pendingNames: () => Operation<ReadonlyArray<Model.RenameTarget>>;
    /** A server's newest renames, newest first. */
    readonly serverRenames: (
      id: M.ServerId,
      limit: number,
    ) => Operation<ReadonlyArray<Model.ServerRenameRecord>>;
    readonly deletion: (id: M.ServerId) => Operation<Model.ServerDeletion | null>;
    readonly beginDeletion: (id: M.ServerId, at: M.Timestamp) => Operation<Model.ServerDeletion>;
    readonly finishDeletion: (id: M.ServerId, at: M.Timestamp) => Operation<void>;
    readonly pendingDeletions: () => Operation<ReadonlyArray<Model.ServerDeletion>>;
    readonly discover: (userId: P.UserId, after: string | undefined) => Operation<P.Page<P.Server>>;
    readonly grants: (
      id: M.ServerId,
      after: string | undefined,
    ) => Operation<P.Page<Model.AccessCommand>>;
    readonly grant: (id: M.ServerId, userId: P.UserId) => Operation<Model.AccessCommand | null>;
    readonly existingGrantees: (
      id: M.ServerId,
      userIds: ReadonlyArray<P.UserId>,
    ) => Operation<ReadonlyArray<P.UserId>>;
    readonly allow: (
      id: M.ServerId,
      member: P.Member,
      at: M.Timestamp,
    ) => Operation<Model.AccessCommand>;
    readonly revoke: (
      id: M.ServerId,
      userId: P.UserId,
      at: M.Timestamp,
    ) => Operation<Model.AccessCommand>;
    readonly applied: (command: Model.AccessCommand) => Operation<void>;
    readonly pending: () => Operation<ReadonlyArray<Model.AccessCommand>>;
    readonly syncPosition: () => Operation<{
      readonly cursor: string | null;
      readonly startedAt: M.Timestamp;
    }>;
    readonly consume: (
      event: Model.IdentityEvent,
      previous: string | null,
      at: M.Timestamp,
    ) => Operation<void>;
    /** Places server guests hold in the organization's people limit (`People.GuestPlaces`). */
    readonly guestPlaces: People.GuestPlaces;
  }
>()("@talkto/platform/Directory") {}
/** Durable invitation email budgets, consulted before the identity provider sends anything. */
export class Invitations extends Context.Service<
  Invitations,
  {
    /** Record the attempt if every budget has room; otherwise return which budget refused it. */
    readonly reserve: (
      attempt: InvitationPolicy.Attempt,
    ) => Operation<InvitationPolicy.Refusal | null>;
  }
>()("@talkto/platform/Invitations") {}
/** Private management binding to the existing messaging server. */
export class Servers extends Context.Service<
  Servers,
  {
    readonly provision: (server: Model.ServerReservation) => Operation<void>;
    readonly erase: (deletion: Model.ServerDeletion) => Operation<void>;
    readonly apply: (command: Model.AccessCommand) => Operation<void>;
    /** Give the server object its new name; an older revision than it holds changes nothing. */
    readonly rename: (name: Model.ServerName) => Operation<void>;
    /** After an account deletion: rename the person's participant on that server, if any. */
    readonly forgetPerson: (command: Model.AccessCommand) => Operation<void>;
    /**
     * What the server offers people for files: null without a file store, otherwise the
     * repository, with null in place of a repository the server could not answer. Never fails.
     */
    readonly files: (serverId: M.ServerId) => Effect.Effect<P.ServerFiles | null>;
  }
>()("@talkto/platform/Servers") {}
/** Headless platform operations reusable by HTTP and future adapters. */
export class Service extends Context.Service<
  Service,
  {
    readonly currentUser: (actor: Model.Actor) => Operation<P.User>;
    readonly getAccount: (
      actor: Model.Actor,
      accountId: P.AccountId,
    ) => Operation<P.AccountContext>;
    readonly createAccount: (actor: Model.Actor, input: P.Create) => Operation<P.AccountContext>;
    /** The owner renames the organization in TalkTo and in WorkOS. Website sessions only. */
    readonly renameAccount: (
      actor: Model.Actor,
      evidence: Model.Evidence,
      accountId: P.AccountId,
      input: P.Rename,
    ) => Operation<P.RenamedAccount>;
    readonly listAccounts: (
      actor: Model.Actor,
      input: P.IdentityListing,
    ) => Operation<P.Page<P.AccountSummary>>;
    readonly listMembers: (
      actor: Model.Actor,
      accountId: P.AccountId,
      input: P.IdentityListing,
    ) => Operation<P.Page<P.MemberContext>>;
    readonly managedServers: (
      actor: Model.Actor,
      accountId: P.AccountId,
      input: P.ServerListing,
    ) => Operation<P.Page<P.ServerContext>>;
    readonly managedServer: (
      actor: Model.Actor,
      accountId: P.AccountId,
      serverId: M.ServerId,
    ) => Operation<P.ServerDetail>;
    /**
     * The people who manage the server's settings rename it; agents see the new name in
     * `get_context`. Website sessions only.
     */
    readonly renameServer: (
      actor: Model.Actor,
      evidence: Model.Evidence,
      accountId: P.AccountId,
      serverId: M.ServerId,
      input: P.Rename,
    ) => Operation<P.RenamedServer>;
    /** The server's recent renames, for anyone who can open it in the organization. */
    readonly serverRenames: (
      actor: Model.Actor,
      accountId: P.AccountId,
      serverId: M.ServerId,
    ) => Operation<P.ServerRenames>;
    readonly deleteServer: (
      actor: Model.Actor,
      accountId: P.AccountId,
      serverId: M.ServerId,
      input: P.DeleteServer,
    ) => Operation<P.DeletedServer>;
    readonly resumeServer: (
      actor: Model.Actor,
      accountId: P.AccountId,
      serverId: M.ServerId,
    ) => Operation<P.ServerContext>;
    readonly listInvitations: (
      actor: Model.Actor,
      accountId: P.AccountId,
      after: string | undefined,
    ) => Operation<P.Page<P.Invitation>>;
    /** Fails with `InvitationLimited`, sending nothing, when an email budget is used up. */
    readonly sendInvitation: (
      actor: Model.Actor,
      accountId: P.AccountId,
      input: P.Invite,
    ) => Effect.Effect<P.Invitation, Model.Failure | Model.InvitationLimited>;
    /** Fails with `InvitationLimited`, sending nothing, when an email budget is used up. */
    readonly resendInvitation: (
      actor: Model.Actor,
      accountId: P.AccountId,
      id: P.InvitationId,
    ) => Effect.Effect<P.Invitation, Model.Failure | Model.InvitationLimited>;
    readonly cancelInvitation: (
      actor: Model.Actor,
      accountId: P.AccountId,
      id: P.InvitationId,
    ) => Operation<P.Invitation>;
    /**
     * Fail with `people_limit_reached` unless the organization's people, counting pending
     * invitations, fit within `plan`. Checked before buying a plan.
     */
    readonly ensurePlanFits: (
      actor: Model.Actor,
      accountId: P.AccountId,
      plan: B.Plan,
    ) => Operation<void>;
    readonly removeMember: (
      actor: Model.Actor,
      accountId: P.AccountId,
      userId: P.UserId,
    ) => Operation<P.RemovedMember>;
    readonly createServer: (
      actor: Model.Actor,
      accountId: P.AccountId,
      input: P.Create,
    ) => Operation<P.Server>;
    readonly discoverServers: (
      actor: Model.Actor,
      after: string | undefined,
    ) => Operation<P.Page<P.Server>>;
    readonly listGrants: (
      actor: Model.Actor,
      serverId: M.ServerId,
      after: string | undefined,
    ) => Operation<P.Page<P.GrantContext>>;
    readonly grantAccess: (
      actor: Model.Actor,
      serverId: M.ServerId,
      userId: P.UserId,
    ) => Operation<P.Grant>;
    readonly listGrantCandidates: (
      actor: Model.Actor,
      serverId: M.ServerId,
      input: P.IdentityListing,
    ) => Operation<P.Page<P.User>>;
    readonly revokeAccess: (
      actor: Model.Actor,
      serverId: M.ServerId,
      userId: P.UserId,
    ) => Operation<P.Grant>;
    readonly synchronize: () => Operation<void>;
  }
>()("@talkto/platform/Service") {}

const now = Clock.currentTimeMillis.pipe(
  Effect.map((ms) => M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(ms)))),
);
const denied = () =>
  new Model.Failure({ code: "not_found", message: "The organization or server is unavailable." });
/**
 * Organization of each account this isolate has read. An account's organization never changes once
 * set, so a known organization lets the membership check start with the account read. Every
 * decision still uses the fresh account row and the caller's current membership.
 */
const organizations = new Map<P.AccountId, P.OrganizationId>();
const learn = (account: P.Account) => {
  if (organizations.size > 10000) organizations.clear();
  organizations.set(account.id, account.organizationId);
};
/**
 * An open account the caller may address, and the caller's current membership in its organization
 * (not yet checked for status). `null` when the account is unavailable to this caller.
 */
export const accountMembership = Effect.fn("Platform.accountMembership")(function* (
  directory: Directory["Service"],
  identity: Identity["Service"],
  actor: Model.Actor,
  id: P.AccountId,
) {
  const known = organizations.get(id);
  const [value, speculated] = yield* Effect.all(
    [
      directory.account(id),
      known === undefined ? Effect.succeed(undefined) : identity.membership(known, actor.userId),
    ],
    { concurrency: 2 },
  );
  if (value === null) return null;
  learn(value);
  const membership =
    speculated !== undefined && known === value.organizationId
      ? speculated
      : yield* identity.membership(value.organizationId, actor.userId);
  return { account: value, membership };
});
const publicGrant = (g: Model.AccessCommand): P.Grant => ({
  id: g.id,
  serverId: g.serverId,
  userId: g.userId,
  membershipId: g.membershipId,
  createdAt: g.createdAt,
  revokedAt: g.revokedAt,
  revision: g.revision,
  appliedRevision: g.appliedRevision,
});
const publicServer = (s: Model.ServerReservation): P.Server => ({
  id: s.id,
  accountId: s.accountId,
  name: s.name,
  createdBy: s.createdBy,
  createdAt: s.createdAt,
  status: s.status,
});
/**
 * Shared by every invitation send and resend (Members and server guests), after every other check
 * and immediately before the email is sent: the owner's email must be verified, and the attempt is
 * recorded durably first, so an ambiguous provider failure still spends it and is never retried
 * automatically.
 */
export const admitInvitation = Effect.fn("Platform.admitInvitation")(function* (
  identity: Identity["Service"],
  invitations: Invitations["Service"],
  actor: Model.Actor,
  account: P.Account,
  email: string,
  kind: InvitationPolicy.Attempt["kind"],
  at: M.Timestamp,
) {
  if (!(yield* identity.user(actor.userId)).emailVerified)
    return yield* new Model.Failure({
      code: "forbidden",
      message: "Verify your email address before sending invitations.",
    });
  const refused = yield* invitations.reserve({
    account,
    recipientKey: yield* InvitationPolicy.recipientKey(account.organizationId, email),
    kind,
    at,
  });
  if (refused === null) return;
  yield* Effect.logInfo("Invitation limited", { scope: refused.scope, tier: refused.tier });
  return yield* InvitationPolicy.limited(refused);
});
/** Deliver one access command to a server the caller has just read. */
const deliverTo = Effect.fn("Platform.deliverTo")(function* (
  directory: Directory["Service"],
  servers: Servers["Service"],
  server: Model.ServerReservation,
  command: Model.AccessCommand,
) {
  yield* servers.provision(server);
  yield* servers.apply(command);
  yield* directory.applied(command);
  yield* directory.ready(server.id);
  return publicGrant({ ...command, appliedRevision: command.revision });
});
/** Apply one access command to its server and record it applied: grants and revocations alike. */
export const deliver = Effect.fn("Platform.deliver")(function* (
  directory: Directory["Service"],
  servers: Servers["Service"],
  command: Model.AccessCommand,
) {
  const server = yield* directory.server(command.serverId);
  if (server === null) return yield* denied();
  return yield* deliverTo(directory, servers, server, command);
});
const accountContext = (value: P.Account, actor: Model.Actor): P.AccountContext => ({
  ...value,
  permissions: {
    createServer: true,
    manageMembers: value.createdBy === actor.userId,
    manageBilling: value.createdBy === actor.userId,
    rename: value.createdBy === actor.userId,
  },
});
/** Renaming changes what every member and agent sees, so it needs the person on the website. */
const websiteOnly = (what: "an organization" | "a server") =>
  new Model.Failure({
    code: "forbidden",
    message: `Rename ${what} on the TalkTo website while signed in. API tokens and agents cannot.`,
  });
/** A person's label in a rename notice: their name, else their email address. */
const personLabel = (user: P.User) =>
  [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email;
/** Whether the caller's grant lets them read the server's messages now. */
const readable = (server: Model.ServerReservation, grant: Model.AccessCommand | null) =>
  server.status === "ready" &&
  grant !== null &&
  grant.revokedAt === null &&
  grant.revision === grant.appliedRevision;

/** Apply membership policy before management operations; messaging never uses this layer. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const directory = yield* Directory;
    const identity = yield* Identity;
    const servers = yield* Servers;
    const invitations = yield* Invitations;
    const member = Effect.fn("Platform.member")(function* (
      organizationId: P.OrganizationId,
      userId: P.UserId,
    ) {
      const value = yield* identity.membership(organizationId, userId);
      if (value !== null) yield* directory.recordMembership(value);
      if (value === null || value.status !== "active") return yield* denied();
      return value;
    });
    const account = Effect.fn("Platform.account")(function* (actor: Model.Actor, id: P.AccountId) {
      const found = yield* accountMembership(directory, identity, actor, id);
      if (found === null) return yield* denied();
      if (found.membership !== null) yield* directory.recordMembership(found.membership);
      if (found.membership === null || found.membership.status !== "active") return yield* denied();
      return { value: found.account, membership: found.membership };
    });
    const manage = Effect.fn("Platform.manage")(function* (actor: Model.Actor, id: M.ServerId) {
      const value = yield* directory.server(id);
      if (value === null || value.createdBy !== actor.userId) return yield* denied();
      yield* member(value.organizationId, actor.userId);
      return value;
    });
    const manageAccount = Effect.fn("Platform.manageAccount")(function* (
      actor: Model.Actor,
      id: P.AccountId,
    ) {
      const { value } = yield* account(actor, id);
      if (value.createdBy !== actor.userId) return yield* denied();
      return value;
    });
    const invitation = Effect.fn("Platform.invitation")(function* (
      actor: Model.Actor,
      accountId: P.AccountId,
      id: P.InvitationId,
    ) {
      const account = yield* manageAccount(actor, accountId);
      const invite = yield* identity.invitation(id);
      if (invite.organizationId !== account.organizationId) return yield* denied();
      return { account, invite };
    });
    const admit = (
      actor: Model.Actor,
      account: P.Account,
      email: string,
      kind: InvitationPolicy.Attempt["kind"],
      at: M.Timestamp,
    ) => admitInvitation(identity, invitations, actor, account, email, kind, at);
    const deliverCommand = (command: Model.AccessCommand) => deliver(directory, servers, command);
    /**
     * Copy the target's current name to its mirror (WorkOS, or the server object) and record it
     * confirmed. When a newer rename landed meanwhile, the newer name is delivered too, so a slow
     * earlier delivery never leaves the mirror on an older name.
     */
    const syncName = Effect.fn("Platform.syncName")(function* (target: Model.RenameTarget) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = yield* directory.currentName(target);
        if (current === null || (attempt === 0 && !current.pending)) return;
        if (target.kind === "organization")
          yield* identity.renameOrganization(current.organizationId, current.name);
        else
          yield* servers.rename({
            serverId: target.id,
            name: current.name,
            revision: current.revision,
          });
        const latest = yield* directory.currentName(target);
        if (latest === null) return;
        if (latest.revision === current.revision)
          return yield* directory.nameApplied(target, current.revision, yield* now);
      }
    });
    /** The caller's view of a server they may manage or read in this organization. */
    const managedView = Effect.fn("Platform.managedView")(function* (
      actor: Model.Actor,
      accountId: P.AccountId,
      id: M.ServerId,
    ) {
      // The server and grant reads start with the membership check; nothing is used until it passes.
      const [, server, grant] = yield* Effect.all(
        [account(actor, accountId), directory.server(id), directory.grant(id, actor.userId)],
        { concurrency: "unbounded" },
      );
      if (server === null || server.accountId !== accountId) return yield* denied();
      const reader = readable(server, grant);
      const owner = server.createdBy === actor.userId;
      if (!owner && !reader) return yield* denied();
      return { server, reader, owner };
    });
    const erase = Effect.fn("Platform.erase")(function* (deletion: Model.ServerDeletion) {
      if (deletion.completedAt !== null) return;
      yield* servers.erase(deletion);
      yield* directory.finishDeletion(deletion.serverId, yield* now);
    });
    return Service.of({
      currentUser: (actor) => identity.user(actor.userId),
      getAccount: Effect.fn("Platform.getAccount")(function* (actor, id) {
        return accountContext((yield* account(actor, id)).value, actor);
      }),
      createAccount: Effect.fn("Platform.createAccount")(function* (actor, input) {
        const reservation = yield* directory.reserveAccount(actor, input, yield* now);
        const organizationId = yield* identity.createAccount(reservation);
        const membership = yield* member(organizationId, actor.userId);
        if (membership.status !== "active") return yield* denied();
        const value = yield* directory.completeAccount(reservation.id, organizationId);
        // The next membership check for this account can start with its account read.
        learn(value);
        return accountContext(value, actor);
      }),
      renameAccount: Effect.fn("Platform.renameAccount")(function* (actor, evidence, id, input) {
        if (!evidence.website) return yield* websiteOnly("an organization");
        const { value } = yield* account(actor, id);
        // The owner manages members and billing; the same person renames the organization.
        if (value.createdBy !== actor.userId)
          return yield* new Model.Failure({
            code: "forbidden",
            message: "Only the organization's owner can rename it.",
          });
        const target = { kind: "organization", id } as const;
        const renamed = yield* directory.rename(actor, target, input, yield* now);
        yield* syncName(target).pipe(
          Effect.mapError(
            () =>
              new Model.Failure({
                code: "identity_unavailable",
                message:
                  "The organization is renamed in TalkTo, but WorkOS has not confirmed it, so the sign-in page may still show the old name. TalkTo retries automatically; retrying is safe.",
              }),
          ),
        );
        return {
          account: accountContext({ ...value, name: renamed.current.name }, actor),
          changed: renamed.changed,
        };
      }),
      listAccounts: Effect.fn("Platform.listAccounts")(function* (actor, input) {
        const selection = yield* IdentityDirectory.selection(actor.userId, null, input);
        const page = yield* identity.memberships(actor.userId, selection.after, selection.limit);
        yield* directory.recordMemberships(page.items);
        return {
          items: (yield* directory.accounts(
            actor.userId,
            page.items.filter((m) => m.status === "active").map((m) => m.organizationId),
          ))
            .filter((value) => selection.matches(value.name))
            .map(({ serverCount, ...value }) => ({ ...accountContext(value, actor), serverCount })),
          nextCursor: selection.next(page.nextCursor),
        };
      }),
      listMembers: Effect.fn("Platform.listMembers")(function* (actor, id, input) {
        const { value } = yield* account(actor, id);
        const selection = yield* IdentityDirectory.selection(actor.userId, id, input);
        const page = yield* identity.members(
          value.organizationId,
          selection.after,
          selection.limit,
        );
        const items = yield* Effect.forEach(
          page.items,
          Effect.fn("Platform.memberContext")(function* (member) {
            return {
              ...member,
              user: yield* identity.user(member.userId),
              permissions: {
                remove: value.createdBy === actor.userId && member.userId !== value.createdBy,
              },
            };
          }),
          { concurrency: 5 },
        );
        return {
          items: items.filter((member) =>
            selection.matches(
              [member.user.email, member.user.firstName, member.user.lastName].join(" "),
            ),
          ),
          nextCursor: selection.next(page.nextCursor),
        };
      }),
      managedServers: Effect.fn("Platform.managedServers")(function* (actor, id, input) {
        yield* account(actor, id);
        return yield* directory.managedServers(actor.userId, id, input);
      }),
      managedServer: Effect.fn("Platform.managedServer")(function* (actor, accountId, id) {
        const { server, reader, owner } = yield* managedView(actor, accountId, id);
        // Only a reader sees the remote; management alone never reaches the server's files.
        const files = reader ? yield* servers.files(id) : null;
        return {
          ...publicServer(server),
          permissions: {
            readMessages: reader,
            manageAccess: owner,
            resume: owner && server.status === "provisioning",
          },
          files,
        };
      }),
      renameServer: Effect.fn("Platform.renameServer")(
        function* (actor, evidence, accountId, id, input) {
          if (!evidence.website) return yield* websiteOnly("a server");
          const { server, reader, owner } = yield* managedView(actor, accountId, id);
          // The people who see the server's Settings tab rename it; readers are told why not.
          if (!owner)
            return yield* new Model.Failure({
              code: "forbidden",
              message: "Only the person who manages this server can rename it.",
            });
          const target = { kind: "server", id } as const;
          const renamed = yield* directory.rename(actor, target, input, yield* now);
          yield* syncName(target).pipe(
            Effect.mapError(
              () =>
                new Model.Failure({
                  code: "storage_unavailable",
                  message:
                    "The server is renamed, but it has not yet confirmed its new name, so agents may still see the old one. TalkTo retries automatically; retrying is safe.",
                }),
            ),
          );
          return {
            server: {
              ...publicServer({ ...server, name: renamed.current.name }),
              permissions: {
                readMessages: reader,
                manageAccess: owner,
                resume: owner && server.status === "provisioning",
              },
            },
            changed: renamed.changed,
          };
        },
      ),
      serverRenames: Effect.fn("Platform.serverRenames")(function* (actor, accountId, id) {
        yield* managedView(actor, accountId, id);
        const records = yield* directory.serverRenames(id, P.maxServerRenames);
        const people = [
          ...new Set(
            records.flatMap((record) => (record.renamedBy === null ? [] : [record.renamedBy])),
          ),
        ];
        // A profile that cannot be read leaves its notices unattributed rather than failing them.
        const labels = new Map(
          yield* Effect.forEach(
            people,
            (userId) =>
              identity.user(userId).pipe(
                Effect.map((user) => [userId, personLabel(user)] as const),
                Effect.orElseSucceed(() => [userId, null] as const),
              ),
            { concurrency: 5 },
          ),
        );
        return {
          items: records.map(({ renamedBy, ...record }) => ({
            ...record,
            renamedBy: renamedBy === null ? null : (labels.get(renamedBy) ?? null),
          })),
        };
      }),
      deleteServer: Effect.fn("Platform.deleteServer")(function* (actor, accountId, id, input) {
        yield* account(actor, accountId);
        let deletion = yield* directory.deletion(id);
        if (deletion === null) {
          const server = yield* manage(actor, id);
          if (server.accountId !== accountId) return yield* denied();
          if (input.confirmation !== server.name)
            return yield* new Model.Failure({
              code: "invalid_input",
              message: "Enter the server name exactly to confirm deletion.",
            });
          deletion = yield* directory.beginDeletion(id, yield* now);
        }
        if (deletion.accountId !== accountId || deletion.createdBy !== actor.userId)
          return yield* denied();
        yield* erase(deletion);
        return { serverId: id, status: "deleted" };
      }),
      resumeServer: Effect.fn("Platform.resumeServer")(function* (actor, accountId, id) {
        const server = yield* manage(actor, id);
        if (server.accountId !== accountId) return yield* denied();
        const grant = yield* directory.grant(id, actor.userId);
        if (server.status === "provisioning") {
          if (grant === null || grant.revokedAt !== null) return yield* denied();
          yield* deliverCommand(grant);
        }
        return {
          ...publicServer(server),
          status: "ready",
          permissions: {
            readMessages:
              grant !== null &&
              grant.revokedAt === null &&
              (server.status === "provisioning" || grant.appliedRevision === grant.revision),
            manageAccess: true,
            resume: false,
          },
        };
      }),
      listInvitations: Effect.fn("Platform.listInvitations")(function* (actor, id, after) {
        const value = yield* manageAccount(actor, id);
        return yield* identity.invitations(value.organizationId, after);
      }),
      sendInvitation: Effect.fn("Platform.sendInvitation")(function* (actor, id, input) {
        const value = yield* manageAccount(actor, id);
        const at = yield* now;
        const standing = yield* directory.standing(value.id, at);
        const peopleLimit = People.limit(standing);
        const limitName = People.limitName(standing);
        // A repeat of a live invitation takes no new place; the provider reports the duplicate.
        const repeat =
          peopleLimit !== null &&
          (yield* identity.findInvitations(value.organizationId, input.email)).items.some(
            (existing) => People.holdsPlace(existing, at),
          );
        if (!repeat)
          yield* People.ensureRoom(
            identity,
            directory.guestPlaces,
            value.organizationId,
            at,
            peopleLimit,
            1,
            limitName,
          );
        yield* admit(actor, value, input.email, "send", at);
        const sent = yield* identity.invite(value.organizationId, actor.userId, input);
        if (peopleLimit === null) return sent;
        // Two concurrent sends can both pass the first count. Recount and withdraw this one.
        const people = yield* People.count(
          identity,
          directory.guestPlaces,
          value.organizationId,
          yield* now,
          peopleLimit,
        );
        if (people <= peopleLimit) return sent;
        yield* identity.cancel(sent.id);
        return yield* People.reached(people, peopleLimit, true, limitName);
      }),
      resendInvitation: Effect.fn("Platform.resendInvitation")(function* (actor, accountId, id) {
        const { account, invite: value } = yield* invitation(actor, accountId, id);
        if (value.state !== "pending")
          return yield* new Model.Failure({
            code: "invalid_input",
            message: "Only pending invitations can be resent.",
          });
        const at = yield* now;
        // An expired invitation no longer counts; renewing it takes a place again.
        if (!People.holdsPlace(value, at)) {
          const standing = yield* directory.standing(account.id, at);
          yield* People.ensureRoom(
            identity,
            directory.guestPlaces,
            account.organizationId,
            at,
            People.limit(standing),
            1,
            People.limitName(standing),
          );
        }
        yield* admit(actor, account, value.email, "resend", at);
        return yield* identity.resend(id);
      }),
      ensurePlanFits: Effect.fn("Platform.ensurePlanFits")(function* (actor, accountId, plan) {
        const value = yield* manageAccount(actor, accountId);
        const at = yield* now;
        if ((yield* directory.standing(value.id, at)).unlimited) return;
        yield* People.ensureRoom(
          identity,
          directory.guestPlaces,
          value.organizationId,
          at,
          plans[plan].peopleLimit,
          0,
        );
      }),
      cancelInvitation: Effect.fn("Platform.cancelInvitation")(function* (actor, accountId, id) {
        const { invite: value } = yield* invitation(actor, accountId, id);
        if (value.state === "revoked") return value;
        if (value.state !== "pending")
          return yield* new Model.Failure({
            code: "invalid_input",
            message: "Only pending invitations can be canceled.",
          });
        return yield* identity.cancel(id);
      }),
      removeMember: Effect.fn("Platform.removeMember")(function* (actor, accountId, userId) {
        const value = yield* manageAccount(actor, accountId);
        if (userId === value.createdBy)
          return yield* new Model.Failure({
            code: "invalid_input",
            message: "The organization creator cannot be removed.",
          });
        const membership = yield* identity.membership(value.organizationId, userId);
        if (membership === null) return yield* denied();
        const removed =
          membership.status === "inactive" || membership.status === "deleted"
            ? membership
            : yield* identity.deactivate(membership);
        yield* directory.removeMembership(removed, yield* now);
        const pending = yield* directory.pendingMembership(removed.id);
        yield* Effect.forEach(pending, deliverCommand, { concurrency: 5, discard: true });
        if ((yield* directory.pendingMembership(removed.id)).length > 0)
          return yield* new Model.Failure({
            code: "storage_unavailable",
            message:
              "Membership was removed; server revocations are still being delivered. Retry to confirm completion.",
          });
        return { userId, status: "removed" };
      }),
      createServer: Effect.fn("Platform.createServer")(function* (actor, id, input) {
        const { value, membership } = yield* account(actor, id);
        const server = yield* directory.reserveServer(actor, value, membership, input, yield* now);
        const grant = yield* directory.grant(server.id, actor.userId);
        if (grant === null) return yield* denied();
        // The reservation was just read, so delivery need not read the server again.
        yield* deliverTo(directory, servers, server, grant);
        return publicServer({ ...server, status: "ready" });
      }),
      discoverServers: (actor, after) => directory.discover(actor.userId, after),
      listGrants: Effect.fn("Platform.listGrants")(function* (actor, id, after) {
        yield* manage(actor, id);
        const page = yield* directory.grants(id, after);
        const items = yield* Effect.forEach(
          page.items,
          Effect.fn("Platform.grantContext")(function* (grant) {
            const user = yield* identity
              .user(grant.userId)
              .pipe(
                Effect.catch((error) =>
                  error.code === "not_found" ? Effect.succeed(null) : Effect.fail(error),
                ),
              );
            return { ...publicGrant(grant), user };
          }),
          { concurrency: 5 },
        );
        return { ...page, items };
      }),
      listGrantCandidates: Effect.fn("Platform.listGrantCandidates")(function* (actor, id, input) {
        const server = yield* manage(actor, id);
        const selection = yield* IdentityDirectory.selection(
          actor.userId,
          server.accountId,
          input,
          id,
        );
        const page = yield* identity.members(
          server.organizationId,
          selection.after,
          selection.limit,
        );
        const active = page.items.filter((member) => member.status === "active");
        // Existing records, including pending/revoked grants, have their own management row.
        const existing = new Set(
          yield* directory.existingGrantees(
            id,
            active.map((member) => member.userId),
          ),
        );
        const users = yield* Effect.forEach(
          active.filter((member) => !existing.has(member.userId)),
          (member) => identity.user(member.userId),
          { concurrency: 5 },
        );
        return {
          items: users.filter((user) =>
            selection.matches([user.email, user.firstName, user.lastName].join(" ")),
          ),
          nextCursor: selection.next(page.nextCursor),
        };
      }),
      grantAccess: Effect.fn("Platform.grantAccess")(function* (actor, id, userId) {
        const server = yield* manage(actor, id);
        const membership = yield* member(server.organizationId, userId);
        return yield* deliverCommand(yield* directory.allow(id, membership, yield* now));
      }),
      revokeAccess: Effect.fn("Platform.revokeAccess")(function* (actor, id, userId) {
        yield* manage(actor, id);
        return yield* deliverCommand(yield* directory.revoke(id, userId, yield* now));
      }),
      synchronize: Effect.fn("Platform.synchronize")(function* () {
        const synchronization = yield* Effect.gen(function* () {
          let position = yield* directory.syncPosition();
          // Bounded scheduled work. Persist after each event; an overlapping run cannot move the cursor backward.
          for (let page = 0; page < 5; page++) {
            const events = yield* identity.events(position.cursor, position.startedAt);
            for (const event of events) {
              yield* directory.consume(event, position.cursor, yield* now);
              position = { ...position, cursor: event.id };
            }
            if (events.length < 100) break;
          }
        }).pipe(Effect.result);
        const deletions = yield* Effect.forEach(
          yield* directory.pendingDeletions(),
          (deletion) => erase(deletion).pipe(Effect.result),
          { concurrency: 5 },
        );
        // Names WorkOS or a server object has not confirmed yet, each independently.
        const names = yield* Effect.forEach(
          yield* directory.pendingNames(),
          (target) => syncName(target).pipe(Effect.result),
          { concurrency: 5 },
        );
        const pending = yield* directory.pending();
        // Failure of one server must not prevent delivery to unrelated servers.
        const results = yield* Effect.forEach(
          pending,
          (command) => deliverCommand(command).pipe(Effect.result),
          { concurrency: 5 },
        );
        if (synchronization._tag === "Failure") return yield* synchronization.failure;
        if ([...results, ...deletions, ...names].some((result) => result._tag === "Failure"))
          return yield* new Model.Failure({
            code: "storage_unavailable",
            message: "Some access or name changes remain pending and will be retried.",
          });
      }),
    });
  }),
);
