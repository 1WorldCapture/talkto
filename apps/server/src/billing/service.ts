import * as Metering from "../metering/model.js";
import { Context, DateTime, Effect, Layer, Schedule } from "effect";
import * as B from "@talkto/api/billing";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as Model from "./model.js";
import * as Platform from "../platform/service.js";
import type * as Identity from "../platform/model.js";
import * as TrialPolicy from "./trial-policy.js";
import * as Inbox from "../starter/inbox.js";

/** Durable billing operations, with all writes conditional on the held workspace lease. */
export class Store extends Context.Service<
  Store,
  {
    readonly get: (id: P.AccountId) => Effect.Effect<Model.Workspace | null, Model.Failure>;
    readonly refresh: (workspace: Model.Workspace) => Effect.Effect<Model.Workspace, Model.Failure>;
    readonly acquire: (
      id: P.AccountId,
      now: number,
      lease: string,
    ) => Effect.Effect<Model.Workspace, Model.Failure>;
    readonly release: (workspace: Model.Workspace) => Effect.Effect<void, Model.Failure>;
    readonly reserve: (
      workspace: Model.Workspace,
      input: B.Checkout,
      at: number,
    ) => Effect.Effect<Model.Operation, Model.Failure>;
    readonly pending: (id: P.AccountId) => Effect.Effect<Model.Operation | null, Model.Failure>;
    readonly bindTrial: (
      workspace: Model.Workspace,
      operation: Model.Operation,
    ) => Effect.Effect<void, Model.Failure>;
    readonly trial: (id: P.AccountId) => Effect.Effect<Model.Trial | null, Model.Failure>;
    readonly trialEligible: (
      id: P.AccountId,
      owner: P.UserId,
    ) => Effect.Effect<boolean, Model.Failure>;
    readonly claimTrial: (
      workspace: Model.Workspace,
      owner: P.UserId,
      emailKey: string,
      /** The key the same address had before November 16, 2026; an existing claim under it counts. */
      legacyEmailKey: string,
      at: number,
      dailyLimit: number,
    ) => Effect.Effect<void, Model.Failure>;
    readonly activateTrial: (
      workspace: Model.Workspace,
      observation: Model.TrialObservation,
    ) => Effect.Effect<Model.Trial, Model.Failure>;
    readonly customer: (
      workspace: Model.Workspace,
      operation: Model.Operation,
      customer: string,
    ) => Effect.Effect<Model.Workspace, Model.Failure>;
    readonly session: (
      workspace: Model.Workspace,
      operation: Model.Operation,
      session: Model.Session,
    ) => Effect.Effect<void, Model.Failure>;
    readonly observe: (
      workspace: Model.Workspace,
      observation: Model.Observation,
      at: M.Timestamp,
    ) => Effect.Effect<void, Model.Failure>;
    readonly period: (
      id: P.AccountId,
      at: M.Timestamp,
      start?: M.Timestamp,
    ) => Effect.Effect<B.PaidPeriod | null, Model.Failure>;
    /** Charges named by refund and dispute events received since the workspace's last observation. */
    readonly charges: (
      workspace: Model.Workspace,
    ) => Effect.Effect<
      { readonly chargeIds: ReadonlyArray<string>; readonly syncedEvent: number },
      Model.Failure
    >;
    /**
     * The reversal recorded against the period that starts at `start`: a refund or dispute of the
     * invoice that bought it or of an upgrade invoice that changed it. An active one wins.
     */
    readonly revocation: (
      id: P.AccountId,
      start: M.Timestamp,
    ) => Effect.Effect<Model.Revocation | null, Model.Failure>;
    /** Active subscriptions with a move to a smaller plan starting after `from`, up to `until`. */
    readonly downgrades: (
      from: M.Timestamp,
      until: M.Timestamp,
    ) => Effect.Effect<ReadonlyArray<Model.Downgrade>, Model.Failure>;
    /** Record that a scheduled move was canceled to keep the current plan. Idempotent. */
    readonly hold: (
      workspace: Model.Workspace,
      hold: Model.Hold,
      heldAt: M.Timestamp,
    ) => Effect.Effect<void, Model.Failure>;
    /** The latest kept plan whose renewal is after `since`. */
    readonly held: (
      id: P.AccountId,
      since: M.Timestamp,
    ) => Effect.Effect<Model.Hold | null, Model.Failure>;
    /** Records a bound event once; returns its organization, or null for a duplicate or unbound one. */
    readonly receive: (event: Model.Event) => Effect.Effect<P.AccountId | null, Model.Failure>;
    readonly due: (before: M.Timestamp) => Effect.Effect<ReadonlyArray<Model.Due>, Model.Failure>;
  }
