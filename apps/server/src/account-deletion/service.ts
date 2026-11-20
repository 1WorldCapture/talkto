import { Clock, Context, DateTime, Effect, Layer, Schema } from "effect";
import type * as A from "@talkto/api/account";
import * as B from "@talkto/api/billing";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as Model from "../platform/model.js";
import * as Platform from "../platform/service.js";

type Operation<A> = Effect.Effect<A, Model.Failure>;

/** The durable intent; `userDeletedAt` marks the step after which the person cannot sign in. */
export const Deletion = Schema.Struct({
  userId: P.UserId,
  requestedAt: M.Timestamp,
  userDeletedAt: Schema.NullOr(M.Timestamp),
  completedAt: Schema.NullOr(M.Timestamp),
});
/** Parsed deletion intent. */
export interface Deletion extends Schema.Schema.Type<typeof Deletion> {}
/** An organization the person created, as the directory records it. */
export const Owned = Schema.Struct({
  id: P.AccountId,
  organizationId: Schema.NullOr(P.OrganizationId),
  name: M.ServerName,
  servers: M.Count,
  plan: Schema.NullOr(B.Plan),
});
/** Parsed owned organization. */
export interface Owned extends Schema.Schema.Type<typeof Owned> {}

/** A server the person created in an organization someone else owns, not marked for deletion. */
export const Created = Schema.Struct({
  serverId: M.ServerId,
  name: M.ServerName,
  accountId: P.AccountId,
  organizationId: Schema.NullOr(P.OrganizationId),
  organization: M.ServerName,
});
/** Parsed server created in another organization. */
export interface Created extends Schema.Schema.Type<typeof Created> {}

/** Organizations with other members cannot be deleted with their owner; nothing was changed. */
export class Blocked extends Schema.TaggedError<Blocked>()("AccountDeletionBlocked", {
  message: Schema.String,
  organizations: Schema.Array(Schema.Struct({ accountId: P.AccountId, name: M.ServerName })),
}) {}

/** D1 persistence for the intent and the person's own rows; server erasure stays in Directory. */
export class Store extends Context.Service<
  Store,
  {
    readonly deletion: (userId: P.UserId) => Operation<Deletion | null>;
    /** Organizations the person created that are not yet marked for deletion. */
    readonly owned: (userId: P.UserId) => Operation<ReadonlyArray<Owned>>;
    /** Servers the person created in organizations they do not own; they stay on deletion. */
    readonly created: (userId: P.UserId) => Operation<ReadonlyArray<Created>>;
    /**
     * Record the intent, mark the listed organizations and their servers for deletion, revoke
     * every access grant of the person and mark their memberships deleted, in one batch.
     */
    readonly begin: (
      userId: P.UserId,
      accounts: ReadonlyArray<P.AccountId>,
      at: M.Timestamp,
    ) => Operation<void>;
    readonly userDeleted: (userId: P.UserId, at: M.Timestamp) => Operation<void>;
    /** Organizations marked for deletion with this person whose tombstone is not yet final. */
    readonly deleting: (userId: P.UserId) => Operation<ReadonlyArray<Model.AccountTombstone>>;
    /** Servers of the organization not yet erased, including any created since the intent. */
    readonly servers: (accountId: P.AccountId) => Operation<ReadonlyArray<M.ServerId>>;
    /** Remove the organization's memberships and scrub its name once every server is erased. */
    readonly finishOrganization: (accountId: P.AccountId, at: M.Timestamp) => Operation<void>;
    /** Revocations of the person's access to surviving servers not yet confirmed by the server. */
    readonly pendingAccess: (userId: P.UserId) => Operation<ReadonlyArray<Model.AccessCommand>>;
    /**
     * Remove the person's remaining rows, hand management of servers they created in other
     * organizations to each organization's owner, and mark the deletion complete. Changes
     * nothing while a revocation or an organization is unfinished; returns whether it completed.
     */
    readonly finish: (userId: P.UserId, at: M.Timestamp) => Operation<boolean>;
    /** Intents the scheduled sync resumes, oldest first. */
    readonly pending: () => Operation<ReadonlyArray<P.UserId>>;
  }
>()("@talkto/account-deletion/Store") {}

/** Billing boundary: end an organization's paid plan at once. Repeating it is safe. */
export class Subscriptions extends Context.Service<
  Subscriptions,
  { readonly close: (accountId: P.AccountId) => Operation<void> }
