import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Result, Schema } from "effect";
import * as B from "@talkto/api/billing";
import { storageGigabytes, storageLabel } from "@talkto/api/pricing";
import type * as P from "@talkto/api/platform";
import type * as U from "@talkto/api/metering";
import { ApiError, denied, request } from "./api.js";
import { Dialog, Notice } from "./components.js";
import {
  canStartSubscription,
  currentPaidPeriod,
  hasTrialUsage,
  subscriptionSummary,
} from "./billing-state.js";
import { useHuman, useServices } from "./session.js";
import * as Recovery from "./billing-recovery.js";
import { showsGrant, StarterPanel, useStarter } from "./starter.js";
import { SharePanel } from "./share.js";
import "./billing.css";
import { allowanceRule } from "./invite-copy.js";

const Intent = Schema.Struct({
  ...B.Checkout.fields,
  phase: Schema.Literals(["checkout", "confirming"]),
});
type Intent = typeof Intent.Type;
const number = new Intl.NumberFormat("en-US");
const activatingNotice = "Checkout complete. Activating your plan…";
const price = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
/** Agents never count; only humans in the organization do. */
const people = (limit: number | null) =>
  limit === null ? "Unlimited people" : `Up to ${limit} people`;
const date = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
/** A bigger plan starts now; a smaller one waits for renewal. */
const upgrades = (from: B.Plan, to: B.Plan) =>
  B.Plan.literals.indexOf(to) > B.Plan.literals.indexOf(from);

function readIntent(key: string): Intent | null {
  try {
    const stored = sessionStorage.getItem(key);
    if (stored === null) return null;
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Intent))(stored);
    return parsed._tag === "Some" ? parsed.value : null;
  } catch {
    return null;
  }
}

/** Billing is scoped to one human/organization; a late checkout must never redirect another page. */
export function BillingPage({ accountId }: { readonly accountId: P.AccountId }) {
  const user = useHuman();
  return <BillingSession key={`${user.id}:${accountId}`} accountId={accountId} />;
}