>()("@talkto/billing/Store") {}

/** Payment boundary; provider types and secrets do not cross this service. */
export class Payments extends Context.Service<
  Payments,
  {
    readonly customer: (
      workspace: Model.Workspace,
      operation: Model.Operation,
    ) => Effect.Effect<string, Model.Failure>;
    readonly checkout: (operation: Model.Operation) => Effect.Effect<Model.Session, Model.Failure>;
    readonly expireCheckout: (
      operation: Model.Operation,
    ) => Effect.Effect<Model.Session, Model.Failure>;
    readonly observe: (
      workspace: Model.Workspace,
    ) => Effect.Effect<Model.Observation, Model.Failure>;
    /** Read refunded or disputed charges again; charges of another customer are left out. */
    readonly charges: (
      workspace: Model.Workspace,
      chargeIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<Model.ChargeReview>, Model.Failure>;
    readonly renewal: (
      workspace: Model.Workspace,
      input: B.Renewal,
    ) => Effect.Effect<void, Model.Failure>;
    readonly endTrial: (
      workspace: Model.Workspace,
      requestKey: M.RequestKey,
      cancel: boolean,
    ) => Effect.Effect<void, Model.Failure>;
    readonly portal: (
      customerId: string,
      accountId: P.AccountId,
    ) => Effect.Effect<string, Model.Failure>;
    /**
     * Move the active subscription to another plan. A bigger plan starts now: Stripe invoices the
     * prorated difference and must collect it, or nothing changes. A smaller plan is scheduled for
     * the end of the current period. Choosing the current plan drops a scheduled move. Confirmed
     * by a fresh read.
     */
    readonly changePlan: (
      workspace: Model.Workspace,
      input: B.PlanChange,
    ) => Effect.Effect<void, Model.Failure>;
    /** Drop a scheduled plan change and keep the current plan. Confirmed by a fresh read. */
    readonly keepPlan: (
      workspace: Model.Workspace,
      requestKey: M.RequestKey,
    ) => Effect.Effect<void, Model.Failure>;
    /** End the subscription now, without a final invoice or proration. Confirmed by a fresh read. */
    readonly cancel: (
      workspace: Model.Workspace,
      requestKey: M.RequestKey,
    ) => Effect.Effect<void, Model.Failure>;
    readonly verify: (
      body: string,
      signature: string,
    ) => Effect.Effect<Model.Event | null, Model.Failure>;
  }
>()("@talkto/billing/Payments") {}

/** Shared billing workflows; account authorization remains owned by the platform. */
export class Service extends Context.Service<
  Service,
  {
    readonly state: (
      actor: Identity.Actor,
      id: P.AccountId,
    ) => Effect.Effect<B.State, Model.Failure | Identity.Failure>;
    readonly checkout: (
      actor: Identity.Actor,
      id: P.AccountId,
      input: B.Checkout,
    ) => Effect.Effect<B.CheckoutResult, Model.Failure | Identity.Failure>;
    readonly portal: (
      actor: Identity.Actor,
      id: P.AccountId,
    ) => Effect.Effect<{ readonly url: string }, Model.Failure | Identity.Failure>;
    readonly changePlan: (
      actor: Identity.Actor,
      id: P.AccountId,
      input: B.PlanChange,
    ) => Effect.Effect<{ readonly confirmed: boolean }, Model.Failure | Identity.Failure>;
    readonly keepPlan: (
      actor: Identity.Actor,
      id: P.AccountId,
      requestKey: M.RequestKey,
    ) => Effect.Effect<{ readonly confirmed: boolean }, Model.Failure | Identity.Failure>;
    readonly cancelCheckout: (
      actor: Identity.Actor,
      id: P.AccountId,
      input: B.Checkout,
    ) => Effect.Effect<B.CancelCheckoutResult, Model.Failure | Identity.Failure>;
    /**
     * The owner returned from Stripe Checkout: read the checkout and subscription from Stripe now,
     * as a webhook would, and answer with the resulting state. A busy workspace is not an error;
     * its current holder is already applying Stripe's state.
     */
    readonly confirmCheckout: (
      actor: Identity.Actor,
      id: P.AccountId,
    ) => Effect.Effect<B.State, Model.Failure | Identity.Failure>;
    readonly synchronize: () => Effect.Effect<void, Model.Failure>;
    readonly renewal: (
      actor: Identity.Actor,
      id: P.AccountId,
      input: B.Renewal,
    ) => Effect.Effect<{ readonly confirmed: boolean }, Model.Failure | Identity.Failure>;
    readonly startPaid: (
      actor: Identity.Actor,
      id: P.AccountId,
      requestKey: M.RequestKey,
    ) => Effect.Effect<{ readonly confirmed: boolean }, Model.Failure | Identity.Failure>;
  }
>()("@talkto/billing/Service") {}

const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
const timestamp = (ms: number) => M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(ms)));