>()("@talkto/account-deletion/Subscriptions") {}

/** Human-only account deletion. HTTP adapters supply website evidence; MCP has no route here. */
export class Service extends Context.Service<
  Service,
  {
    readonly plan: (actor: Model.Actor, evidence: Model.Evidence) => Operation<A.DeletionPlan>;
    readonly delete: (
      actor: Model.Actor,
      evidence: Model.Evidence,
      input: A.DeleteAccount,
    ) => Effect.Effect<A.DeletedAccount, Model.Failure | Blocked>;
    /** Scheduled completion of interrupted deletions; bounded per run. */
    readonly resume: () => Operation<void>;
  }
>()("@talkto/account-deletion/Service") {}

const now = Clock.currentTimeMillis.pipe(
  Effect.map((ms) => M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(ms)))),
);
const normalized = (email: string) => email.trim().toLowerCase();
const website = () =>
  new Model.Failure({
    code: "forbidden",
    message: "Delete your account on the TalkTo website while signed in. API tokens cannot.",
  });
const unfinished = () =>
  new Model.Failure({
    code: "storage_unavailable",
    message: "Account deletion is still finishing. It continues automatically.",
  });
const tolerateMissing = <A>(fallback: A) =>
  Effect.catch((error: Model.Failure) =>
    error.code === "not_found" ? Effect.succeed(fallback) : Effect.fail(error),
  );