function BillingSession({ accountId }: { readonly accountId: P.AccountId }) {
  const { api, queries } = useServices();
  const user = useHuman();
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const storageKey = `talkto-checkout:${user.id}:${accountId}`;
  const [intent, setIntent] = useState(() => readIntent(storageKey));
  const [recoveryStore] = useState(() => Recovery.storage(user.id, accountId));
  const [initialRecovery] = useState(() => recoveryStore.read());
  const [savedAction, setSavedAction] = useState(
    Result.isSuccess(initialRecovery) ? initialRecovery.success : null,
  );
  const [recoveryError, setRecoveryError] = useState(
    Result.isFailure(initialRecovery) ? initialRecovery.failure : null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [skipTrial, setSkipTrial] = useState(false);
  const [confirmPaid, setConfirmPaid] = useState(false);
  const [moving, setMoving] = useState<B.PlanChange | null>(null);
  const [watchStarted, setWatchStarted] = useState(Date.now);
  const returned = search.billing === "return";
  // Stripe sends the owner back only after Checkout completes; ask the server to read it now.
  const [returnCheck, setReturnCheck] = useState<"checking" | "read" | "unread">(
    returned ? "checking" : "unread",
  );
  const mounted = useRef(false);
  const busy = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const queryKey = ["human", user.id, accountId, "billing"];
  const result = useQuery({
    queryKey,
    queryFn: ({ signal }) => request(api.billing.state({ params: { accountId } }), signal),
    refetchInterval: (q) => {
      if (denied(q.state.error)) return false;
      const state = q.state.data?.data;
      const waiting =
        state?.checkout ||
        state?.subscription?.payment === "pending" ||
        ((search.billing === "return" || intent?.phase === "confirming") &&
          (!state || (!currentPaidPeriod(state) && state.trial?.status !== "active")));
      const elapsed = Date.now() - watchStarted;
      if (!waiting || elapsed >= 120_000) return 30_000;
      return elapsed < 30_000 ? 1500 : 5000;
    },
  });
  useEffect(() => {
    if (!returned) return;
    const controller = new AbortController();
    request(api.billing.confirmCheckout({ params: { accountId } }), controller.signal, "billing")
      .then(async (value) => {
        if (controller.signal.aborted) return;
        // A poll that started before this read must not replace it with older state.
        await queries.cancelQueries({ queryKey });
        if (controller.signal.aborted) return;
        queries.setQueryData(queryKey, value);
        setReturnCheck("read");
      })
      // Polling still shows the confirmed plan once the webhook or scheduled repair applies it.
      .catch(() => {
        if (!controller.signal.aborted) setReturnCheck("unread");
      });
    return () => controller.abort();
    // One confirmation per return. The query key derives from the same user and account.
  }, [returned, accountId, api]);
  const state = denied(result.error) ? undefined : result.data?.data;
  // The free start works without paid billing; its panel stays visible when billing is unavailable.
  const starterResult = useStarter(accountId);
  const starterState = denied(starterResult.error) ? undefined : starterResult.data?.data;
  const account = useQuery({
    queryKey: ["human", user.id, accountId, "account"],
    queryFn: ({ signal }) => request(api.platform.getAccount({ params: { accountId } }), signal),
  });
  const owner = state?.permissions.manageBilling ?? account.data?.data.permissions.manageBilling;
  const starterShown = showsGrant(starterState) && !(state && currentPaidPeriod(state));
  const billingOff =
    result.error instanceof ApiError && result.error.code === "billing_unavailable" && !state;
  const rememberAction = (value: Recovery.Action | null) => {
    const written = recoveryStore.write(value);
    if (Result.isFailure(written)) {
      setRecoveryError(written.failure);
      return false;
    }
    setSavedAction(written.success);
    setRecoveryError(null);
    return true;
  };
  const clearReturnHint = () => {
    if (!search.billing) return;
    void navigate({
      to: "/app/$",
      params: { _splat: `accounts/${accountId}/billing` },
      search: (previous) => ({ ...previous, billing: undefined }),
      replace: true,
    });
  };
  const remember = (value: Intent | null) => {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
    setIntent(value);
  };
  useEffect(() => {
    if (state?.subscription?.payment === "paid" && !state.checkout && intent) {
      // Clearing an obsolete hint is best-effort; the server owns the durable operation.
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* Browser storage can be unavailable. */
      }
      setIntent(null);
    }
  }, [state, intent, storageKey]);
  const pending = state?.checkout ?? (state && canStartSubscription(state) ? intent : null);
  const action = useMutation({
    mutationFn: async (
      operation:
        | { readonly kind: "checkout"; readonly input: B.Checkout }
        | { readonly kind: "cancel"; readonly input: B.Checkout }
        | Recovery.Action
        | { readonly kind: "portal" }
        | { readonly kind: "changePlan"; readonly input: B.PlanChange; readonly upgrade: boolean }
        | { readonly kind: "keepPlan"; readonly requestKey: B.Checkout["requestKey"] },
    ) => {
      if (operation.kind === "changePlan") {
        await request(
          api.billing.changePlan({ params: { accountId }, payload: operation.input }),
          undefined,
          "billing",
        );
        return { status: "moved", plan: operation.input.plan, upgrade: operation.upgrade } as const;
      }
      if (operation.kind === "keepPlan") {
        await request(
          api.billing.keepPlan({
            params: { accountId },
            payload: { requestKey: operation.requestKey },
          }),
          undefined,
          "billing",
        );
        return { status: "kept" } as const;
      }
      if (operation.kind === "renewal") {
        const result = await request(
          api.billing.renewal({ params: { accountId }, payload: operation.input }),
          undefined,
          "billing",
        );
        return { status: "updated", confirmed: result.data.confirmed } as const;
      }
      if (operation.kind === "startPaid") {
        const result = await request(
          api.billing.startPaid({
            params: { accountId },
            payload: { requestKey: operation.requestKey },
          }),
          undefined,
          "billing",
        );
        return { status: "converted", confirmed: result.data.confirmed } as const;
      }
      if (operation.kind === "portal") {
        const value = await request(
          api.billing.portal({ params: { accountId } }),
          undefined,
          "billing",
        );
        return { status: "open", url: value.data.url } as const;
      }
      if (operation.kind === "cancel")
        return (
          await request(
            api.billing.cancelCheckout({ params: { accountId }, payload: operation.input }),
            undefined,
            "billing",
          )
        ).data;
      return (
        await request(
          api.billing.checkout({ params: { accountId }, payload: operation.input }),
          undefined,
          "billing",
        )
      ).data;
    },
    onSuccess: async (value, operation) => {
      if (!mounted.current) return;
      if (value.status === "kept") {
        setNotice("The scheduled plan change is canceled. Your current plan renews as before.");
        return;
      }
      if (value.status === "moved") {
        const plan = B.plans[value.plan];
        setMoving(null);
        setNotice(
          value.upgrade
            ? `You are on ${plan.name} now. Its limits and extra messages apply from today.`
            : `${plan.name} starts at your next renewal.`,
        );
        return;
      }
      if (value.status === "updated") {
        if (value.confirmed) rememberAction(null);
        return;
      }
      if (value.status === "converted") {
        setConfirmPaid(false);
        if (value.confirmed) rememberAction(null);
        return;
      }
      if (operation.kind === "cancel") {
        remember(null);
        clearReturnHint();
        setNotice(
          value.status === "expired"
            ? "Checkout canceled. Choose a plan whenever you’re ready."
            : "Checkout already completed. Your subscription was not canceled.",
        );
        return;
      }
      if (value.status === "open") {
        // Provider URLs arrive only through the authenticated API, never query parameters.
        const destination = new URL(value.url);
        if (destination.protocol !== "https:")
          throw new ApiError(
            "billing_unavailable",
            "The payment link could not be opened. Try again.",
          );
        location.assign(destination.href);
      } else if (value.status === "expired") {
        remember(null);
        clearReturnHint();
        setNotice("Checkout expired. Choose a plan to start again.");
      } else {
        if (operation.kind === "checkout") remember({ ...operation.input, phase: "confirming" });
        setNotice(activatingNotice);
        setWatchStarted(Date.now());
      }
    },
    onSettled: async () => {
      busy.current = false;
      await queries.cancelQueries({ queryKey });
      await queries.invalidateQueries({ queryKey });
    },
  });
  const checkout = (plan: B.Plan) => {
    if (
      busy.current ||
      savedAction ||
      recoveryError ||
      result.error ||
      !state?.permissions.manageBilling
    )
      return;
    let next: Intent = pending
      ? { ...pending, phase: "checkout" }
      : {
          plan,
          requestKey: B.Checkout.fields.requestKey.make(crypto.randomUUID()),
          phase: "checkout",
        };
    if (!pending && state.trialAvailable && !skipTrial) next = { ...next, offer: "trial" };
    try {
      remember(next);
    } catch {
      setNotice(
        "Your browser could not remember this checkout. Allow session storage and try again.",
      );
      return;
    }
    busy.current = true;
    setNotice(null);
    action.mutate({
      kind: "checkout",
      input: B.checkoutIntent(next.plan, next.requestKey, next.offer),
    });
  };
  const portal = () => {
    if (busy.current || result.error || !state?.permissions.manageBilling) return;
    busy.current = true;
    action.mutate({ kind: "portal" });
  };
  // One request key per confirmation, so a retry after a lost response cannot charge twice.
  // A declined payment closes nothing; reopening the dialog after fixing the card starts anew.
  const openPlanChange = (plan: B.Plan) => {
    if (busy.current || result.error || !state?.permissions.manageBilling) return;
    action.reset();
    setMoving({ plan, requestKey: B.Checkout.fields.requestKey.make(crypto.randomUUID()) });
  };
  const changePlan = () => {
    if (busy.current || result.error || !state?.permissions.manageBilling || !moving) return;
    busy.current = true;
    setNotice(null);
    const from = state.subscription?.plan;
    action.mutate({
      kind: "changePlan",
      input: moving,
      upgrade: from !== undefined && upgrades(from, moving.plan),
    });
  };
  const keepPlan = () => {
    if (busy.current || result.error || !state?.permissions.manageBilling) return;
    busy.current = true;
    setNotice(null);
    action.mutate({
      kind: "keepPlan",
      requestKey: B.Checkout.fields.requestKey.make(crypto.randomUUID()),
    });
  };
  const subscribed = state?.subscription;
  const changing =
    !!state &&
    !!subscribed &&
    state.permissions.manageBilling &&
    !savedAction &&
    subscribed.status === "active" &&
    subscribed.payment === "paid" &&
    currentPaidPeriod(state) !== null;
  const renewsAt = state ? currentPaidPeriod(state)?.end : undefined;
  const cancelCheckout = () => {
    if (busy.current || result.error || !state?.permissions.manageBilling || !pending) return;
    busy.current = true;
    setNotice(null);
    action.mutate({
      kind: "cancel",
      input: B.checkoutIntent(pending.plan, pending.requestKey, pending.offer),
    });
  };
  const confirmed =
    !!state && (currentPaidPeriod(state) !== null || state.trial?.status === "active");
  // Until the server has read the returned checkout, a pending checkout is not an open one.
  const checkingReturn = returned && returnCheck === "checking" && !confirmed;
  const activating =
    returned &&
    !confirmed &&
    (checkingReturn ||
      (!!state &&
        !state.checkout &&
        (state.subscription?.status === "active" || state.subscription?.status === "trialing") &&
        state.subscription.payment !== "unpaid"));
  const trialUsage = !!state && hasTrialUsage(state);
  const plansShown =
    !!state &&
    !(pending && state.permissions.manageBilling) &&
    !savedAction &&
    canStartSubscription(state) &&
    intent?.phase !== "confirming";
  const submitAction = (next: Recovery.Action) => {
    if (busy.current || recoveryError || result.error || !state?.permissions.manageBilling) return;
    if (!rememberAction(next)) return;
    busy.current = true;
    setNotice(null);
    action.mutate(next);
  };
  const changeRenewal = () => {
    if (savedAction || !state?.subscription) return;
    submitAction({
      kind: "renewal",
      input: {
        cancel: !state.subscription.cancelAtPeriodEnd,
        requestKey: B.Checkout.fields.requestKey.make(crypto.randomUUID()),
      },
    });
  };
  const convertTrial = () => {
    if (savedAction) return;
    submitAction({
      kind: "startPaid",
      requestKey: B.Checkout.fields.requestKey.make(crypto.randomUUID()),
    });
  };
  return (
    <section className="billing-page" aria-label="Organization billing">
      <div className="ops-page-bar">
        <h1 className="ops-page-title">Billing</h1>
        <button
          className="ops-new"
          aria-disabled={result.isFetching}
          onClick={() => {
            if (result.isFetching) return;
            setWatchStarted(Date.now());
            void result.refetch();
          }}
        >
          {result.isFetching ? "Checking…" : "Refresh"}
        </button>
      </div>
      {starterShown && starterState && !state && (
        <div className="starter-standalone">
          <StarterPanel
            state={starterState}
            manage={owner ?? false}
            plans={billingOff ? null : undefined}
          />
        </div>
      )}
      {!(starterShown && billingOff) && (
        <Notice
          error={result.error}
          stale={!!state}
          retry={() => {
            void result.refetch();
          }}
        />
      )}
      {result.isPending && (
        <p className="ops-empty" role="status">
          Loading billing…
        </p>
      )}
      {state && (
        <>
          <Notice error={action.error} />
          {recoveryError && (
            <p className="notice" role="alert">
              {recoveryError.message}
            </p>
          )}
          {savedAction && (
            <div className="notice" role="status">
              <p>
                {savedAction.kind === "renewal"
                  ? savedAction.input.cancel
                    ? "Your renewal cancellation is awaiting confirmation."
                    : "Resuming renewal is awaiting confirmation."
                  : "Your paid plan start is awaiting payment confirmation."}
              </p>
              {state.permissions.manageBilling && !denied(action.error) && (
                <button
                  className="text-button"
                  aria-disabled={action.isPending || !!result.error || !!recoveryError}
                  onClick={() => submitAction(savedAction)}
                >
                  {action.isPending ? "Checking…" : "Retry this change"}
                </button>
              )}
            </div>
          )}
          {notice &&
            (!confirmed ||
              action.variables?.kind === "cancel" ||
              action.variables?.kind === "changePlan" ||
              action.variables?.kind === "keepPlan") && (
              <p className="notice" role="status">
                {notice}
              </p>
            )}
          {activating && !notice && (
            <p className="notice" role="status">
              {activatingNotice}
            </p>
          )}
          {search.billing === "cancel" && pending && !confirmed && !notice && (
            <p className="notice">
              Returned from checkout. Continue below if payment is incomplete.
            </p>
          )}
          {state.issue === "period_conflict" && (
            <p className="notice" role="status">
              A payment period needs review. Your existing message allowance is unchanged.
            </p>
          )}
          {state.revocation && (
            <p className="notice" role="alert">
              {state.revocation.reason === "refund"
                ? "This billing month’s payment was refunded, so the paid plan ended on "
                : "This billing month’s payment is disputed, so the paid plan is paused from "}
              <time dateTime={state.revocation.at}>{date(state.revocation.at)}</time>. New sends are
              paused; history remains readable.{" "}
              {state.revocation.reason === "refund"
                ? "Sending resumes with the next paid renewal."
                : "Sending resumes if the dispute is decided in your favor, or with the next paid renewal."}
            </p>
          )}
          {state.downgradeKept && !state.subscription?.change && (
            <p className="notice" role="status">
              The move to {B.plans[state.downgradeKept.plan].name} at the renewal on{" "}
              <time dateTime={state.downgradeKept.at}>{date(state.downgradeKept.at)}</time> was
              canceled: the organization had {state.downgradeKept.people} people, counting pending
              invitations, and {B.plans[state.downgradeKept.plan].name} includes up to{" "}
              {B.plans[state.downgradeKept.plan].peopleLimit}.{" "}
              {B.plans[state.downgradeKept.kept].name} continues. Remove people to{" "}
              {B.plans[state.downgradeKept.plan].peopleLimit} or fewer to switch to{" "}
              {B.plans[state.downgradeKept.plan].name}.
            </p>
          )}
          {state.trial?.status === "rejected" && !currentPaidPeriod(state) && (
            <p className="notice" role="status">
              This account is not eligible for a trial. You can choose a paid plan.
            </p>
          )}
          <div className="billing-overview">
            <Subscription state={state} />
            {starterShown && starterState ? (
              <StarterPanel
                state={starterState}
                manage={state.permissions.manageBilling}
                plans={plansShown ? "#plans" : undefined}
              />
            ) : (
              <Usage usage={state.usage} trial={trialUsage} reversed={!!state.revocation} />
            )}
          </div>
          {checkingReturn ? null : pending && state.permissions.manageBilling ? (
            <section className="billing-checkout">
              <div>
                <h2>{B.plans[pending.plan].name} checkout</h2>
                <p>
                  {returned && returnCheck === "read"
                    ? "Stripe shows this checkout as not finished. Continue it to pay, or cancel it."
                    : "Continue the existing checkout to confirm its status."}
                </p>
              </div>
              <div className="billing-checkout-actions">
                <button
                  className="btn secondary"
                  aria-disabled={action.isPending || !!result.error}
                  onClick={cancelCheckout}
                >
                  {action.isPending && action.variables?.kind === "cancel"
                    ? "Canceling…"
                    : "Cancel checkout"}
                </button>
                <button
                  className="btn"
                  aria-disabled={action.isPending || !!result.error}
                  onClick={() => checkout(pending.plan)}
                >
                  {action.isPending && action.variables?.kind === "checkout"
                    ? "Checking checkout…"
                    : "Continue checkout ↗"}
                </button>
              </div>
            </section>
          ) : plansShown ? (
            <section id="plans" className="billing-plans" aria-label="Monthly plans">
              <header className="billing-plans-title">
                <h2>{state.permissions.manageBilling ? "Choose a plan" : "Monthly plans"}</h2>
                <p>Flat monthly price per organization. Not per seat.</p>
              </header>
              {state.trialAvailable && (
                <div className="billing-trial-offer">
                  <p>
                    7 days · 500 messages · 1 server. Card required. Your selected plan renews
                    monthly after the trial unless canceled.
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={skipTrial}
                      onChange={(event) => setSkipTrial(event.target.checked)}
                    />{" "}
                    Skip the trial and subscribe now
                  </label>
                </div>
              )}
              {state.plans.map((plan) => (
                <article key={plan.key}>
                  <h2>{plan.name}</h2>
                  <p className="billing-price">
                    {price(plan.monthlyCents)}
                    <span> / month</span>
                  </p>
                  <p>{number.format(plan.messages)} messages / month</p>
                  <p>{storageLabel(storageGigabytes[plan.key])} storage</p>
                  <p>Unlimited agents</p>
                  <p>{people(plan.peopleLimit)}</p>
                  {state.permissions.manageBilling && (
                    <button
                      className="btn"
                      aria-disabled={action.isPending || !!result.error}
                      onClick={() => checkout(plan.key)}
                    >
                      {action.isPending
                        ? "Opening checkout…"
                        : state.trialAvailable && !skipTrial
                          ? "Start free trial ↗"
                          : `Choose ${plan.name} ↗`}
                    </button>
                  )}
                </article>
              ))}
            </section>
          ) : null}
          {state.permissions.manageBilling &&
            !savedAction &&
            state.subscription &&
            ["active", "trialing", "past_due"].includes(state.subscription.status) &&
            (state.subscription.status !== "trialing" || state.trial?.status !== "rejected") && (
              <div className="billing-checkout-actions billing-renewal">
                <button
                  className="btn secondary"
                  aria-disabled={action.isPending || !!result.error || !!recoveryError}
                  onClick={changeRenewal}
                >
                  {action.isPending && action.variables?.kind === "renewal"
                    ? "Updating…"
                    : state.subscription.cancelAtPeriodEnd
                      ? "Resume renewal"
                      : state.subscription.status === "trialing"
                        ? "Cancel trial renewal"
                        : "Cancel renewal"}
                </button>
                {trialUsage &&
                  state.subscription.status === "trialing" &&
                  state.usage.used === 500 &&
                  state.usage.outstanding === 0 && (
                    <button
                      className="btn"
                      aria-disabled={action.isPending || !!result.error || !!recoveryError}
                      onClick={() => {
                        if (!busy.current && !result.error && !recoveryError) setConfirmPaid(true);
                      }}
                    >
                      Start paid plan now
                    </button>
                  )}
              </div>
            )}
          {confirmPaid && !savedAction && state.subscription && (
            <Dialog title="Start your paid plan now?" close={() => setConfirmPaid(false)}>
              <p>
                Your card will be charged {price(B.plans[state.subscription.plan].monthlyCents)} now
                for {B.plans[state.subscription.plan].name}, then monthly. Sending resumes once
                payment is confirmed.
              </p>
              <Notice error={action.error} />
              {recoveryError && (
                <p className="notice" role="alert">
                  {recoveryError.message}
                </p>
              )}
              <button
                className="btn"
                aria-disabled={action.isPending || !!result.error || !!recoveryError}
                onClick={convertTrial}
              >
                {action.isPending
                  ? "Confirming payment…"
                  : `Pay ${price(B.plans[state.subscription.plan].monthlyCents)} and start plan`}
              </button>
            </Dialog>
          )}
          {changing && subscribed && (
            <div className="billing-checkout" id="change-plan">
              <div>
                <h2>Change plan</h2>
                {subscribed.change ? (
                  <p>
                    {B.plans[subscribed.change.plan].name} starts at your next renewal. Keep{" "}
                    {B.plans[subscribed.plan].name} to cancel that change.
                  </p>
                ) : subscribed.cancelAtPeriodEnd ? (
                  <p>Resume renewal to change plan.</p>
                ) : (
                  <p>
                    A bigger plan starts now: your card is charged the difference for the rest of
                    this billing month, and the month gains a matching share of its messages. A
                    smaller plan starts at your next renewal.
                  </p>
                )}
              </div>
              {subscribed.change ? (
                <button
                  className="btn secondary"
                  aria-disabled={action.isPending || !!result.error}
                  onClick={keepPlan}
                >
                  {action.isPending && action.variables?.kind === "keepPlan"
                    ? "Updating…"
                    : `Keep ${B.plans[subscribed.plan].name}`}
                </button>
              ) : (
                !subscribed.cancelAtPeriodEnd && (
                  <div className="billing-checkout-actions">
                    {B.Plan.literals
                      .filter((plan) => plan !== subscribed.plan)
                      .map((plan) => (
                        <button
                          key={plan}
                          className={upgrades(subscribed.plan, plan) ? "btn" : "btn secondary"}
                          aria-disabled={action.isPending || !!result.error}
                          onClick={() => openPlanChange(plan)}
                        >
                          Move to {B.plans[plan].name}
                        </button>
                      ))}
                  </div>
                )
              )}
            </div>
          )}
          {moving && changing && subscribed && (
            <Dialog
              title={
                upgrades(subscribed.plan, moving.plan)
                  ? `Move to ${B.plans[moving.plan].name} now?`
                  : `Move to ${B.plans[moving.plan].name} at renewal?`
              }
              close={() => {
                if (!action.isPending) setMoving(null);
              }}
            >
              <PlanChangeTerms from={subscribed.plan} to={moving.plan} renewsAt={renewsAt} />
              <Notice error={action.error} />
              <button
                className="btn"
                aria-disabled={action.isPending || !!result.error}
                onClick={changePlan}
              >
                {action.isPending
                  ? "Updating…"
                  : upgrades(subscribed.plan, moving.plan)
                    ? `Pay the difference and move to ${B.plans[moving.plan].name}`
                    : `Move to ${B.plans[moving.plan].name} at renewal`}
              </button>
            </Dialog>
          )}
          {state.subscription && state.permissions.manageBilling && (
            <div className="billing-checkout">
              <div>
                <h2>Payment details & invoices</h2>
                <p>Manage your payment method and view invoices in Stripe.</p>
              </div>
              <button
                className="btn secondary"
                aria-disabled={action.isPending || !!result.error}
                onClick={portal}
              >
                {action.isPending ? "Opening Stripe…" : "Open Stripe ↗"}
              </button>
            </div>
          )}
          <p className="billing-footnote">
            {state.permissions.manageBilling
              ? "All plans include the same features and unlimited agents. Messages are shared across this organization’s servers."
              : "Only the organization owner can manage billing. Messages are shared across this organization’s servers."}
          </p>
          <p className="billing-freshness">
            Usage checked <time dateTime={state.usage.asOf}>{date(state.usage.asOf)}</time>
            {state.checkedAt && (
              <>
                {" "}
                · Payment checked <time dateTime={state.checkedAt}>{date(state.checkedAt)}</time>
              </>
            )}
          </p>
        </>
      )}
      <SharePanel accountId={accountId} />
    </section>
  );
}