const operations = Effect.fn("Billing.operations")(function* () {
  const store = yield* Store;
  const payments = yield* Payments;
  const quotas = yield* Metering.Quotas;
  const publish = Effect.fn("Billing.publishAllowance")(function* (id: P.AccountId) {
    const read = quotas.read(id).pipe(Effect.mapError(() => Model.unavailable("metering.read")));
    let usage = yield* read;
    const period = yield* store.period(id, usage.asOf);
    const revocation = period === null ? null : yield* store.revocation(id, period.start);
    if (period !== null && revocation !== null) {
      // A refunded or disputed payment ends its period now, as an unpaid renewal would.
      if (revocation.status === "active") {
        yield* quotas
          .revoke(id, { start: period.start, at: revocation.at })
          .pipe(Effect.mapError(() => Model.unavailable("metering.revoke")));
        return {
          period,
          issue: null,
          revocation: { reason: revocation.reason, at: revocation.at },
        };
      }
      // A won dispute gives the period back its end before it is compared below.
      yield* quotas
        .restore(id, period.start)
        .pipe(Effect.mapError(() => Model.unavailable("metering.restore")));
      usage = yield* read;
    }
    const trial = yield* store.trial(id);
    const converting =
      trial?.status === "active" &&
      trial.start === usage.periodStart &&
      usage.used === trial.allowance &&
      usage.outstanding === 0;
    if (
      period !== null &&
      usage.periodStart !== null &&
      usage.periodEnd !== null &&
      (period.start !== usage.periodStart || period.end !== usage.periodEnd) &&
      period.start < usage.periodEnd &&
      // A Free plan month ends where the paid period starts, as the free start does.
      usage.kind !== "free" &&
      !converting
    ) {
      // Keep invoice evidence for repair, but never keep replaying a conflicting
      // period into the authority or make the user's billing page unreadable.
      return {
        period: yield* store.period(id, usage.asOf, usage.periodStart),
        issue: "period_conflict" as const,
        revocation: null,
      };
    }
    const accepted = yield* quotas
      .publish(
        id,
        period === null && trial?.status === "active" && trial.start !== null && trial.end !== null
          ? { start: trial.start, end: trial.end, allowance: trial.allowance, kind: "trial" }
          : period === null
            ? null
            : { ...period, kind: "paid" },
      )
      .pipe(Effect.mapError(() => Model.unavailable("metering.publish")));
    if (!accepted) return { period: null, issue: "period_conflict" as const, revocation: null };
    yield* quotas
      .publishStorage(
        id,
        period === null ? null : { plan: period.plan, start: period.start, end: period.end },
      )
      .pipe(Effect.mapError(() => Model.unavailable("storage.publish")));
    return { period, issue: null, revocation: null };
  });
  const locked = Effect.fn("Billing.locked")(function* <A>(
    id: P.AccountId,
    run: (workspace: Model.Workspace) => Effect.Effect<A, Model.Failure>,
  ) {
    return yield* Effect.acquireUseRelease(
      store.acquire(id, yield* now, crypto.randomUUID()),
      run,
      // A failed release leaves a recoverable lease that expires; do not turn storage failure into a defect.
      (workspace) =>
        store.release(workspace).pipe(
          Effect.catch((error) =>
            Effect.logError("Billing lease release failed; expiry will release it", {
              operation: error.operation,
            }),
          ),
        ),
    );
  });
  const reconcile = Effect.fn("Billing.reconcile")(function* (workspace: Model.Workspace) {
    if (workspace.customerId === null) return;
    const observation = yield* payments.observe(workspace);
    const named = yield* store.charges(workspace);
    const reviewed =
      named.chargeIds.length === 0
        ? null
        : yield* payments.charges(workspace, named.chargeIds).pipe(Effect.result);
    if (reviewed !== null && reviewed._tag === "Failure") {
      // The rest of billing still applies. The events stay unapplied, so the next pass reads the
      // charges again (for example once the key can read Charges and Disputes).
      yield* Effect.logError("Refund or dispute could not be read; it will be retried", {
        operation: reviewed.failure.operation,
        providerStatus: reviewed.failure.provider?.status ?? null,
      });
      yield* store.observe(
        { ...workspace, eventHead: named.syncedEvent },
        { ...observation, charges: [] },
        timestamp(yield* now),
      );
    } else
      yield* store.observe(
        workspace,
        { ...observation, charges: reviewed?.success ?? [] },
        timestamp(yield* now),
      );
    if (observation.trial !== null) {
      const claim = yield* store.trial(workspace.accountId);
      if (claim !== null) {
        const trial = yield* store.activateTrial(workspace, observation.trial);
        if (trial.status === "rejected") {
          yield* payments.endTrial(
            yield* store.refresh(workspace),
            M.RequestKey.make(`reject-${observation.trial.operationId}`),
            true,
          );
          yield* store.observe(
            workspace,
            yield* payments.observe(yield* store.refresh(workspace)),
            timestamp(yield* now),
          );
        }
      }
    }
    yield* publish(workspace.accountId);
  });
  const recoverCheckout = Effect.fn("Billing.recoverCheckout")(function* (
    workspace: Model.Workspace,
    operation: Model.Operation,
  ) {
    yield* store.bindTrial(workspace, operation);
    const customer = yield* payments.customer(workspace, operation);
    const bound = yield* store.customer(workspace, operation, customer);
    const session = yield* payments.checkout({ ...operation, customerId: customer });
    yield* store.session(bound, operation, session);
    return session;
  });
  /** Apply Stripe's current checkout and subscription state to one organization. */
  const repair = (id: P.AccountId) =>
    locked(
      id,
      Effect.fn("Billing.repair")(function* (workspace) {
        const pending = yield* store.pending(id);
        if (pending !== null) yield* recoverCheckout(workspace, pending);
        yield* reconcile(yield* store.refresh(workspace));
      }),
    );
  const synchronize = Effect.fn("Billing.synchronize")(function* () {
    const at = yield* now;
    const selected = yield* store.due(timestamp(at - 300000));
    yield* Effect.annotateCurrentSpan({
      "talkto.selected": selected.length,
      "talkto.unobserved": selected.filter((row) => row.checkedAt === null).length,
      "talkto.selected_oldest_check_age_ms": Math.max(
        0,
        ...selected.map((row) =>
          row.checkedAt === null
            ? 0
            : at - DateTime.toEpochMillis(DateTime.makeUnsafe(row.checkedAt)),
        ),
      ),
      "talkto.selected_oldest_attempt_age_ms": Math.max(
        0,
        ...selected.map((row) => (row.attemptedAt === 0 ? 0 : at - row.attemptedAt)),
      ),
    });
    const outcomes = yield* Effect.forEach(selected, ({ id }) => repair(id).pipe(Effect.result), {
      concurrency: 3,
    });
    yield* Effect.annotateCurrentSpan({
      "talkto.succeeded": outcomes.filter((outcome) => outcome._tag === "Success").length,
      "talkto.failed": outcomes.filter(
        (outcome) => outcome._tag === "Failure" && outcome.failure.code !== "billing_conflict",
      ).length,
      "talkto.busy": outcomes.filter(
        (outcome) => outcome._tag === "Failure" && outcome.failure.code === "billing_conflict",
      ).length,
    });
    // Only the first failure is returned, so name each one. Operations are code-defined
    // and provider details are schema-checked; no account, customer or provider text.
    for (const outcome of outcomes)
      if (outcome._tag === "Failure" && outcome.failure.code !== "billing_conflict")
        yield* Effect.logWarning("Billing workspace repair failed", {
          operation: outcome.failure.operation,
          providerStatus: outcome.failure.provider?.status ?? null,
          providerCode: outcome.failure.provider?.code ?? null,
        });
    const failed = outcomes.find(
      (outcome) => outcome._tag === "Failure" && outcome.failure.code !== "billing_conflict",
    );
    if (failed?._tag === "Failure") return yield* failed.failure;
  });
  return {
    store,
    payments,
    quotas,
    publish,
    locked,
    reconcile,
    recoverCheckout,
    repair,
    synchronize,
  };
});

