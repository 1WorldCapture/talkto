import { Clock, Context, DateTime, Effect, Layer } from "effect";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as Share from "@talkto/api/share";
import { share } from "@talkto/api/pricing";
import * as Platform from "../platform/service.js";
import * as Identity from "../platform/model.js";
import * as Domains from "./domains.js";
import * as Model from "./model.js";

/*
  Share-link operations (docs/share-links-spec.md), shared by the HTTP API and the minute cron.
  People only: there is no MCP surface.
*/

type Failure = Model.Unavailable | Identity.Failure;
/** The application service behind `/v1/accounts/:accountId/share`. */
export class Service extends Context.Service<
  Service,
  {
    /** The organization's share state; any member may read it, only the owner sees the link. */
    readonly state: (
      actor: Identity.Actor,
      accountId: P.AccountId,
    ) => Effect.Effect<Share.State, Failure>;
    /** Create (or return) the owner's link. */
    readonly link: (
      actor: Identity.Actor,
      accountId: P.AccountId,
    ) => Effect.Effect<Share.State, Failure>;
    /** Attach the caller's new organization to a link. Refusals are answers, not failures. */
    readonly join: (
      actor: Identity.Actor,
      accountId: P.AccountId,
      input: Share.Join,
    ) => Effect.Effect<Share.Joined, Failure>;
  }
>()("@talkto/share/Service") {}

const now = Clock.currentTimeMillis.pipe(Effect.map(iso));
function iso(ms: number) {
  return M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(ms)));
}
const later = (at: M.Timestamp, duration: Partial<DateTime.DateTime.PartsForMath>) =>
  M.Timestamp.make(DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(at), duration)));
const earlier = (at: M.Timestamp, duration: Partial<DateTime.DateTime.PartsForMath>) =>
  M.Timestamp.make(DateTime.formatIso(DateTime.subtract(DateTime.makeUnsafe(at), duration)));
/** How often a waiting referral is checked, and how soon after a failed check. */
const checkEvery = { hours: 6 } as const;
const retryAfter = { hours: 1 } as const;
/** A `joined` bonus whose organization never opened a free allowance stops waiting after this. */
const periodWait = { days: 1 } as const;
/** The owner's list shows at most this many sign-ups, newest first. */
const listLimit = 50;

/** What both people get, from the shared pricing facts. */
export const offer: Share.Offer = {
  messages: share.messages,
  qualifyingMessages: share.qualifyingMessages,
  qualifyingDays: share.qualifyingDays,
  windowDays: share.windowDays,
  sharerLimit: share.sharerLimit,
};
/** A new code: 16 random bytes in base64url (22 characters). It names nobody. */
const newCode = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const text = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return Share.Code.make(text);
};
/** The bonus's ID at the quota authority: one per referral and side. */
export const bonusId = (bonus: Pick<Model.Bonus, "referralId" | "side">) =>
  `share:${bonus.referralId}:${bonus.side}`;
/** Whether a join passed the checks that need nothing written. */
type Admission =
  | { readonly kind: "refused"; readonly reason: Share.JoinRefusal }
  | { readonly kind: "admitted"; readonly newness: Model.Newness };
const forbidden = (message: string) => new Identity.Failure({ code: "forbidden", message });

/**
 * Add one pending bonus to its organization's free allowance and record the outcome. Retries are
 * safe: the quota authority answers a known bonus ID with its first outcome.
 */
const apply = Effect.fn("Share.apply")(function* (bonus: Model.Bonus) {
  const store = yield* Model.Store;
  const allowances = yield* Model.Allowances;
  const outcome = yield* allowances.add(bonus.accountId, bonusId(bonus));
  const at = yield* now;
  if (outcome === "no_period") {
    // The organization has not opened its free allowance yet; give up after a day.
    if (bonus.createdAt > earlier(at, periodWait)) return;
    yield* store.applied(bonus, "not_added", at);
    return;
  }
  yield* store.applied(bonus, outcome, at);
  yield* Effect.logInfo("Share bonus applied", { side: bonus.side, outcome });
});