/** What the owner agrees to before a plan change: when it starts and what it costs. */
export function PlanChangeTerms({
  from,
  to,
  renewsAt,
}: {
  readonly from: B.Plan;
  readonly to: B.Plan;
  readonly renewsAt: string | undefined;
}) {
  const current = B.plans[from];
  const next = B.plans[to];
  if (upgrades(from, to))
    return (
      <p>
        Your card is charged now for the difference between {price(current.monthlyCents)} and{" "}
        {price(next.monthlyCents)} for the rest of this billing month. {next.name}’s limits start
        when the payment goes through, and this month gains {next.name}’s extra messages for the
        days left. Then {price(next.monthlyCents)} / month. If the payment fails, nothing changes.
      </p>
    );
  return (
    <p>
      {current.name} stays until your renewal
      {renewsAt && (
        <>
          {" "}
          on <time dateTime={renewsAt}>{date(renewsAt)}</time>
        </>
      )}
      . Then {next.name} starts at {price(next.monthlyCents)} / month, with{" "}
      {people(next.peopleLimit).toLowerCase()} and {storageLabel(storageGigabytes[to])} storage.
      {next.peopleLimit !== null && (
        <>
          {" "}
          If the organization has more than {next.peopleLimit} people then, counting pending
          invitations, the move is canceled and {current.name} continues.
        </>
      )}{" "}
      No file is removed, but if stored files are above that storage then, uploads are refused until
      they fit. This month is not refunded.
    </p>
  );
}