const ended = (status: typeof B.SubscriptionStatus.Type) =>
  status === "canceled" || status === "incomplete_expired";

/**
 * Account deletion: expire an open checkout and end the organization's subscription at once,
 * under the workspace lease. No refund is issued. Authorization belongs to the caller; this needs
 * no human identity. Safe to repeat: an ended subscription and an expired checkout are left alone.
 */
export const close = Effect.fn("Billing.close")(function* (id: P.AccountId) {
  const core = yield* operations();
  if ((yield* core.store.get(id)) === null) return;
  yield* core.locked(
    id,
    Effect.fn("Billing.closeWorkspace")(function* (workspace) {
      const pending = yield* core.store.pending(id);
      if (pending !== null) {
        const recovered = yield* core.recoverCheckout(workspace, pending);
        const current = yield* core.store.refresh(workspace);
        const session = yield* core.payments.expireCheckout({
          ...pending,
          customerId: current.customerId,
          sessionId: recovered.id,
        });
        yield* core.store.session(current, pending, session);
      }
      yield* core.reconcile(yield* core.store.refresh(workspace));
      const current = yield* core.store.refresh(workspace);
      if (current.subscription === null || ended(current.subscription.status)) return;
      yield* core.payments.cancel(current, M.RequestKey.make(`account-deletion:${id}`));
      yield* core.reconcile(yield* core.store.refresh(workspace));
    }),
  );
});

