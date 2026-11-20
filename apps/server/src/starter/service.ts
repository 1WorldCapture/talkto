import { Clock, Context, DateTime, Effect, Fiber, Layer } from "effect";
import * as S from "@talkto/api/starter";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as Metering from "../metering/model.js";
import * as Platform from "../platform/service.js";
import type * as Identity from "../platform/model.js";
import type * as Provisioning from "../platform/provisioning-policy.js";
import * as Model from "./model.js";
import * as Entitlements from "../account-entitlements.js";
import * as Inbox from "./inbox.js";
import * as Configuration from "./configuration.js";

type Failure = Model.Failure | Identity.Failure;
/** Free-start operations shared by the starter endpoints and onboarding; no MCP claiming surface. */
export class Service extends Context.Service<
  Service,
  {
    /** The caller's standing before any organization exists (the first-server form). */
    readonly eligibility: (
      actor: Identity.Actor,
      evidence: Model.Evidence,
    ) => Effect.Effect<S.State, Failure>;
    readonly state: (
      actor: Identity.Actor,
      accountId: P.AccountId,
      evidence: Model.Evidence,
    ) => Effect.Effect<S.State, Failure>;
    /** Reserve once, then create or resume the starter server and open its allowance. */
    readonly claim: (
      actor: Identity.Actor,
      accountId: P.AccountId,
      input: S.Claim,
      evidence: Model.Evidence,
    ) => Effect.Effect<S.Claimed, Failure>;
    /**
     * Create a server the way `route` chooses, through `claim` or the ordinary way, in one pass.
     * Returns only the server: the free start's state is not read.
     */
    readonly create: (
      actor: Identity.Actor,
      accountId: P.AccountId,
      input: S.Claim,
      evidence: Model.Evidence,
    ) => Effect.Effect<P.Server, Failure>;
    /**
     * How a first server should be created: through the free start, or the ordinary way (API
     * tokens, spent or inapplicable offers, admissions closed). Fails only for denials the person
     * can fix or wait out, so a form can keep their input.
     */
    readonly route: (
      actor: Identity.Actor,
      accountId: P.AccountId | null,
      evidence: Model.Evidence,
    ) => Effect.Effect<"starter" | "ordinary", Failure>;
  }
>()("@talkto/starter/Service") {}

const now = Clock.currentTimeMillis.pipe(
  Effect.map((ms) => M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(ms)))),
);
const publicServer = (server: P.ServerContext): P.Server => ({
  id: server.id,
  accountId: server.accountId,
  name: server.name,
  createdBy: server.createdBy,
  createdAt: server.createdAt,
  status: server.status,
});
type Evaluation =
  | { readonly status: Exclude<S.Status, "eligible">; readonly keys: null }
  | { readonly status: "eligible"; readonly keys: Model.Keys };
const refuse = (status: Exclude<S.Status, "eligible">): Evaluation => ({ status, keys: null });
/** The denial that explains a status; statuses that are not denials map to `otherwise`. */
const reason = (status: S.Status, otherwise: Model.Denied["reason"]): Model.Denied["reason"] => {
  switch (status) {
    case "unavailable":
    case "verify_email":
    case "sign_in_required":
    case "used":
    case "paused":
    case "server_limit":
    case "owner_only":
      return status;
    case "eligible":
    case "provisioning":
    case "active":
    case "exhausted":
    case "converted":
      return otherwise;
  }
};
/** A claim in progress finishes within one request; an unbound reservation older than this is stranded. */
const strandedAfter = { hours: 1 } as const;