function Subscription({ state }: { readonly state: B.State }) {
  const subscription = state.subscription;
  const plan = subscription ? state.plans.find((p) => p.key === subscription.plan) : null;
  const summary = subscriptionSummary(state);
  const period = state.paidPeriod;
  const ended = period !== null && period.end <= state.usage.asOf;
  const trial = hasTrialUsage(state) ? state.trial : null;
  // The messages are what billing recorded for this month. An upgraded month's allowance mixes
  // two plans, so it is explained on its own line.
  const month = period !== null && !ended && plan && period.plan === plan.key ? period : null;
  const upgrade = month?.upgrade;
  const change = subscription?.change;
  const next = change ? B.plans[change.plan] : null;
  return (
    <section className="billing-panel" aria-label="Subscription">
      <header>
        <h2>Plan</h2>
      </header>
      <div className="billing-panel-body">
        <p className="billing-plan-name">{trial ? "Free trial" : (plan?.name ?? "No paid plan")}</p>
        {plan && !trial && (
          <p>
            {price(plan.monthlyCents)} / month · {number.format(month?.allowance ?? plan.messages)}{" "}
            messages · {storageLabel(storageGigabytes[plan.key])} storage · unlimited agents ·{" "}
            {people(plan.peopleLimit).toLowerCase()}
          </p>
        )}
        {plan && month && upgrade && !trial && (
          <p>
            Upgraded from {B.plans[upgrade.from].name} on{" "}
            <time dateTime={upgrade.at}>{date(upgrade.at)}</time>. This billing month includes{" "}
            {number.format(month.allowance)} messages: {B.plans[upgrade.from].name}’s, plus{" "}
            {plan.name}’s extra messages for the rest of the month.
          </p>
        )}
        {!trial && <p>{summary.detail}</p>}
        {change && next && !trial && (
          <p className="billing-change">
            Moves to {next.name} on <time dateTime={change.at}>{date(change.at)}</time>, at{" "}
            {price(next.monthlyCents)} / month.
            {next.peopleLimit !== null && (
              <>
                {" "}
                {next.name} includes up to {next.peopleLimit} people and{" "}
                {storageLabel(storageGigabytes[change.plan])} storage. If the organization has more
                than {next.peopleLimit} people then, counting pending invitations, the move is
                canceled and {plan?.name ?? "the current plan"} continues. Remove people to{" "}
                {next.peopleLimit} or fewer before then to switch to {next.name}. No file is
                removed, but uploads are refused until stored files fit.
              </>
            )}
            {subscription?.cancelAtPeriodEnd ? null : " Canceling renewal also cancels this move."}
          </p>
        )}
        {trial &&
          plan &&
          subscription?.status === "trialing" &&
          trial.end &&
          trial.end > state.usage.asOf && (
            <p>
              {plan.name} · {price(plan.monthlyCents)}/month{" "}
              {subscription.cancelAtPeriodEnd ? "if renewed." : "after the trial."}
            </p>
          )}
        {trial &&
          (subscription?.status !== "trialing" || (trial.end && trial.end <= state.usage.asOf)) && (
            <p>{summary.detail}</p>
          )}
        {trial?.end && subscription?.status === "trialing" && trial.end > state.usage.asOf && (
          <p>
            {subscription.cancelAtPeriodEnd ? "Ends " : "First charge "}
            <time dateTime={trial.end}>{date(trial.end)}</time>
            {subscription.cancelAtPeriodEnd
              ? ". No charge."
              : plan
                ? ". Cancel before then to avoid a charge."
                : "."}
          </p>
        )}
        {!trial && subscription?.cancelAtPeriodEnd && summary.label !== "Renewal canceled" && (
          <p>Renewal is canceled after the current period.</p>
        )}
        {period && (
          <dl>
            <div>
              <dt>{ended ? "Last paid period started" : "Paid period starts"}</dt>
              <dd>
                <time dateTime={period.start}>{date(period.start)}</time>
              </dd>
            </div>
            <div>
              <dt>{ended ? "Paid period ended" : "Paid through"}</dt>
              <dd>
                <time dateTime={period.end}>{date(period.end)}</time>
              </dd>
            </div>
          </dl>
        )}
      </div>
    </section>
  );
}

