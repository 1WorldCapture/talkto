import type * as B from "@talkto/api/billing";

/** A stored paid invoice can be historical; use the server's observation time, not the browser clock. */
export function currentPaidPeriod(state: B.State): B.PaidPeriod | null {
  const period = state.paidPeriod;
  return period && period.start <= state.usage.asOf && state.usage.asOf < period.end
    ? period
    : null;
}

/** The trial uses its own quota period, including while an exhausted trial awaits payment. */
export function hasTrialUsage(state: B.State): boolean {
  return (
    state.trial?.status === "active" &&
    state.trial.start === state.usage.periodStart &&
    currentPaidPeriod(state) === null
  );
}

/** Match the existing checkout policy; Stripe is rechecked by the server before a new subscription. */
export function canStartSubscription(state: B.State): boolean {
  return (
    // A refunded or disputed period holds no paid time, as the server's checkout check agrees.
    (currentPaidPeriod(state) === null || state.revocation !== undefined) &&
    !(hasTrialUsage(state) && state.trial?.end && state.trial.end > state.usage.asOf) &&
    state.issue === null &&
    (state.subscription === null ||
      state.subscription.status === "canceled" ||
      state.subscription.status === "incomplete_expired")
  );
}

/** Describe every provider lifecycle without mistaking it for permission to send messages. */
export function subscriptionSummary(state: B.State) {
  const subscription = state.subscription;
  if (!subscription)
    return {
      label: "No subscription",
      detail: state.checkout
        ? "Checkout has started, but no subscription is confirmed yet."
        : "This organization does not have a subscription.",
    };
  switch (subscription.status) {
    case "canceled":
      return {
        label: "Canceled",
        detail: currentPaidPeriod(state)
          ? "Your paid allowance remains available until the period ends. This subscription will not renew."
          : "This subscription has ended and will not renew.",
      };
    case "incomplete_expired":
      return {
        label: "Expired",
        detail: "The initial payment was not completed. Choose a plan to start again.",
      };
    case "incomplete":
      return {
        label: "Payment incomplete",
        detail: "The initial payment still needs to be completed in Stripe.",
      };
    case "trialing":
      if (state.trial?.end && state.trial.end <= state.usage.asOf)
        return {
          label: "Trial ended",
          detail: subscription.cancelAtPeriodEnd
            ? "Your trial has ended. No renewal charge is scheduled."
            : "Your trial has ended. Sending resumes after payment is confirmed.",
        };
      if (state.trial?.status === "active")
        return {
          label: "Free trial",
          detail: subscription.cancelAtPeriodEnd
            ? "Your trial will end without a charge."
            : "Your selected plan starts when the trial ends unless you cancel.",
        };
      return {
        label: "Trial reported by Stripe",
        detail: "Stripe reports a trial. Message access follows the allowance shown here.",
      };
    case "paused":
      return {
        label: "Paused",
        detail: "This subscription is paused. Check its payment details in Stripe.",
      };
    case "past_due":
      return {
        label: "Payment past due",
        detail: "A payment is overdue. Review the payment method and invoices in Stripe.",
      };
    case "unpaid":
      return {
        label: "Unpaid",
        detail: "Payment is outstanding. Review the payment method and invoices in Stripe.",
      };
    case "active":
      if (subscription.payment === "unpaid")
        return {
          label: "Payment needs attention",
          detail: "The latest payment is not confirmed as paid. Check its status in Stripe.",
        };
      if (subscription.payment === "pending")
        return {
          label: "Payment confirmation pending",
          detail: "The subscription is recorded. Payment confirmation is still pending.",
        };
      if (subscription.cancelAtPeriodEnd)
        return {
          label: "Renewal canceled",
          detail: "This subscription will not renew after its current period.",
        };
      return currentPaidPeriod(state)
        ? { label: "Active", detail: "Payment is confirmed for the current period." }
        : {
            label: "Awaiting paid period",
            detail: "A subscription is recorded, but no current paid period is confirmed.",
          };
  }
}