/** Open the starter allowance once its server is ready; replays never reset counters. */
const publication = Effect.fn("Starter.operations")(function* () {
  const store = yield* Model.Store;
  const quotas = yield* Metering.Quotas;
  const unavailable = (operation: string) => () => Model.unavailable(operation);
  const publish = Effect.fn("Starter.publish")(function* (grant: Model.Grant) {
    if (grant.status !== "active" || grant.activatedAt === null || grant.publishedAt !== null)
      return;
    // A claim made while the Free plan was offered opens the Free plan; otherwise the free start.
    const accepted = yield* (
      grant.offerVersion === Configuration.freeOfferVersion
        ? quotas.publishFree(grant.accountId, grant.activatedAt)
        : quotas.publishStarter(grant.accountId, {
            start: grant.activatedAt,
            allowance: grant.allowance,
          })
    ).pipe(Effect.mapError(unavailable("metering.publish")));
    // Refused only when a paid period already exists (the free start is then moot) or messages are
    // not counted here; the latter must not be recorded as opened.
    if (!accepted && !(yield* store.standing(grant.accountId)).paid)
      return yield* Model.unavailable("metering.publish");
    yield* store.published(grant.id, yield* now);
    yield* Effect.logInfo("Free start opened", { grantId: grant.id, accepted });
  });
  return { store, quotas, publish, unavailable };
});

/**
 * Scheduled repair. A stranded reservation (its claim was interrupted or its server refused) is
 * bound to the server its request key created, or released so the person can claim again. Then
 * publication that a claim began but could not complete is finished.
 */
export const synchronize = Effect.fn("Starter.synchronize")(function* (
  configuration: Configuration.Configuration,
) {
  const { store, publish } = yield* publication();
  const before = DateTime.subtract(DateTime.makeUnsafe(yield* now), strandedAfter);
  const stranded = yield* store.stranded(M.Timestamp.make(DateTime.formatIso(before)));
  const settled = yield* Effect.forEach(
    stranded,
    Effect.fn("Starter.settle")(function* (grant) {
      const outcome = (yield* store.settle(grant.id)) === null ? "released" : "bound";
      yield* Effect.logInfo("Free start reservation settled", { grantId: grant.id, outcome });
    }),
    { concurrency: 3, discard: true },
  ).pipe(Effect.result);
  const pending = yield* store.unpublished();
  const outcomes = yield* Effect.forEach(
    pending,
    Effect.fn("Starter.repair")(function* (grant) {
      const active =
        grant.status === "active" ? grant : yield* store.activate(grant.id, yield* now);
      yield* publish(active);
    }),
    { concurrency: 3, discard: false },
  ).pipe(Effect.result);
  const cutoff = DateTime.subtract(DateTime.makeUnsafe(yield* now), {
    days: configuration.observationDays,
  });
  yield* store.forget(M.Timestamp.make(DateTime.formatIso(cutoff)));
  if (settled._tag === "Failure") return yield* settled.failure;
  if (outcomes._tag === "Failure") return yield* outcomes.failure;
});

/**
 * Compose the free start from the platform's existing creation and access rules. `servers` is the
 * platform's server creation policy; null (missing settings) means no server can be created now.
 */