/**
 * Apply a just-received payment event at once instead of at the next minute cron. Events for one
 * checkout arrive together, so a busy workspace is retried briefly; whatever is still unapplied stays
 * marked for the cron.
 */
export const apply = Effect.fn("Billing.apply")(function* (id: P.AccountId) {
  yield* (yield* operations()).repair(id).pipe(
    Effect.retry({
      while: (error) => error.code === "billing_conflict",
      times: 3,
      schedule: Schedule.spaced("500 millis"),
    }),
  );
});

/** Scheduled billing recovery needs no human identity or membership services. */
export const synchronize = Effect.fn("Billing.synchronizeScheduled")(function* () {
  yield* (yield* operations()).synchronize();
});

/** How far ahead of a renewal a scheduled move to a smaller plan is checked against its people limit. */
const holdWindowMs = 2 * 3600000;

/**
 * Scheduled: a move to a smaller plan that would start while the organization has more people than
 * that plan includes is canceled, so the current plan continues (and is paid for) until people are
 * within the limit. Checked every minute during the last two hours before the renewal, then recorded
 * for the Billing page and the owner's email. `people` counts members and pending invitations,
 * stopping above `limit`, or answers null where no people limit applies (operator-granted accounts).
 */
export const holdDowngrades = Effect.fn("Billing.holdDowngrades")(function* (
  people: (
    downgrade: Model.Downgrade,
    limit: number,
  ) => Effect.Effect<number | null, Model.Failure>,
) {
  const core = yield* operations();
  const at = yield* now;
  const due = yield* core.store.downgrades(timestamp(at), timestamp(at + holdWindowMs));
  const outcomes = yield* Effect.forEach(
    due,
    Effect.fn("Billing.holdDowngrade")(function* (downgrade) {
      const limit = B.plans[downgrade.plan].peopleLimit;
      if (limit === null) return;
      const count = yield* people(downgrade, limit);
      if (count === null || count <= limit) return;
      yield* core.locked(
        downgrade.accountId,
        Effect.fn("Billing.keepPlanForPeople")(function* (workspace) {
          yield* core.reconcile(workspace);
          const current = yield* core.store.refresh(workspace);
          const change = current.subscription?.change;
          // The owner kept or replaced the move meanwhile.
          if (
            current.subscription === null ||
            current.subscriptionId === null ||
            change?.plan !== downgrade.plan ||
            change.at !== downgrade.at
          )
            return;
          yield* core.payments.keepPlan(
            current,
            M.RequestKey.make(`people-${downgrade.plan}-${Date.parse(downgrade.at)}`),
          );
          yield* core.reconcile(yield* core.store.refresh(workspace));
          yield* core.store.hold(
            yield* core.store.refresh(workspace),
            {
              plan: downgrade.plan,
              kept: current.subscription.plan,
              at: downgrade.at,
              people: count,
            },
            timestamp(yield* now),
          );
          yield* Effect.logInfo("Scheduled plan change canceled: too many people for the plan", {
            plan: downgrade.plan,
            kept: current.subscription.plan,
            people: count,
          });
        }),
      );
    }, Effect.result),
    { concurrency: 3 },
  );
  for (const outcome of outcomes)
    if (outcome._tag === "Failure" && outcome.failure.code !== "billing_conflict")
      yield* Effect.logWarning("Keeping the current plan failed; the next minute retries", {
        operation: outcome.failure.operation,
      });
  const failed = outcomes.find(
    (outcome) => outcome._tag === "Failure" && outcome.failure.code !== "billing_conflict",
  );
  if (failed?._tag === "Failure") return yield* failed.failure;
});