function Usage({
  usage,
  trial,
  reversed = false,
}: {
  readonly usage: U.Usage;
  readonly trial: boolean;
  /** The period ended early because its payment was refunded or disputed. */
  readonly reversed?: boolean;
}) {
  const total = usage.allowance + usage.overdraft;
  // The exact count while servers hold capacity; without it, the range from reported usage.
  const exact = usage.outstanding === 0 ? usage.used : usage.counted;
  const settled = Math.min(100, total ? (100 * (exact ?? usage.used)) / total : 0);
  const unreported =
    exact === undefined
      ? Math.min(100 - settled, total ? (100 * usage.outstanding) / total : 0)
      : 0;
  return (
    <section
      className={`billing-panel${usage.status === "unmetered" || usage.periodStart === null ? " billing-panel-muted" : ""}`}
      aria-label="Message usage"
    >
      <header>
        <h2>Messages</h2>
      </header>
      <div className="billing-panel-body">
        {usage.status === "unmetered" ? (
          <p>Usage not tracked.</p>
        ) : usage.status === "payment_required" && usage.periodStart === null ? (
          <p>No message allowance.</p>
        ) : (
          <>
            <p className="billing-usage-number">
              {exact === undefined ? (
                <>
                  {number.format(usage.used)}–{number.format(usage.usageUpperBound)}
                </>
              ) : (
                number.format(exact)
              )}
              {trial && <> / {number.format(usage.allowance)}</>}
              <span> used</span>
            </p>
            {exact === undefined && (
              <p>Usage is updating. The range includes capacity held by servers.</p>
            )}
            <div className="billing-meter" aria-hidden="true">
              <span style={{ width: `${settled}%` }} />
              <span className="billing-meter-pending" style={{ width: `${unreported}%` }} />
            </div>
            {!trial && (
              <dl>
                <div>
                  <dt>Monthly allowance</dt>
                  <dd>{number.format(usage.allowance)}</dd>
                </div>
                <div>
                  <dt>Courtesy overdraft</dt>
                  <dd>{number.format(usage.overdraft)}</dd>
                </div>
              </dl>
            )}
            <p>{allowanceRule}</p>
            {!trial && usage.carriedOver !== undefined && usage.carriedOver > 0 && (
              <p>
                Includes {number.format(usage.carriedOver)} free trial messages carried over, for
                this period.
              </p>
            )}
            {usage.status === "exhausted" && (
              <p>
                {trial
                  ? "Trial messages are used. New sends pause until payment is confirmed; history remains readable."
                  : "Allowance and courtesy messages are spent. New sends are paused; history remains readable."}
              </p>
            )}
            {usage.status === "ready" && !trial && <p>Sending is enabled.</p>}
            {usage.status === "confirming" && (
              <p>
                Some servers may still send with their held capacity. Other sends may need to retry.
              </p>
            )}
            {usage.status === "payment_required" &&
              (reversed ? (
                <p>
                  The totals shown are for this billing month until its payment was reversed. New
                  sends need a current allowance; history remains readable.
                </p>
              ) : (
                <p>
                  The totals shown are for the previous period. New sends need a current allowance;
                  history remains readable.
                </p>
              ))}
            {usage.status === "overdraft" && (
              <p>Courtesy messages carry no extra charge. New sends pause once they are spent.</p>
            )}
            {usage.periodEnd && !trial && (
              <p>
                {usage.periodEnd <= usage.asOf ? "Period ended " : "Period ends "}
                <time dateTime={usage.periodEnd}>{date(usage.periodEnd)}</time>.
                {usage.periodEnd > usage.asOf &&
                  " A new allowance requires confirmed renewal payment."}
              </p>
            )}
            {usage.lastReportedAt && (
              <p className="billing-freshness">
                Last report{" "}
                <time dateTime={usage.lastReportedAt}>{date(usage.lastReportedAt)}</time>
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