export const layer = (
  configuration: Configuration.Configuration,
  servers: Provisioning.Configuration | null,
) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { store, quotas, publish, unavailable } = yield* publication();
      const platform = yield* Platform.Service;
      const meters = yield* Model.Meters;
      const assessment = yield* Model.Assessment;
      const { admissions, namespace } = configuration;
      // While the Free plan is on, a claim opens it instead of the free start.
      const offer = admissions === null || configuration.free ? null : Model.offer;
      /** A state names the Free plan wherever a claim would open it. */
      const shown = (state: S.State): S.State =>
        admissions !== null && configuration.free ? { ...state, free: Model.freeOffer } : state;

      const keys = Effect.fn("Starter.keys")(function* (
        secret: NonNullable<typeof admissions>["secret"],
        user: P.User,
        account: P.Account | null,
      ) {
        const legacy = admissions?.legacy ?? null;
        const purpose = `starter-inbox:v1:${namespace}`;
        const inbox = Inbox.canonical(user.email);
        const previous = Inbox.previous(user.email);
        return {
          owner: user.id,
          inbox: yield* Inbox.key(secret, purpose, inbox),
          previousInbox: previous === inbox ? null : yield* Inbox.key(secret, purpose, previous),
          trialEmail:
            legacy === null
              ? null
              : yield* Inbox.key(legacy.secret, legacy.scope, `email:${inbox}`),
          legacyEmail:
            legacy === null
              ? null
              : yield* Inbox.key(
                  legacy.secret,
                  legacy.scope,
                  `email:${user.email.trim().toLowerCase()}`,
                ),
          organization: account?.organizationId ?? null,
          account: account?.id ?? null,
        } satisfies Model.Keys;
      });
      /**
       * The starter server is the owner's one server without a plan, under the platform's ordinary
       * limits: the claim is offered only when that server can be created now.
       */
      const room = Effect.fn("Starter.room")(function* (owner: P.UserId) {
        // A self-hosted copy makes every organization unlimited, and unlimited ones get no free start.
        if (servers === null || servers.unlimitedAccounts === "all") return "paused" as const;
        const counts = yield* store.capacity(owner, yield* now, servers.unlimitedAccounts);
        if (counts.owned >= servers.unpaidServers) return "server_limit" as const;
        if (counts.recent >= servers.serversPerHour || counts.today >= servers.unpaidServersPerDay)
          return "paused" as const;
        return null;
      });
      /** The person's own reads for `evaluate`, started together; the claim keys need the user. */
      const personal = Effect.fn("Starter.personal")(function* (
        actor: Identity.Actor,
        account: P.Account | null,
        settings: NonNullable<typeof admissions>,
      ) {
        const user = yield* Effect.forkChild(platform.currentUser(actor));
        // Null for an unverified person, who is refused before the keys are needed.
        const claim = yield* Effect.forkChild(
          Effect.gen(function* () {
            const value = yield* Fiber.join(user);
            if (!value.emailVerified) return null;
            const claimed = yield* keys(settings.secret, value, account);
            return { keys: claimed, spent: yield* store.spent(namespace, claimed) };
          }),
        );
        const limit = yield* Effect.forkChild(
          Fiber.join(user).pipe(Effect.flatMap((value) => room(account?.createdBy ?? value.id))),
        );
        const admitted = yield* Effect.forkChild(
          Effect.flatMap(now, (at) => store.admitted(settings.cohort, at.slice(0, 10))),
        );
        return { claim, room: limit, admitted };
      });
      /**
       * Cheap local checks for a new claim, in the order a person can act on them. The reads start
       * together and each check waits only for its own read, so the outcome, and any failure, is
       * the same as reading one at a time.
       */
      const evaluate = Effect.fn("Starter.evaluate")(function* (
        actor: Identity.Actor,
        evidence: Model.Evidence,
        account: P.Account | null,
      ) {
        if (admissions === null) return refuse("unavailable");
        if (account !== null && Entitlements.covers(configuration.unlimitedAccounts, account.id))
          return refuse("unavailable");
        const organization =
          account === null
            ? null
            : {
                usage: yield* quotas
                  .read(account.id)
                  .pipe(Effect.mapError(unavailable("metering.read")), Effect.forkChild),
                facts: yield* Effect.forkChild(store.standing(account.id)),
              };
        const person = evidence.website ? yield* personal(actor, account, admissions) : null;
        // A new organization, or one without a server, needs a new server without a plan.
        let needsServer = true;
        if (account !== null && organization !== null) {
          const usage = yield* Fiber.join(organization.usage);
          // Counted messages are required, and the authority must never have held a period.
          if (usage.status === "unmetered" || usage.periodStart !== null)
            return refuse("unavailable");
          const facts = yield* Fiber.join(organization.facts);
          if (facts.paid || facts.servers.length > 1) return refuse("unavailable");
          if (facts.servers.some((server) => server.createdBy !== account.createdBy))
            return refuse("unavailable");
          if (facts.trial) return refuse("used");
          needsServer = facts.servers.length === 0;
        }
        if (person === null) return refuse("sign_in_required");
        const claim = yield* Fiber.join(person.claim);
        if (claim === null) return refuse("verify_email");
        if (claim.spent) return refuse("used");
        if (needsServer) {
          const limited = yield* Fiber.join(person.room);
          if (limited !== null) return refuse(limited);
        }
        const counts = yield* Fiber.join(person.admitted);
        if (counts.today >= admissions.dailyLimit || counts.total >= admissions.cohortLimit)
          return refuse("paused");
        return { status: "eligible", keys: claim.keys } satisfies Evaluation;
      });
      /** Exact count: reported usage plus what live servers have committed but not reported. */
      const grantState = Effect.fn("Starter.grantState")(function* (grant: Model.Grant) {
        // Reading the Free month first moves a free start in use to Free while the switch is on.
        const month = yield* quotas
          .readFree(grant.accountId)
          .pipe(Effect.mapError(unavailable("metering.read")));
        if (month !== null) return yield* freeState(grant, month);
        const period = yield* quotas
          .readStarter(grant.accountId)
          .pipe(Effect.mapError(unavailable("metering.read")));
        const facts = yield* store.standing(grant.accountId);
        // Share-link messages (docs/share-links-spec.md) belong to the same free allowance.
        const allowance = grant.allowance + (period?.bonus ?? 0);
        const view = (status: S.Status, used: number): Pick<S.State, "status" | "grant"> => ({
          status,
          grant: {
            serverId: grant.serverId,
            activatedAt: grant.activatedAt,
            allowance,
            used,
            remaining: Math.max(0, allowance - used),
          },
        });
        if (period === null) return view(facts.paid ? "converted" : "provisioning", 0);
        const fundable = period.allowance + (period.bonus ?? 0);
        const held = period.reserved - period.used;
        const live = facts.servers.filter((s) => s.status === "ready").map((s) => s.id);
        const local = held === 0 ? 0 : yield* meters.unreported(live, period.start);
        const used = Math.min(fundable, period.used + Math.min(held, local ?? held));
        return view(
          period.end !== null ? "converted" : used >= fundable ? "exhausted" : "active",
          used,
        );
      });
      /** This Free month's exact count, the same way as the free start's. */
      const freeState = Effect.fn("Starter.freeState")(function* (
        grant: Model.Grant,
        month: Metering.FreePeriod,
      ) {
        const facts = yield* store.standing(grant.accountId);
        const held = month.reserved - month.used;
        const live = facts.servers.filter((s) => s.status === "ready").map((s) => s.id);
        const local = held === 0 ? 0 : yield* meters.unreported(live, month.start);
        const allowance = month.allowance + (month.bonus ?? 0);
        const used = Math.min(allowance, month.used + Math.min(held, local ?? held));
        const status: S.Status = month.retired
          ? "converted"
          : used >= allowance
            ? "exhausted"
            : "active";
        return {
          status,
          grant: {
            serverId: grant.serverId,
            activatedAt: grant.activatedAt,
            allowance,
            used,
            remaining: Math.max(0, allowance - used),
            renewsAt: month.end,
          },
          free: Model.freeOffer,
        } satisfies Pick<S.State, "status" | "grant" | "free">;
      });
      /** An owner whose verified email changed keeps the new inbox spent as well. */
      const remember = Effect.fn("Starter.remember")(function* (
        actor: Identity.Actor,
        grant: Model.Grant,
      ) {
        if (admissions === null || grant.ownerId !== actor.userId) return;
        const user = yield* platform.currentUser(actor);
        if (!user.emailVerified) return;
        const claim = yield* keys(admissions.secret, user, null);
        yield* store.remember(namespace, grant.id, claim.inbox, yield* now);
      });
      const provision = Effect.fn("Starter.provision")(function* (
        actor: Identity.Actor,
        accountId: P.AccountId,
        grant: Model.Grant,
        input: S.Claim,
      ) {
        if (grant.serverId !== null) {
          const bound = yield* platform.managedServer(actor, accountId, grant.serverId).pipe(
            Effect.catchIf(
              (error) => error.code === "not_found",
              () => Effect.succeed(null),
            ),
          );
          if (bound !== null)
            return bound.status === "provisioning"
              ? publicServer(yield* platform.resumeServer(actor, accountId, bound.id))
              : publicServer(bound);
          // The starter server was deleted: a replacement uses the organization's remaining credit.
          return yield* platform.createServer(actor, accountId, input);
        }
        // An interrupted earlier setup already made this owner's first server: bind it, never a second.
        const facts = yield* store.standing(accountId);
        const existing = facts.servers[0];
        if (facts.servers.length === 1 && existing?.createdBy === actor.userId)
          return existing.status === "provisioning"
            ? publicServer(yield* platform.resumeServer(actor, accountId, existing.id))
            : publicServer(yield* platform.managedServer(actor, accountId, existing.id));
        return yield* platform.createServer(actor, accountId, {
          name: grant.serverName,
          requestKey: grant.requestKey,
        });
      });
      /**
       * The first server could not be made, so the free start must not count as used: settle the
       * reservation (bind a server its request key did create, else release it). If storage fails
       * here, the scheduled repair settles it later. A refused creation is explained as the
       * starter status that applies now.
       */
      const abandon = Effect.fn("Starter.abandon")(function* (
        actor: Identity.Actor,
        evidence: Model.Evidence,
        account: P.Account,
        grant: Model.Grant,
        error: Failure,
      ): Effect.fn.Return<never, Failure> {
        const settled = yield* store.settle(grant.id).pipe(Effect.option);
        if (settled._tag === "None" || settled.value !== null) return yield* Effect.fail(error);
        yield* Effect.logInfo("Free start reservation released", { grantId: grant.id });
        if (error._tag !== "PlatformFailure" || error.code !== "forbidden")
          return yield* Effect.fail(error);
        const { status } = yield* evaluate(actor, evidence, account);
        return yield* Model.denied(reason(status, "paused"));
      });
      const contextFor = Effect.fn("Starter.account")(function* (
        actor: Identity.Actor,
        accountId: P.AccountId,
      ) {
        const { permissions: _, ...account } = yield* platform.getAccount(actor, accountId);
        return account;
      });

      /**
       * Reserve once, then create or resume the starter server and open its allowance. `found` is
       * the organization's grant, read with `account`; `evaluated` is a check this request already
       * made for this organization, so a claim right after it does not repeat its reads.
       */
      const open = Effect.fn("Starter.open")(function* (
        actor: Identity.Actor,
        account: P.Account,
        found: Model.Grant | null,
        input: S.Claim,
        evidence: Model.Evidence,
        evaluated: Evaluation | null,
      ) {
        const accountId = account.id;
        let grant = found;
        if (grant === null) {
          if (account.createdBy !== actor.userId) return yield* Model.denied("owner_only");
          const result = evaluated ?? (yield* evaluate(actor, evidence, account));
          if (result.status !== "eligible" || admissions === null)
            return yield* Model.denied(reason(result.status, "unavailable"));
          if ((yield* assessment.assess({ accountId, ownerId: actor.userId })) === "deny")
            return yield* Model.denied("unavailable");
          const at = yield* now;
          const admission = yield* store.reserve({
            grantId: crypto.randomUUID(),
            namespace,
            cohort: admissions.cohort,
            offerVersion: configuration.free
              ? Configuration.freeOfferVersion
              : Configuration.offerVersion,
            account,
            keys: result.keys,
            requestKey: input.requestKey,
            serverName: input.name,
            allowance: Model.offer.messages,
            at,
            dailyLimit: admissions.dailyLimit,
            cohortLimit: admissions.cohortLimit,
            networkKey:
              evidence.network === null
                ? null
                : yield* Inbox.key(
                    admissions.secret,
                    `starter-network:v1:${namespace}`,
                    Inbox.network(evidence.network),
                  ),
          });
          yield* Effect.logInfo("Free start admission", { outcome: admission.kind });
          switch (admission.kind) {
            case "spent":
              return yield* Model.denied("used");
            case "full":
              return yield* Model.denied("paused");
            case "ineligible":
              return yield* Model.denied("unavailable");
            case "reserved":
            case "resumed":
              grant = admission.grant;
          }
        }
        if (grant.ownerId !== actor.userId) return yield* Model.denied("owner_only");
        const reservation = grant;
        const server = yield* provision(actor, accountId, reservation, input).pipe(
          Effect.catch((error) =>
            reservation.serverId === null
              ? abandon(actor, evidence, account, reservation, error)
              : Effect.fail(error),
          ),
        );
        if (grant.serverId === null) grant = yield* store.bind(grant.id, server.id);
        if (server.status === "ready" && grant.status === "reserved")
          grant = yield* store.activate(grant.id, yield* now);
        yield* publish(grant);
        return { server, grant };
      });
      return Service.of({
        eligibility: Effect.fn("Starter.eligibility")(function* (actor, evidence) {
          const result = yield* evaluate(actor, evidence, null);
          return shown({ offer, status: result.status, grant: null, asOf: yield* now });
        }),
        state: Effect.fn("Starter.state")(function* (actor, accountId, evidence) {
          // The grant read starts with the membership check; nothing is used until it passes.
          const [account, grant] = yield* Effect.all(
            [contextFor(actor, accountId), store.grant(accountId)],
            { concurrency: 2 },
          );
          if (grant !== null) {
            yield* remember(actor, grant);
            return shown({ offer, ...(yield* grantState(grant)), asOf: yield* now });
          }
          const status =
            admissions !== null && account.createdBy !== actor.userId
              ? "owner_only"
              : (yield* evaluate(actor, evidence, account)).status;
          return shown({ offer, status, grant: null, asOf: yield* now });
        }),
        route: Effect.fn("Starter.route")(function* (actor, accountId, evidence) {
          if (accountId !== null && (yield* store.grant(accountId)) !== null) return "starter";
          if (admissions === null || !evidence.website) return "ordinary";
          const account = accountId === null ? null : yield* contextFor(actor, accountId);
          if (account !== null && account.createdBy !== actor.userId) return "ordinary";
          const { status } = yield* evaluate(actor, evidence, account);
          if (status === "eligible") return "starter";
          if (status === "verify_email" || status === "paused" || status === "server_limit")
            return yield* Model.denied(status);
          return "ordinary";
        }),
        claim: Effect.fn("Starter.claim")(function* (actor, accountId, input, evidence) {
          // The grant read starts with the membership check; nothing is used until it passes.
          const [account, found] = yield* Effect.all(
            [contextFor(actor, accountId), store.grant(accountId)],
            { concurrency: 2 },
          );
          const { server, grant } = yield* open(actor, account, found, input, evidence, null);
          const current = (yield* store.grant(accountId)) ?? grant;
          return {
            server,
            state: shown({ offer, ...(yield* grantState(current)), asOf: yield* now }),
          };
        }),
        create: Effect.fn("Starter.create")(function* (actor, accountId, input, evidence) {
          // `route` and `claim` in one pass, sharing their membership check, grant read and
          // evaluation. The grant read starts with the membership check; nothing is used until
          // it passes.
          const [account, found] = yield* Effect.all(
            [contextFor(actor, accountId), store.grant(accountId)],
            { concurrency: 2 },
          );
          if (found !== null)
            return (yield* open(actor, account, found, input, evidence, null)).server;
          if (admissions === null || !evidence.website || account.createdBy !== actor.userId)
            return yield* platform.createServer(actor, accountId, input);
          const evaluation = yield* evaluate(actor, evidence, account);
          if (evaluation.status === "eligible")
            return (yield* open(actor, account, null, input, evidence, evaluation)).server;
          if (
            evaluation.status === "verify_email" ||
            evaluation.status === "paused" ||
            evaluation.status === "server_limit"
          )
            return yield* Model.denied(evaluation.status);
          return yield* platform.createServer(actor, accountId, input);
        }),
      });
    }),
  );