/** Coordinate recoverable checkout and current payment observations under a fenced workspace lease. */
export const layer = (policy: TrialPolicy.Configuration, scope: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const core = yield* operations();
      const { store, payments, quotas, publish, locked, reconcile, recoverCheckout } = core;
      const platform = yield* Platform.Service;
      const manage = Effect.fn("Billing.authorize")(function* (
        actor: Identity.Actor,
        id: P.AccountId,
      ) {
        const account = yield* platform.getAccount(actor, id);
        if (account.createdBy !== actor.userId)
          return yield* new Model.Failure({
            code: "forbidden",
            operation: "authorize",
            message: "Only the organization owner can manage billing.",
          });
      });
      const state = Effect.fn("Billing.state")(function* (actor: Identity.Actor, id: P.AccountId) {
        const account = yield* platform.getAccount(actor, id);
        const workspace = yield* store.get(id);
        const pending = yield* store.pending(id);
        const allowance = yield* publish(id);
        const trial = yield* store.trial(id);
        // Exact while servers hold blocks, as the Free panel's count; see `Quotas.readCounted`.
        const usage = yield* quotas
          .readCounted(id)
          .pipe(Effect.mapError(() => Model.unavailable("metering.read")));
        // A move kept off at a renewal in the last month stays explained on the Billing page.
        const held = yield* store.held(id, timestamp((yield* now) - 31 * 86400000));
        const current = {
          plans: B.Plan.literals.map((key) => ({ key, ...B.plans[key] })),
          subscription: workspace?.subscription ?? null,
          checkout:
            pending === null
              ? null
              : B.checkoutIntent(pending.plan, pending.requestKey, pending.offer),
          paidPeriod: allowance.period,
          issue: allowance.issue,
          trial:
            trial === null
              ? null
              : {
                  status: trial.status,
                  start: trial.start,
                  end: trial.end,
                  allowance: trial.allowance,
                },
          trialAvailable:
            policy !== null &&
            account.createdBy === actor.userId &&
            (yield* store.trialEligible(id, actor.userId)) &&
            usage.status !== "unmetered",
          usage,
          checkedAt: workspace?.checkedAt ?? null,
          permissions: { manageBilling: account.createdBy === actor.userId },
        } satisfies B.State;
        // Each is present only when it applies: a refund or dispute ended the current paid month,
        // or a scheduled move was kept off because of the people limit.
        const reversed =
          allowance.revocation === null
            ? current
            : { ...current, revocation: allowance.revocation };
        return held === null ? reversed : { ...reversed, downgradeKept: held };
      });
      return Service.of({
        state,
        confirmCheckout: Effect.fn("Billing.confirmCheckout")(function* (actor, id) {
          yield* manage(actor, id);
          yield* core.repair(id).pipe(
            Effect.catchIf(
              (error) => error.code === "billing_conflict",
              () => Effect.void,
            ),
          );
          return yield* state(actor, id);
        }),
        checkout: Effect.fn("Billing.checkout")(function* (actor, id, input) {
          yield* manage(actor, id);
          // Moving to Shop, including after Studio or Factory ends, needs people within its limit.
          yield* platform.ensurePlanFits(actor, id, input.plan);
          let emailKey: string | null = null;
          let legacyEmailKey: string | null = null;
          if (input.offer === "trial") {
            if (policy === null)
              return yield* Model.conflict("Trials are not available right now.");
            const user = yield* platform.currentUser(actor);
            if (!user.emailVerified)
              return yield* Model.conflict("Verify your email before starting a trial.");
            const usage = yield* quotas
              .read(id)
              .pipe(Effect.mapError(() => Model.unavailable("metering.read")));
            if (usage.status === "unmetered")
              return yield* Model.conflict("Trials are not available for this organization.");
            // The free start's inbox rule: one trial per mailbox, however the address is spelled.
            emailKey = yield* TrialPolicy.claimKey(
              policy.secret,
              scope,
              `email:${Inbox.canonical(user.email)}`,
            );
            legacyEmailKey = yield* TrialPolicy.claimKey(
              policy.secret,
              scope,
              `email:${user.email.trim().toLowerCase()}`,
            );
          }
          return yield* locked(
            id,
            Effect.fn("Billing.purchase")(function* (workspace) {
              // A current provider read prevents stale cancellation state from authorizing another subscription.
              if (workspace.customerId !== null && (yield* store.pending(id)) === null)
                yield* reconcile(workspace);
              const current = yield* store.refresh(workspace);
              if (
                input.offer === "trial" &&
                emailKey !== null &&
                legacyEmailKey !== null &&
                policy !== null
              )
                yield* store.claimTrial(
                  current,
                  actor.userId,
                  emailKey,
                  legacyEmailKey,
                  yield* now,
                  policy.dailyLimit,
                );
              const operation = yield* store.reserve(current, input, yield* now);
              if (operation.status !== "pending") return { status: operation.status };
              const { result } = yield* recoverCheckout(current, operation);
              if (result.status === "complete") yield* reconcile(yield* store.refresh(workspace));
              return result;
            }),
          );
        }),
        renewal: Effect.fn("Billing.renewal")(function* (actor, id, input) {
          yield* manage(actor, id);
          return yield* locked(
            id,
            Effect.fn("Billing.changeRenewal")(function* (workspace) {
              yield* reconcile(workspace);
              yield* payments.renewal(yield* store.refresh(workspace), input);
              yield* reconcile(yield* store.refresh(workspace));
              return { confirmed: true };
            }),
          );
        }),
        startPaid: Effect.fn("Billing.startPaid")(function* (actor, id, requestKey) {
          yield* manage(actor, id);
          return yield* locked(
            id,
            Effect.fn("Billing.convertTrial")(function* (workspace) {
              yield* reconcile(workspace);
              const trial = yield* store.trial(id);
              const usage = yield* quotas
                .read(id)
                .pipe(Effect.mapError(() => Model.unavailable("metering.read")));
              const current = yield* store.refresh(workspace);
              if (trial?.status !== "active")
                return yield* Model.conflict("No active trial is available to convert.");
              if (current.subscription?.status !== "trialing")
                return { confirmed: current.subscription?.payment === "paid" };
              // No early period change while any server can still spend old capacity.
              if (
                usage.periodStart !== trial.start ||
                usage.used !== trial.allowance ||
                usage.outstanding !== 0
              )
                return yield* Model.conflict(
                  "Early paid access is available after all trial messages are used and usage is confirmed.",
                );
              if (
                trial.start === null ||
                Math.floor((yield* now) / 1000) * 1000 <=
                  DateTime.toEpochMillis(DateTime.makeUnsafe(trial.start))
              )
                return yield* Model.conflict("Usage is settling. Try again in a moment.");
              yield* payments.endTrial(current, requestKey, false);
              yield* reconcile(yield* store.refresh(workspace));
              return {
                confirmed: (yield* store.refresh(workspace)).subscription?.payment === "paid",
              };
            }),
          );
        }),
        portal: Effect.fn("Billing.portal")(function* (actor, id) {
          yield* manage(actor, id);
          const workspace = yield* store.get(id);
          if (workspace?.customerId === null || workspace === null)
            return yield* Model.conflict("Subscribe before opening billing management.");
          return { url: yield* payments.portal(workspace.customerId, id) };
        }),
        changePlan: Effect.fn("Billing.changePlan")(function* (actor, id, input) {
          yield* manage(actor, id);
          // A smaller plan needs people within its limit before it is scheduled.
          yield* platform.ensurePlanFits(actor, id, input.plan);
          return yield* locked(
            id,
            Effect.fn("Billing.moveToPlan")(function* (workspace) {
              if (workspace.subscriptionId === null)
                return yield* Model.conflict("Subscribe before changing plan.");
              yield* reconcile(workspace);
              // The paid proration invoice, not this request, raises the period's limits.
              yield* payments.changePlan(yield* store.refresh(workspace), input);
              yield* reconcile(yield* store.refresh(workspace));
              return { confirmed: true };
            }),
          );
        }),
        keepPlan: Effect.fn("Billing.keepPlan")(function* (actor, id, requestKey) {
          yield* manage(actor, id);
          return yield* locked(
            id,
            Effect.fn("Billing.keepCurrentPlan")(function* (workspace) {
              yield* payments.keepPlan(workspace, requestKey);
              yield* reconcile(yield* store.refresh(workspace));
              return { confirmed: true };
            }),
          );
        }),
        cancelCheckout: Effect.fn("Billing.cancelCheckout")(function* (actor, id, input) {
          yield* manage(actor, id);
          return yield* locked(
            id,
            Effect.fn("Billing.cancelPendingCheckout")(function* (workspace): Effect.fn.Return<
              B.CancelCheckoutResult,
              Model.Failure
            > {
              // Resolve the original intent even if its create response was lost. The same key
              // becomes terminal, so a delayed create/retry cannot reopen the canceled checkout.
              const operation = yield* store.reserve(workspace, input, yield* now);
              if (operation.status === "expired") return { status: "expired" };
              if (operation.status === "complete") {
                yield* reconcile(workspace);
                return { status: "complete" };
              }
              const recovered = yield* recoverCheckout(workspace, operation);
              const current = yield* store.refresh(workspace);
              const session = yield* payments.expireCheckout({
                ...operation,
                customerId: current.customerId,
                sessionId: recovered.id,
              });
              yield* store.session(current, operation, session);
              if (session.result.status === "open")
                return yield* Model.unavailable("checkout.expiration_pending");
              if (session.result.status === "complete")
                yield* reconcile(yield* store.refresh(workspace));
              return { status: session.result.status };
            }),
          );
        }),
        synchronize: core.synchronize,
      });
    }),
  );

/** Payment-event ingestion does not depend on human identity services. */
export const receive = Effect.fn("Billing.receive")(function* (body: string, signature: string) {
  const payments = yield* Payments;
  const store = yield* Store;
  const event = yield* payments.verify(body, signature);
  const account = event === null ? null : yield* store.receive(event);
  yield* Effect.annotateCurrentSpan(
    "talkto.outcome",
    event === null ? "ignored" : account !== null ? "received" : "duplicate_or_unbound",
  );
  return account;
});