/** Account deletion over the platform directory, identity provider, servers and billing. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* Store;
    const subscriptions = yield* Subscriptions;
    const identity = yield* Platform.Identity;
    const directory = yield* Platform.Directory;
    const servers = yield* Platform.Servers;

    /** Every owned organization with its other active members, read from the provider now. */
    const survey = Effect.fn("AccountDeletion.survey")(function* (userId: P.UserId) {
      const owned = yield* store.owned(userId);
      return yield* Effect.forEach(
        owned,
        Effect.fn("AccountDeletion.organization")(function* (account) {
          const others =
            account.organizationId === null
              ? 0
              : (yield* identity.members(account.organizationId, undefined, 100)).items.filter(
                  (member) => member.userId !== userId,
                ).length;
          return {
            accountId: account.id,
            name: account.name,
            servers: account.servers,
            otherMembers: M.Count.make(others),
            plan: account.plan,
          };
        }),
        { concurrency: 5 },
      );
    });
    const deleteUser = Effect.fn("AccountDeletion.deleteUser")(function* (deletion: Deletion) {
      if (deletion.userDeletedAt !== null) return;
      yield* identity.deleteUser(deletion.userId);
      yield* store.userDeleted(deletion.userId, yield* now);
    });
    const revokeInvitations = Effect.fn("AccountDeletion.revokeInvitations")(function* (
      organizationId: P.OrganizationId,
    ) {
      let after: string | undefined;
      for (let page = 0; page < 20; page++) {
        const invitations = yield* identity
          .invitations(organizationId, after)
          .pipe(tolerateMissing<P.Page<P.Invitation>>({ items: [], nextCursor: null }));
        yield* Effect.forEach(
          invitations.items.filter((invite) => invite.state === "pending"),
          (invite) => identity.cancel(invite.id).pipe(tolerateMissing(invite)),
          { concurrency: 5, discard: true },
        );
        if (invitations.nextCursor === null) return;
        after = invitations.nextCursor;
      }
      return yield* unfinished();
    });
    /** Billing first, so nothing is charged for an organization that no longer exists. */
    const deleteOrganization = Effect.fn("AccountDeletion.deleteOrganization")(function* (
      account: Model.AccountTombstone,
    ) {
      yield* subscriptions.close(account.id);
      for (const id of yield* store.servers(account.id)) {
        const deletion = yield* directory.beginDeletion(id, yield* now);
        if (deletion.completedAt !== null) continue;
        yield* servers.erase(deletion);
        yield* directory.finishDeletion(id, yield* now);
      }
      if (account.organizationId !== null) yield* revokeInvitations(account.organizationId);
      yield* identity.deleteOrganization(account);
      yield* store.finishOrganization(account.id, yield* now);
    });
    /** Everything after sign-in has ended. Each step is idempotent and safe to repeat. */
    const finish = Effect.fn("AccountDeletion.finish")(function* (userId: P.UserId) {
      for (const account of yield* store.deleting(userId)) yield* deleteOrganization(account);
      // Servers in other organizations stop admitting the person's agents once they apply this.
      yield* Effect.forEach(
        yield* store.pendingAccess(userId),
        Effect.fn("AccountDeletion.revoke")(function* (command) {
          yield* servers.apply(command);
          // Their own participant stays with its messages under a neutral name.
          yield* servers.forgetPerson(command);
          yield* directory.applied(command);
        }),
        { concurrency: 5, discard: true },
      );
      if (!(yield* store.finish(userId, yield* now))) return yield* unfinished();
    });
    const advance = Effect.fn("AccountDeletion.advance")(function* (userId: P.UserId) {
      const deletion = yield* store.deletion(userId);
      if (deletion === null || deletion.completedAt !== null) return;
      yield* deleteUser(deletion);
      yield* finish(userId);
    });

    return Service.of({
      plan: Effect.fn("AccountDeletion.plan")(function* (actor, evidence) {
        const user = yield* identity.user(actor.userId);
        const deletion = yield* store.deletion(actor.userId);
        const owned = deletion === null ? yield* survey(actor.userId) : [];
        const ownedOrganizations = new Set(
          (yield* store.owned(actor.userId)).flatMap((account) =>
            account.organizationId === null ? [] : [account.organizationId],
          ),
        );
        const others = new Set(
          (yield* identity.memberships(actor.userId, undefined, 100)).items
            .filter((member) => member.status === "active")
            .filter((member) => !ownedOrganizations.has(member.organizationId))
            .map((member) => member.organizationId),
        );
        // Only servers the person can still manage, so each one links to a working delete.
        const created =
          deletion === null
            ? (yield* store.created(actor.userId)).filter(
                (server) => server.organizationId !== null && others.has(server.organizationId),
              )
            : [];
        const blocked = owned.filter((account) => account.otherMembers > 0);
        return {
          email: user.email,
          status: deletion !== null ? "in_progress" : blocked.length > 0 ? "blocked" : "ready",
          deleted: owned.filter((account) => account.otherMembers === 0),
          blocked,
          memberships: M.Count.make(others.size),
          servers: created.map(({ serverId, name, accountId, organization }) => ({
            serverId,
            name,
            accountId,
            organization,
          })),
          website: evidence.website,
        };
      }),
      delete: Effect.fn("AccountDeletion.delete")(function* (actor, evidence, input) {
        if (!evidence.website) return yield* website();
        let deletion = yield* store.deletion(actor.userId);
        if (deletion === null) {
          const user = yield* identity.user(actor.userId);
          if (normalized(input.confirmation) !== normalized(user.email))
            return yield* new Model.Failure({
              code: "invalid_input",
              message: "Type your account email exactly to confirm deletion.",
            });
          const owned = yield* survey(actor.userId);
          const blocked = owned.filter((account) => account.otherMembers > 0);
          if (blocked.length > 0)
            return yield* new Blocked({
              message: `${blocked.map((account) => account.name).join(", ")} ${blocked.length === 1 ? "has" : "have"} other members. Ownership cannot be transferred yet: remove the other members first, then delete your account.`,
              organizations: blocked.map(({ accountId, name }) => ({ accountId, name })),
            });
          yield* store.begin(
            actor.userId,
            owned.map((account) => account.accountId),
            yield* now,
          );
          deletion = yield* store.deletion(actor.userId);
          if (deletion === null) return yield* unfinished();
        }
        if (deletion.completedAt !== null) return { status: "deleted" as const };
        // Until this succeeds nothing has been erased, and the person can retry while signed in.
        yield* deleteUser(deletion);
        const rest = yield* finish(actor.userId).pipe(Effect.result);
        if (rest._tag === "Success") return { status: "deleted" as const };
        yield* Effect.logWarning("Account deletion continues in the scheduled sync", {
          code: rest.failure.code,
        });
        return { status: "finishing" as const };
      }),
      resume: Effect.fn("AccountDeletion.resume")(function* () {
        const results = yield* Effect.forEach(
          yield* store.pending(),
          (userId) => advance(userId).pipe(Effect.result),
          { concurrency: 2 },
        );
        if (results.some((result) => result._tag === "Failure")) return yield* unfinished();
      }),
    });
  }),
);