/** Check one waiting referral and settle it when it qualifies, is excluded or runs out of time. */
const evaluate = Effect.fn("Share.evaluate")(function* (referral: Model.Referral) {
  const store = yield* Model.Store;
  const activity = yield* Model.Activity;
  const cards = yield* Model.Cards;
  const flags = yield* Model.Flags;
  const at = yield* now;
  const servers = yield* store.servers(referral.accountId);
  const counted = yield* activity.metered(servers, referral.windowStart, referral.windowEnd);
  if (counted === null) {
    yield* store.recheck(referral.id, at, later(at, retryAfter));
    return;
  }
  const qualifies =
    counted.messages >= share.qualifyingMessages && counted.days.size >= share.qualifyingDays;
  if (!qualifies) {
    if (at >= referral.windowEnd) yield* store.settle(referral.id, "expired", null, at);
    else {
      const next = later(at, checkEvery);
      yield* store.recheck(referral.id, at, next < referral.windowEnd ? next : referral.windowEnd);
    }
    return;
  }
  const [referredFlagged, sharerFlagged] = yield* Effect.all(
    [flags.flagged(referral.accountId), flags.flagged(referral.sharerAccountId)],
    { concurrency: 2 },
  );
  if (referredFlagged || sharerFlagged) {
    yield* store.settle(referral.id, "excluded", "flagged", at);
    return;
  }
  if (yield* cards.shared(referral.sharerAccountId, referral.accountId)) {
    yield* store.settle(referral.id, "excluded", "same_card", at);
    return;
  }
  const status = yield* store.qualify(referral, at);
  yield* Effect.logInfo("Share referral settled", { status });
});

/**
 * The minute cron's share stage: apply pending bonuses, then check referrals that are due. Both
 * are bounded; a failed item is retried on a later run and reported after the others ran.
 */
export const synchronize = Effect.fn("Share.synchronize")(function* (
  configuration: Model.Configuration,
) {
  if (!configuration.enabled) return;
  const store = yield* Model.Store;
  const bonuses = yield* store.pending(20);
  const applied = yield* Effect.forEach(bonuses, (bonus) => apply(bonus).pipe(Effect.result), {
    concurrency: 3,
  });
  const due = yield* store.due(yield* now, 10);
  const checked = yield* Effect.forEach(
    due,
    (referral) =>
      evaluate(referral).pipe(
        Effect.tapError(() =>
          now.pipe(
            Effect.flatMap((at) => store.recheck(referral.id, at, later(at, retryAfter))),
            Effect.ignore,
          ),
        ),
        Effect.result,
      ),
    { concurrency: 3 },
  );
  // Bonuses earned by this run's checks go out now instead of on the next run.
  const earned = due.length === 0 ? [] : yield* store.pending(20);
  yield* Effect.forEach(earned, (bonus) => apply(bonus).pipe(Effect.ignore), { concurrency: 3 });
  for (const outcome of [...applied, ...checked])
    if (outcome._tag === "Failure") return yield* outcome.failure;
});

/** Compose the share-link service from the platform's account and identity rules. */
export const layer = (configuration: Model.Configuration) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const store = yield* Model.Store;
      const allowances = yield* Model.Allowances;
      const activity = yield* Model.Activity;
      const cards = yield* Model.Cards;
      const flags = yield* Model.Flags;
      const platform = yield* Platform.Service;
      const identity = yield* Platform.Identity;
      const ports = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          Model.Store | Model.Allowances | Model.Activity | Model.Cards | Model.Flags
        >,
      ) =>
        effect.pipe(
          Effect.provideService(Model.Store, store),
          Effect.provideService(Model.Allowances, allowances),
          Effect.provideService(Model.Activity, activity),
          Effect.provideService(Model.Cards, cards),
          Effect.provideService(Model.Flags, flags),
        );
      const url = (code: Share.Code) =>
        `${configuration.origin}/?${Share.parameter}=${encodeURIComponent(code)}`;
      const unavailableState = (asOf: M.Timestamp): Share.State => ({
        status: "unavailable",
        offer: null,
        link: null,
        free: false,
        exhausted: false,
        referrals: [],
        joined: null,
        asOf,
      });
      const account = Effect.fn("Share.account")(function* (
        actor: Identity.Actor,
        accountId: P.AccountId,
      ) {
        const { permissions: _, ...value } = yield* platform.getAccount(actor, accountId);
        return value;
      });
      const view = Effect.fn("Share.view")(function* (actor: Identity.Actor, value: P.Account) {
        const asOf = yield* now;
        if (!configuration.enabled) return unavailableState(asOf);
        const found = yield* store.joined(value.id);
        const joined =
          found === null
            ? null
            : {
                joinedAt: found.referral.joinedAt,
                status: found.bonus?.status ?? "pending",
                appliedAt: found.bonus?.appliedAt ?? null,
              };
        if (value.createdBy !== actor.userId)
          return { ...unavailableState(asOf), status: "owner_only", offer, joined } as const;
        const link = yield* store.link(value.id);
        const [free, exhausted, referrals] = yield* Effect.all(
          [
            allowances.free(value.id),
            link === null ? Effect.succeed(false) : store.exhausted(link),
            link === null ? Effect.succeed([]) : store.referrals(link.code, listLimit),
          ],
          { concurrency: 3 },
        );
        return {
          status: "available",
          offer,
          link:
            link === null
              ? null
              : { code: link.code, url: url(link.code), createdAt: link.createdAt },
          free,
          exhausted,
          referrals: referrals.map((referral) => ({
            joinedAt: referral.joinedAt,
            windowEndsAt: referral.windowEnd,
            status: referral.status,
            settledAt: referral.settledAt,
            bonus:
              referral.bonus === null
                ? null
                : { status: referral.bonus.status, appliedAt: referral.bonus.appliedAt },
          })),
          joined,
          asOf,
        } satisfies Share.State;
      });
      /** The checks that need nothing written, in the order a refusal is decided. */
      const admissible = Effect.fn("Share.admissible")(function* (
        actor: Identity.Actor,
        value: P.Account,
        link: Model.Link,
        at: M.Timestamp,
      ): Effect.fn.Return<Admission, Failure> {
        const refuse = (reason: Share.JoinRefusal): Admission => ({ kind: "refused", reason });
        if (link.accountId === value.id || link.ownerId === actor.userId) return refuse("own_link");
        const newness = yield* store.newness(value.id);
        if (
          newness === null ||
          newness.claimedAt === null ||
          newness.claimedAt < earlier(at, { days: share.joinWithinDays })
        )
          return refuse("not_new");
        const [memberThere, sharerHere] = yield* Effect.all(
          [store.member(link.accountId, actor.userId), store.member(value.id, link.ownerId)],
          { concurrency: 2 },
        );
        if (memberThere || sharerHere) return refuse("own_link");
        const [joiner, sharer] = yield* Effect.all(
          [platform.currentUser(actor), identity.user(link.ownerId)],
          { concurrency: 2 },
        );
        if (Domains.sameOrganizationDomain(joiner.email, sharer.email)) return refuse("own_link");
        return { kind: "admitted", newness };
      });

      return Service.of({
        state: Effect.fn("Share.state")(function* (actor, accountId) {
          return yield* view(actor, yield* account(actor, accountId));
        }),
        link: Effect.fn("Share.link")(function* (actor, accountId) {
          const value = yield* account(actor, accountId);
          if (!configuration.enabled)
            return yield* forbidden("Share links are not available here.");
          if (value.createdBy !== actor.userId)
            return yield* forbidden("Only the organization owner has a share link.");
          yield* store.createLink({
            code: newCode(),
            accountId: value.id,
            ownerId: actor.userId,
            createdAt: yield* now,
          });
          return yield* view(actor, value);
        }),
        join: Effect.fn("Share.join")(function* (actor, accountId, input) {
          if (!configuration.enabled) return { joined: false, reason: "unavailable" } as const;
          const value = yield* account(actor, accountId);
          if (value.createdBy !== actor.userId)
            return { joined: false, reason: "not_owner" } as const;
          const earlierJoin = yield* store.joined(value.id);
          if (earlierJoin !== null)
            return earlierJoin.referral.code === input.code
              ? ({ joined: true, state: yield* view(actor, value) } as const)
              : ({ joined: false, reason: "already_joined" } as const);
          const link = yield* store.linkByCode(input.code);
          if (link === null) return { joined: false, reason: "unknown_code" } as const;
          const at = yield* now;
          const checked = yield* admissible(actor, value, link, at);
          if (checked.kind === "refused") return { joined: false, reason: checked.reason } as const;
          const outcome = yield* store.join({
            id: crypto.randomUUID(),
            code: link.code,
            sharerAccountId: link.accountId,
            sharerOwnerId: link.ownerId,
            accountId: value.id,
            ownerId: actor.userId,
            joinedAt: at,
            windowStart: checked.newness.createdAt,
            windowEnd: later(checked.newness.createdAt, { days: share.windowDays }),
            status: "waiting",
            settledAt: null,
            nextCheckAt: later(at, checkEvery),
          });
          if (outcome.kind !== "joined") return { joined: false, reason: outcome.kind } as const;
          yield* Effect.logInfo("Share link joined");
          // Add the new organization's messages now; the minute cron retries if this fails.
          const found = yield* store.joined(value.id);
          if (found?.bonus != null)
            yield* ports(apply(found.bonus)).pipe(
              Effect.catchTag("ShareUnavailable", () => Effect.void),
            );
          return { joined: true, state: yield* view(actor, value) } as const;
        }),
      });
    }),
  );

/** Expected failures of the share-link operations. */
export type { Failure };
