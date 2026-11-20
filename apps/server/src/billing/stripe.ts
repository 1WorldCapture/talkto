import Stripe from "stripe";
import {
  Config,
  ConfigProvider,
  DateTime,
  Effect,
  Layer,
  Predicate,
  Redacted,
  Result,
  Schema,
} from "effect";
import * as B from "@talkto/api/billing";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as Billing from "./service.js";
import * as Model from "./model.js";
import * as TrialPolicy from "./trial-policy.js";
import * as Entitlements from "../account-entitlements.js";

/** Explicit provider configuration, scoped independently from other products and environments. */
export interface Configuration {
  readonly key: Redacted.Redacted<string>;
  readonly webhookSecret: Redacted.Redacted<string>;
  readonly accountId: string;
  readonly environment: "test" | "staging" | "production";
  readonly live: boolean;
  readonly prices: Readonly<Record<B.Plan, string>>;
  readonly portalId: string;
  readonly origin: string;
  readonly trials: TrialPolicy.Configuration;
}
/** Stable namespace bound to every local billing record. */
export const scope = (config: Configuration) =>
  `${config.accountId}:${config.environment}:${config.live ? "live" : "test"}`;
/**
 * Missing configuration leaves billing off without changing existing messaging. A self-hosted copy
 * has no billing whatever `STRIPE_BILLING_ENABLED` says.
 */
export const enabled = (env: Env) =>
  Config.all({
    on: Config.boolean("STRIPE_BILLING_ENABLED").pipe(Config.withDefault(false)),
    selfHosted: Entitlements.selfHosted,
  }).pipe(
    Config.map(({ on, selfHosted }) => on && !selfHosted),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Effect.mapError(() => Model.unavailable("configuration.enabled")),
  );
/** Read secrets only at the Worker composition root; reject accidental live keys in staging. */
export const configuration = Effect.fn("Stripe.configuration")(function* (env: Env) {
  const config = yield* Config.all({
    key: Config.redacted("STRIPE_API_KEY"),
    webhookSecret: Config.redacted("STRIPE_WEBHOOK_SECRET"),
    accountId: Config.schema(
      Schema.String.check(Schema.isPattern(/^acct_[A-Za-z0-9]+$/)),
      "STRIPE_ACCOUNT_ID",
    ),
    environment: Config.schema(
      Schema.Literals(["test", "staging", "production"]),
      "STRIPE_ENVIRONMENT",
    ),
    live: Config.boolean("STRIPE_LIVE_MODE"),
    shop: Config.schema(
      Schema.String.check(Schema.isPattern(/^price_[A-Za-z0-9]+$/)),
      "STRIPE_SHOP_PRICE",
    ),
    studio: Config.schema(
      Schema.String.check(Schema.isPattern(/^price_[A-Za-z0-9]+$/)),
      "STRIPE_STUDIO_PRICE",
    ),
    factory: Config.schema(
      Schema.String.check(Schema.isPattern(/^price_[A-Za-z0-9]+$/)),
      "STRIPE_FACTORY_PRICE",
    ),
    portalId: Config.schema(
      Schema.String.check(Schema.isPattern(/^bpc_[A-Za-z0-9]+$/)),
      "STRIPE_PORTAL_CONFIGURATION",
    ),
    origin: Config.schema(
      Schema.String.check(
        Schema.makeFilter(
          (value) =>
            URL.canParse(value) &&
            new URL(value).origin === value &&
            new URL(value).protocol === "https:",
        ),
      ),
      "TALKTO_SERVICE_ORIGIN",
    ),
  }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Effect.mapError(() => Model.unavailable("configuration")),
  );
  const key = Redacted.value(config.key);
  if (
    (config.live && config.environment !== "production") ||
    !key.startsWith(config.live ? "rk_live_" : "rk_test_") ||
    !Redacted.value(config.webhookSecret).startsWith("whsec_") ||
    new Set([config.shop, config.studio, config.factory]).size !== 3
  )
    return yield* Model.unavailable("configuration.scope");
  return {
    ...config,
    trials: yield* TrialPolicy.configuration(env),
    prices: { shop: config.shop, studio: config.studio, factory: config.factory },
  } satisfies Configuration;
});
const timestamp = (seconds: number) =>
  M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000)));
const id = (value: string | { readonly id: string } | null) =>
  value === null ? null : Predicate.isString(value) ? value : value.id;
const verifiedEvent = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  livemode: Schema.Boolean,
  account: Schema.optionalKey(Schema.String),
  data: Schema.Struct({
    object: Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      customer: Schema.optionalKey(
        Schema.NullOr(Schema.Union([Schema.String, Schema.Struct({ id: Schema.String })])),
      ),
      // A dispute names its charge, not its customer.
      charge: Schema.optionalKey(
        Schema.NullOr(Schema.Union([Schema.String, Schema.Struct({ id: Schema.String })])),
      ),
    }),
  }),
});
/** Refunds and disputes; each names a charge that reconciliation reads again. */
const chargeEvents = new Set(["charge.refunded"]);
const disputeEvents = new Set(["charge.dispute.created", "charge.dispute.closed"]);
/** Dispute outcomes after which the payment counts again. */
const settledDisputes = new Set(["won", "warning_closed", "prevented"]);
const eventTypes = new Set([
  "checkout.session.completed",
  "checkout.session.expired",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.finalization_failed",
  // A downgrade scheduled for the period end; the Billing page shows the coming plan.
  "subscription_schedule.created",
  "subscription_schedule.updated",
  "subscription_schedule.released",
  "subscription_schedule.canceled",
  // A full refund or an open dispute ends the paid period that payment bought; a won dispute
  // restores it (docs/pricing-and-billing.md, "Refunds and disputes").
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
]);

/** Official Stripe SDK with fetch transport and Web Crypto, contained at the provider boundary. */
export const layer = (config: Configuration) =>
  Layer.sync(Billing.Payments, () => {
    const stripe = new Stripe(Redacted.value(config.key), {
      apiVersion: "2026-08-26.dahlia",
      httpClient: Stripe.createFetchHttpClient(),
      maxNetworkRetries: 0,
      timeout: 15000,
      telemetry: false,
    });
    const call = <A>(operation: string, invoke: () => Promise<A>) =>
      Effect.tryPromise({
        try: invoke,
        catch: (error) => {
          if (!(error instanceof Stripe.errors.StripeError))
            return Model.unavailable(`stripe.${operation}`);
          const code = Schema.decodeUnknownOption(Model.ProviderFailure.fields.code)(error.code);
          const requestId = Schema.decodeUnknownOption(Model.ProviderFailure.fields.requestId)(
            error.requestId,
          );
          const details = Schema.decodeUnknownOption(Model.ProviderFailure)({
            type: error.type,
            status: error.statusCode ?? null,
            code: code._tag === "Some" ? code.value : null,
            requestId: requestId._tag === "Some" ? requestId.value : null,
          });
          return Model.unavailable(
            `stripe.${operation}`,
            details._tag === "Some" ? details.value : undefined,
          );
        },
      });
    const metadata = (accountId: P.AccountId) => ({
      app: "talkto",
      environment: config.environment,
      workspace_id: accountId,
    });
    const owns = (value: Stripe.Metadata | null, accountId: P.AccountId) =>
      value?.app === "talkto" &&
      value.environment === config.environment &&
      value.workspace_id === accountId;
    const merchant = Effect.fn("Stripe.merchant")(function* () {
      const account = yield* call("account", () => stripe.accounts.retrieve(null));
      if (account.id !== config.accountId)
        return yield* Model.unavailable("stripe.account_mismatch");
    });
    const pricePlan = (priceId: string) =>
      B.Plan.literals.find((plan) => config.prices[plan] === priceId);
    // A subscription that ended on an earlier TalkTo Price cannot be migrated to the
    // configured one. Its plan is read from the Price's own metadata only to record the end.
    const endedPlan = (price: Stripe.Price) =>
      price.metadata.app === "talkto" && price.metadata.environment === config.environment
        ? B.Plan.literals.find((plan) => price.metadata.plan === plan)
        : undefined;
    // Stripe's test-mode retention policy deletes a subscription and its invoices 30 days
    // after it ends, without a webhook. Live subscriptions are never deleted, so a missing
    // one there stays a failure.
    const recorded = Effect.fn("Stripe.recordedSubscription")(function* (
      operation: string,
      subscriptionId: string,
    ) {
      const found = yield* call(operation, () =>
        stripe.subscriptions.retrieve(subscriptionId),
      ).pipe(Effect.result);
      if (Result.isSuccess(found)) return found.success;
      if (
        !config.live &&
        found.failure.provider?.status === 404 &&
        found.failure.provider.code === "resource_missing"
      )
        return undefined;
      return yield* found.failure;
    });
    const checkPrice = Effect.fn("Stripe.price")(function* (plan: B.Plan) {
      const price = yield* call("price", () => stripe.prices.retrieve(config.prices[plan]));
      if (
        !price.active ||
        price.livemode !== config.live ||
        price.currency !== "usd" ||
        price.unit_amount !== B.plans[plan].monthlyCents ||
        price.recurring?.interval !== "month" ||
        price.recurring.interval_count !== 1 ||
        price.recurring.usage_type !== "licensed" ||
        price.metadata.app !== "talkto" ||
        price.metadata.environment !== config.environment ||
        price.metadata.plan !== plan ||
        price.metadata.plan_version !== B.planVersion
      )
        return yield* Model.unavailable("stripe.price_mismatch");
    });
    const recoverCustomer = Effect.fn("Stripe.recoverCustomer")(function* (
      workspace: Model.Workspace,
      operation: Model.Operation,
    ) {
      const found = yield* call("customers.recover", () =>
        stripe.customers.list({
          limit: 100,
          created: { gte: Math.floor(operation.createdAt / 1000) },
        }),
      );
      const matches = found.data.filter(
        (value) =>
          value.livemode === config.live &&
          owns(value.metadata, workspace.accountId) &&
          value.metadata.operation_id === operation.id,
      );
      if (found.has_more || matches.length !== 1 || matches[0] === undefined)
        return yield* Model.unavailable("stripe.customer_recovery_required");
      return matches[0];
    });
    const recoverSession = Effect.fn("Stripe.recoverSession")(function* (
      operation: Model.Operation,
    ) {
      const sessions = yield* call("checkout.recover", () =>
        stripe.checkout.sessions.list({ customer: operation.customerId ?? "", limit: 100 }),
      );
      const matches = sessions.data.filter(
        (value) =>
          value.client_reference_id === operation.id && owns(value.metadata, operation.accountId),
      );
      if (sessions.has_more || matches.length !== 1 || matches[0] === undefined)
        return yield* Model.unavailable("stripe.checkout_recovery_required");
      return matches[0];
    });
    const customer = Effect.fn("Stripe.customer")(function* (
      workspace: Model.Workspace,
      operation: Model.Operation,
    ) {
      yield* merchant();
      if (workspace.customerId !== null) {
        const value = yield* call("customer", () =>
          stripe.customers.retrieve(workspace.customerId ?? ""),
        );
        if (
          value.deleted ||
          value.livemode !== config.live ||
          !owns(value.metadata, workspace.accountId)
        )
          return yield* Model.unavailable("stripe.customer_mismatch");
        return value.id;
      }
      const elapsed = DateTime.toEpochMillis(yield* DateTime.now) - operation.createdAt;
      if (elapsed >= 23 * 3600000) {
        // After provider idempotency retention, absence from a bounded scan is not permission to create again.
        return (yield* recoverCustomer(workspace, operation)).id;
      }
      const created = yield* call("customer.create", () =>
        stripe.customers.create(
          { metadata: { ...metadata(workspace.accountId), operation_id: operation.id } },
          { idempotencyKey: `talkto:${scope(config)}:customer:${operation.id}` },
        ),
      ).pipe(
        // Stripe can cache a 500 after committing the object; replaying the key alone cannot recover it.
        Effect.catch(() => recoverCustomer(workspace, operation)),
      );
      if (created.livemode !== config.live || !owns(created.metadata, workspace.accountId))
        return yield* Model.unavailable("stripe.customer_mismatch");
      return created.id;
    });
    const checkout = Effect.fn("Stripe.checkout")(function* (operation: Model.Operation) {
      if (operation.customerId === null) return yield* Model.unavailable("stripe.customer_missing");
      let sessionId = operation.sessionId;
      if (sessionId === null) {
        const elapsed = DateTime.toEpochMillis(yield* DateTime.now) - operation.createdAt;
        if (elapsed >= 23 * 3600000) {
          sessionId = (yield* recoverSession(operation)).id;
        } else {
          yield* checkPrice(operation.plan);
          if (operation.offer === "trial") {
            if (config.trials === null)
              return yield* Model.conflict("Trials are not available right now.");
            const methods = yield* call("trial.payment_configuration", () =>
              stripe.paymentMethodConfigurations.retrieve(
                config.trials?.paymentConfiguration ?? "",
              ),
            );
            const enabledMethod = Schema.is(
              Schema.Struct({ display_preference: Schema.Struct({ value: Schema.Literal("on") }) }),
            );
            if (
              !methods.active ||
              methods.livemode !== config.live ||
              !methods.card?.available ||
              methods.card.display_preference.value !== "on" ||
              Object.entries(methods).some(
                ([name, method]) => name !== "card" && enabledMethod(method),
              )
            )
              return yield* Model.unavailable("trial.card_configuration");
          }
          const tags = { ...metadata(operation.accountId), operation_id: operation.id };
          const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
            metadata: tags,
          };
          const params: Stripe.Checkout.SessionCreateParams = {
            mode: "subscription",
            customer: operation.customerId,
            client_reference_id: operation.id,
            line_items: [{ price: config.prices[operation.plan], quantity: 1 }],
            metadata: tags,
            subscription_data: subscriptionData,
            success_url: `${config.origin}/app/accounts/${operation.accountId}/billing?billing=return`,
            cancel_url: `${config.origin}/app/accounts/${operation.accountId}/billing?billing=cancel`,
            expires_at: Math.floor(operation.createdAt / 1000) + 86400,
            integration_identifier: "talkto_checkout_qmktzvpa",
            // Saved on the Customer so tax can be turned on later. Automatic tax stays off:
            // prices do not include tax.
            billing_address_collection: "required",
            customer_update: { address: "auto", name: "auto" },
          };
          if (operation.offer === "trial" && config.trials !== null) {
            subscriptionData.trial_period_days = 7;
            subscriptionData.trial_settings = {
              end_behavior: { missing_payment_method: "cancel" },
            };
            params.payment_method_collection = "always";
            params.payment_method_configuration = config.trials.paymentConfiguration;
            params.custom_text = {
              submit: {
                message: `7 days and 500 messages, then $${B.plans[operation.plan].monthlyCents / 100}/month unless canceled in TalkTo Billing. No automatic early charge at the message limit.`,
              },
            };
          }
          const session = yield* call("checkout.create", () =>
            stripe.checkout.sessions.create(params, {
              idempotencyKey: `talkto:${scope(config)}:checkout:${operation.id}`,
            }),
          ).pipe(Effect.catch(() => recoverSession(operation)));
          sessionId = session.id;
        }
      }
      const session = yield* call("checkout.retrieve", () =>
        stripe.checkout.sessions.retrieve(sessionId),
      );
      if (
        session.livemode !== config.live ||
        id(session.customer) !== operation.customerId ||
        session.client_reference_id !== operation.id ||
        !owns(session.metadata, operation.accountId) ||
        session.mode !== "subscription"
      )
        return yield* Model.unavailable("stripe.checkout_mismatch");
      const subscriptionId = id(session.subscription);
      if (session.status === "complete" && subscriptionId === null)
        return yield* Model.unavailable("stripe.subscription_pending");
      if (session.status === "complete" || session.status === "expired")
        return {
          id: session.id,
          subscriptionId,
          result: { status: session.status === "complete" ? "complete" : "expired" },
        } satisfies Model.Session;
      if (
        session.status !== "open" ||
        session.url === null ||
        !URL.canParse(session.url) ||
        new URL(session.url).protocol !== "https:"
      )
        return yield* Model.unavailable("stripe.checkout_url");
      return {
        id: session.id,
        subscriptionId,
        result: { status: "open", url: session.url, expiresAt: timestamp(session.expires_at) },
      } satisfies Model.Session;
    });
    const periods = Effect.fn("Stripe.invoice")(function* (
      invoice: Stripe.Invoice,
      workspace: Model.Workspace,
      subscription: Stripe.Subscription,
    ) {
      const subscriptionId = subscription.id;
      if (
        invoice.livemode !== config.live ||
        id(invoice.customer) !== workspace.customerId ||
        id(invoice.parent?.subscription_details?.subscription ?? null) !== subscriptionId
      )
        return yield* Model.unavailable("stripe.invoice_mismatch");
      const result: Model.Period[] = [];
      const changes: Model.PlanChange[] = [];
      if (
        invoice.status !== "paid" ||
        !["subscription_create", "subscription_cycle", "subscription_update"].includes(
          invoice.billing_reason ?? "",
        )
      )
        return { periods: result, changes };
      if (invoice.lines.has_more) return yield* Model.unavailable("stripe.invoice_lines_overflow");
      // Trial dates remain trial evidence after conversion; nothing inside them is paid.
      const inTrial = (period: Stripe.InvoiceLineItem["period"]) =>
        subscription.status === "trialing" ||
        (subscription.trial_start != null &&
          subscription.trial_end != null &&
          period.start < subscription.trial_end &&
          period.end > subscription.trial_start);
      if (invoice.billing_reason === "subscription_update") {
        // A paid upgrade (proration "always_invoice") is one invoice with exactly
        // two proration lines over the rest of the period: a credit for the old plan and a charge
        // for the new one. Anything else, including a downgrade, grants nothing here.
        const prorations = invoice.lines.data.flatMap((line) => {
          const details = line.parent?.subscription_item_details;
          const plan = pricePlan(id(line.pricing?.price_details?.price ?? null) ?? "");
          return details?.proration === true &&
            details.subscription === subscriptionId &&
            plan !== undefined &&
            line.quantity === 1 &&
            line.currency === "usd"
            ? [{ line, plan }]
            : [];
        });
        const charge = prorations.filter(({ line }) => line.amount > 0);
        const credit = prorations.filter(({ line }) => line.amount < 0);
        const to = charge[0];
        const from = credit[0];
        if (
          prorations.length === 2 &&
          to !== undefined &&
          from !== undefined &&
          to.line.period.start === from.line.period.start &&
          to.line.period.end === from.line.period.end &&
          to.line.period.end > to.line.period.start &&
          Model.upgrades(from.plan, to.plan) &&
          !inTrial(to.line.period)
        )
          changes.push({
            subscriptionId,
            invoiceId: invoice.id,
            lineId: to.line.id,
            from: from.plan,
            plan: to.plan,
            at: timestamp(to.line.period.start),
            end: timestamp(to.line.period.end),
          });
      }
      for (const line of invoice.lines.data) {
        // Early trial conversion produces subscription_update. Only its regular
        // subscription line grants capacity; prorations and trial dates do not.
        const details = line.parent?.subscription_item_details;
        const plan = pricePlan(id(line.pricing?.price_details?.price ?? null) ?? "");
        if (
          plan === undefined ||
          details === null ||
          details === undefined ||
          details.proration ||
          details.subscription !== subscriptionId ||
          line.quantity !== 1 ||
          line.currency !== "usd"
        )
          continue;
        if (line.period.end <= line.period.start)
          return yield* Model.unavailable("stripe.invoice_period");
        // A zero-dollar trial invoice can be marked paid. Its dates remain trial
        // evidence after conversion, so checking only the current status is unsafe.
        // Amount is deliberately not used: discounted paid renewals are valid.
        if (inTrial(line.period)) continue;
        result.push({
          plan,
          planVersion: B.planVersion,
          start: timestamp(line.period.start),
          end: timestamp(line.period.end),
          allowance: B.plans[plan].messages,
          invoiceId: invoice.id,
          lineId: line.id,
          subscriptionId,
        });
      }
      return { periods: result, changes };
    });
    const scopedSubscription = Effect.fn("Stripe.scopedSubscription")(function* (
      workspace: Model.Workspace,
    ) {
      if (workspace.subscriptionId === null)
        return yield* Model.conflict("No subscription is available to manage.");
      const subscription = yield* call("subscription.retrieve", () =>
        stripe.subscriptions.retrieve(workspace.subscriptionId ?? ""),
      );
      if (
        subscription.livemode !== config.live ||
        id(subscription.customer) !== workspace.customerId ||
        !owns(subscription.metadata, workspace.accountId)
      )
        return yield* Model.unavailable("stripe.subscription_mismatch");
      return subscription;
    });
    // A downgrade is a subscription schedule on the TalkTo subscription. It must belong to the same
    // customer and mode; anything else attached to the subscription is a configuration error.
    const ownedSchedule = (
      schedule: Stripe.SubscriptionSchedule,
      subscription: Stripe.Subscription,
    ) =>
      schedule.livemode === config.live &&
      id(schedule.customer) === id(subscription.customer) &&
      id(schedule.subscription) === subscription.id;
    const subscriptionSchedule = Effect.fn("Stripe.subscriptionSchedule")(function* (
      subscription: Stripe.Subscription,
    ) {
      const scheduleId = id(subscription.schedule ?? null);
      if (scheduleId === null) return null;
      const schedule = yield* call("subscription.schedule", () =>
        stripe.subscriptionSchedules.retrieve(scheduleId),
      );
      if (schedule.status !== "active" && schedule.status !== "not_started") return null;
      if (!ownedSchedule(schedule, subscription))
        return yield* Model.unavailable("stripe.schedule_mismatch");
      return schedule;
    });
    // TalkTo schedules a downgrade as a next phase that starts when the current period ends.
    // Only a next phase on one configured Price is reported.
    const scheduledChange = (
      schedule: Stripe.SubscriptionSchedule | null,
      item: Stripe.SubscriptionItem,
      plan: B.Plan,
    ) => {
      const next = schedule?.phases.find((phase) => phase.start_date === item.current_period_end);
      const nextItem = next?.items[0];
      if (next === undefined || nextItem === undefined || next.items.length !== 1) return undefined;
      const nextPlan = pricePlan(id(nextItem.price) ?? "");
      if (nextPlan === undefined || nextPlan === plan || (nextItem.quantity ?? 1) !== 1)
        return undefined;
      return { plan: nextPlan, at: timestamp(next.start_date) };
    };
    // A subscription with a scheduled change is managed by its schedule: Stripe refuses some
    // direct changes until it is released. Releasing keeps the current plan and price.
    const releaseSchedule = Effect.fn("Stripe.releaseSchedule")(function* (
      subscription: Stripe.Subscription,
      idempotencyKey: string,
    ) {
      const scheduleId = id(subscription.schedule ?? null);
      if (scheduleId === null) return;
      yield* call("subscription.schedule_release", () =>
        stripe.subscriptionSchedules.release(scheduleId, {}, { idempotencyKey }),
      );
    });
    // The single licensed item on a configured Price; plan changes touch nothing else.
    const planItem = (subscription: Stripe.Subscription) => {
      const item = subscription.items.data[0];
      const plan = item === undefined ? undefined : pricePlan(item.price.id);
      return item === undefined ||
        plan === undefined ||
        subscription.items.data.length !== 1 ||
        subscription.items.has_more ||
        item.quantity !== 1
        ? undefined
        : { item, plan };
    };
    const confirmMutation = Effect.fn("Stripe.confirmMutation")(function* (
      workspace: Model.Workspace,
      mutation: Result.Result<Stripe.Subscription, Model.Failure>,
      pending: string,
      matches: (subscription: Stripe.Subscription) => boolean,
    ) {
      const observed = yield* scopedSubscription(workspace).pipe(Effect.result);
      if (Result.isFailure(observed)) {
        if (Result.isSuccess(mutation)) return yield* observed.failure;
        const recovery = { operation: observed.failure.operation };
        const failure = {
          code: mutation.failure.code,
          operation: mutation.failure.operation,
          message: mutation.failure.message,
          recovery:
            observed.failure.provider === undefined
              ? recovery
              : { ...recovery, provider: observed.failure.provider },
        };
        return yield* new Model.Failure(
          mutation.failure.provider === undefined
            ? failure
            : { ...failure, provider: mutation.failure.provider },
        );
      }
      if (matches(observed.success)) return;
      return yield* Result.isFailure(mutation) ? mutation.failure : Model.unavailable(pending);
    });
    return Billing.Payments.of({
      customer,
      checkout,
      renewal: Effect.fn("Stripe.renewal")(function* (workspace, input) {
        yield* merchant();
        const subscription = yield* scopedSubscription(workspace);
        if (!["active", "trialing", "past_due"].includes(subscription.status))
          return yield* Model.conflict("This subscription cannot change its renewal setting.");
        if (subscription.cancel_at_period_end === input.cancel) return;
        // Canceling renewal also drops a scheduled plan change; nothing renews to take it.
        if (input.cancel)
          yield* releaseSchedule(
            subscription,
            `talkto:${scope(config)}:renewal-release:${workspace.accountId}:${input.requestKey}`,
          );
        const mutation = yield* call("subscription.renewal", () =>
          stripe.subscriptions.update(
            subscription.id,
            { cancel_at_period_end: input.cancel },
            {
              idempotencyKey: `talkto:${scope(config)}:renewal:${workspace.accountId}:${input.requestKey}`,
            },
          ),
        ).pipe(Effect.result);
        yield* confirmMutation(
          workspace,
          mutation,
          "stripe.renewal_pending",
          (current) => current.cancel_at_period_end === input.cancel,
        );
      }),
      endTrial: Effect.fn("Stripe.endTrial")(function* (workspace, requestKey, cancel) {
        yield* merchant();
        const subscription = yield* scopedSubscription(workspace);
        if (subscription.status !== "trialing") return;
        const options = {
          idempotencyKey: `talkto:${scope(config)}:trial:${cancel ? "reject" : "convert"}:${workspace.accountId}:${requestKey}`,
        };
        const mutation = yield* (
          cancel
            ? call("trial.reject", () =>
                stripe.subscriptions.cancel(
                  subscription.id,
                  { invoice_now: false, prorate: false },
                  options,
                ),
              )
            : call("trial.convert", () =>
                stripe.subscriptions.update(
                  subscription.id,
                  {
                    trial_end: "now",
                    cancel_at_period_end: false,
                    proration_behavior: "none",
                    payment_behavior: "allow_incomplete",
                  },
                  options,
                ),
              )
        ).pipe(Effect.result);
        yield* confirmMutation(
          workspace,
          mutation,
          "stripe.trial_change_pending",
          (current) => current.status !== "trialing" && (!cancel || current.status === "canceled"),
        );
      }),
      cancel: Effect.fn("Stripe.cancel")(function* (workspace, requestKey) {
        yield* merchant();
        const subscription = yield* scopedSubscription(workspace);
        const ended = (current: Stripe.Subscription) =>
          current.status === "canceled" || current.status === "incomplete_expired";
        if (ended(subscription)) return;
        yield* releaseSchedule(
          subscription,
          `talkto:${scope(config)}:cancel-release:${workspace.accountId}:${requestKey}`,
        );
        const mutation = yield* call("subscription.cancel", () =>
          stripe.subscriptions.cancel(
            subscription.id,
            { invoice_now: false, prorate: false },
            {
              idempotencyKey: `talkto:${scope(config)}:cancel:${workspace.accountId}:${requestKey}`,
            },
          ),
        ).pipe(Effect.result);
        yield* confirmMutation(workspace, mutation, "stripe.cancel_pending", ended);
      }),
      expireCheckout: Effect.fn("Stripe.expireCheckout")(function* (operation) {
        if (operation.sessionId === null)
          return yield* Model.unavailable("stripe.checkout_missing");
        const current = yield* checkout(operation);
        if (current.result.status !== "open") return current;
        const expiration = yield* call("checkout.expire", () =>
          stripe.checkout.sessions.expire(
            current.id,
            {},
            { idempotencyKey: `talkto:${scope(config)}:expire:${operation.id}` },
          ),
        ).pipe(Effect.result);
        // A lost response or a simultaneous payment can reject expiration. Read the
        // scoped session again; only Stripe's terminal state confirms the outcome.
        const observed = yield* checkout(operation);
        if (observed.result.status === "open")
          return yield* expiration._tag === "Failure"
            ? expiration.failure
            : Model.unavailable("stripe.checkout_expiration_pending");
        return observed;
      }),
      observe: Effect.fn("Stripe.observe")(function* (workspace) {
        if (workspace.customerId === null)
          return yield* Model.unavailable("stripe.customer_missing");
        const subscriptions = yield* call("subscriptions", () =>
          stripe.subscriptions.list({
            customer: workspace.customerId ?? "",
            status: "all",
            limit: 100,
          }),
        );
        if (subscriptions.has_more) return yield* Model.unavailable("stripe.subscription_overflow");
        const owned = subscriptions.data.filter(
          (value) => value.livemode === config.live && owns(value.metadata, workspace.accountId),
        );
        const current = owned.filter(
          (value) => value.status !== "canceled" && value.status !== "incomplete_expired",
        );
        if (current.length > 1) return yield* Model.unavailable("stripe.multiple_subscriptions");
        let subscription =
          current[0] ?? owned.find((value) => value.id === workspace.subscriptionId);
        if (subscription === undefined && workspace.subscriptionId !== null)
          subscription = yield* recorded("subscription.retrieve", workspace.subscriptionId);
        subscription ??= owned[0];
        if (subscription === undefined)
          return {
            subscriptionId: null,
            subscription: null,
            periods: [],
            changes: [],
            invoiceCursor: null,
            trial: null,
            charges: [],
          };
        if (
          subscription.livemode !== config.live ||
          id(subscription.customer) !== workspace.customerId ||
          !owns(subscription.metadata, workspace.accountId)
        )
          return yield* Model.unavailable("stripe.subscription_mismatch");
        const item = subscription.items.data[0];
        const configured = item === undefined ? undefined : pricePlan(item.price.id);
        const ended =
          subscription.status === "canceled" || subscription.status === "incomplete_expired";
        // Invoice lines still match configured Price IDs only, so an earlier Price grants nothing.
        const plan =
          configured ?? (ended && item !== undefined ? endedPlan(item.price) : undefined);
        if (
          plan === undefined ||
          item === undefined ||
          subscription.items.data.length !== 1 ||
          subscription.items.has_more ||
          item.quantity !== 1 ||
          item.price.currency !== "usd" ||
          (configured !== undefined && item.price.unit_amount !== B.plans[plan].monthlyCents) ||
          item.price.recurring?.interval !== "month" ||
          item.price.recurring.interval_count !== 1
        )
          return yield* Model.unavailable("stripe.subscription_mismatch");
        const latestId = id(subscription.latest_invoice);
        const latest =
          latestId === null
            ? null
            : yield* call("invoice.latest", () => stripe.invoices.retrieve(latestId));
        const first =
          latest === null
            ? { periods: [], changes: [] }
            : yield* periods(latest, workspace, subscription);
        const paid = [...first.periods];
        const changes = [...first.changes];
        const query: Stripe.InvoiceListParams = {
          customer: workspace.customerId,
          status: "paid",
          limit: 50,
        };
        if (workspace.invoiceCursor !== null) query.starting_after = workspace.invoiceCursor;
        const invoices = yield* call("invoices", () => stripe.invoices.list(query));
        for (const invoice of invoices.data) {
          const previous = invoice.parent?.subscription_details;
          const previousId = id(previous?.subscription ?? null);
          if (previousId !== null && owns(previous?.metadata ?? null, workspace.accountId)) {
            const source =
              previousId === subscription.id
                ? subscription
                : (owned.find((value) => value.id === previousId) ??
                  (yield* recorded("subscription.history", previousId)));
            if (source === undefined) continue;
            if (
              source.livemode !== config.live ||
              id(source.customer) !== workspace.customerId ||
              !owns(source.metadata, workspace.accountId)
            )
              return yield* Model.unavailable("stripe.subscription_mismatch");
            const found = yield* periods(invoice, workspace, source);
            paid.push(...found.periods);
            changes.push(...found.changes);
          }
        }
        const change = ended
          ? undefined
          : scheduledChange(yield* subscriptionSchedule(subscription), item, plan);
        const reported = yield* Schema.decodeUnknownEffect(B.Subscription)({
          plan,
          status: subscription.status,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          payment: latest === null ? "pending" : latest.status === "paid" ? "paid" : "unpaid",
        }).pipe(Effect.mapError(() => Model.unavailable("stripe.subscription_status")));
        const observed: typeof B.Subscription.Type =
          change === undefined ? reported : { ...reported, change };
        let trial: Model.TrialObservation | null = null;
        if (
          subscription.status === "trialing" &&
          subscription.trial_start != null &&
          subscription.trial_end != null
        ) {
          let cardKey: string | null = null;
          const paymentMethodId = id(subscription.default_payment_method ?? null);
          if (config.trials !== null && paymentMethodId !== null) {
            const method = yield* call("trial.payment_method", () =>
              stripe.paymentMethods.retrieve(paymentMethodId),
            );
            if (
              method.livemode === config.live &&
              id(method.customer) === workspace.customerId &&
              method.type === "card" &&
              method.card?.fingerprint &&
              method.card.funding !== "prepaid"
            )
              cardKey = yield* TrialPolicy.claimKey(
                config.trials.secret,
                scope(config),
                `card:${method.card.fingerprint}`,
              );
          }
          trial = {
            subscriptionId: subscription.id,
            operationId: subscription.metadata.operation_id ?? "",
            start: timestamp(subscription.trial_start),
            end: timestamp(subscription.trial_end),
            cardKey,
          };
        }
        return {
          subscriptionId: subscription.id,
          subscription: observed,
          periods: paid,
          changes,
          invoiceCursor: invoices.has_more ? (invoices.data.at(-1)?.id ?? null) : null,
          trial,
          charges: [],
        };
      }),
      charges: Effect.fn("Stripe.charges")(function* (workspace, chargeIds) {
        const reviews: Model.ChargeReview[] = [];
        for (const chargeId of chargeIds) {
          // A charge Stripe no longer knows must not hold up this organization's reconciliation.
          const charge = yield* call("charge.retrieve", () =>
            stripe.charges.retrieve(chargeId),
          ).pipe(
            Effect.catchIf(
              (error) => error.provider?.code === "resource_missing",
              () => Effect.succeed(null),
            ),
          );
          // Another customer's or environment's charge changes nothing here.
          if (
            charge === null ||
            charge.livemode !== config.live ||
            id(charge.customer) !== workspace.customerId
          )
            continue;
          const intent = id(charge.payment_intent);
          if (intent === null) {
            reviews.push({ chargeId, invoiceId: null, reason: null });
            continue;
          }
          const payments = yield* call("invoice_payments", () =>
            stripe.invoicePayments.list({
              payment: { type: "payment_intent", payment_intent: intent },
              limit: 10,
            }),
          );
          const invoiceId = id(
            payments.data.find((value) => value.status === "paid")?.invoice ?? null,
          );
          let disputed = false;
          if (charge.disputed) {
            const disputes = yield* call("disputes", () =>
              stripe.disputes.list({ charge: chargeId, limit: 10 }),
            );
            disputed = disputes.data.some((dispute) => !settledDisputes.has(dispute.status));
          }
          reviews.push({
            chargeId,
            invoiceId,
            // A full refund is final; a partial one is a courtesy credit and keeps the plan.
            reason: charge.refunded ? "refund" : disputed ? "dispute" : null,
          });
        }
        return reviews;
      }),
      portal: Effect.fn("Stripe.portal")(function* (customerId, accountId) {
        yield* merchant();
        // Payment method, billing details and invoices only. TalkTo's Billing page owns renewal
        // and plan changes, so the portal must not cancel or switch plans.
        const portal = yield* call("portal.configuration", () =>
          stripe.billingPortal.configurations.retrieve(config.portalId),
        );
        if (
          !portal.active ||
          portal.livemode !== config.live ||
          portal.metadata?.app !== "talkto" ||
          portal.metadata.environment !== config.environment ||
          portal.features.subscription_cancel.enabled ||
          portal.features.subscription_update.enabled
        )
          return yield* Model.unavailable("stripe.portal_configuration");
        const value = yield* call("portal.create", () =>
          stripe.billingPortal.sessions.create({
            customer: customerId,
            configuration: config.portalId,
            return_url: `${config.origin}/app/accounts/${accountId}/billing`,
          }),
        );
        return value.url;
      }),
      changePlan: Effect.fn("Stripe.changePlan")(function* (workspace, input) {
        yield* merchant();
        const subscription = yield* scopedSubscription(workspace);
        if (subscription.status !== "active")
          return yield* Model.conflict("Only an active, paid subscription can change plan.");
        if (subscription.cancel_at_period_end)
          return yield* Model.conflict("Resume renewal before changing plan.");
        const current = planItem(subscription);
        if (current === undefined) return yield* Model.unavailable("stripe.subscription_mismatch");
        const { item, plan } = current;
        const schedule = yield* subscriptionSchedule(subscription);
        const key = (step: string) =>
          `talkto:${scope(config)}:plan-${step}:${workspace.accountId}:${input.requestKey}`;
        if (input.plan === plan) {
          // Already on this plan, as after a retried upgrade. Only a scheduled move is dropped.
          if (schedule === null) return;
          const kept = yield* releaseSchedule(subscription, key("keep")).pipe(
            Effect.as(subscription),
            Effect.result,
          );
          return yield* confirmMutation(
            workspace,
            kept,
            "stripe.keep_plan_pending",
            (value) => id(value.schedule ?? null) === null,
          );
        }
        yield* checkPrice(input.plan);
        const price = config.prices[input.plan];
        if (Model.upgrades(plan, input.plan)) {
          // The upgrade replaces a scheduled downgrade, which would otherwise undo it at renewal.
          if (schedule !== null) yield* releaseSchedule(subscription, key("upgrade-release"));
          // Stripe invoices the prorated difference now and must collect it in this request.
          // A decline or a card that needs authentication rejects the update: nothing changes.
          const upgraded = yield* call("subscription.upgrade", () =>
            stripe.subscriptions.update(
              subscription.id,
              {
                items: [{ id: item.id, price, quantity: 1 }],
                proration_behavior: "always_invoice",
                payment_behavior: "error_if_incomplete",
              },
              { idempotencyKey: key(`upgrade-${input.plan}`) },
            ),
          ).pipe(Effect.result);
          if (
            Result.isFailure(upgraded) &&
            (upgraded.failure.provider?.type === "StripeCardError" ||
              upgraded.failure.provider?.status === 402)
          )
            return yield* Model.conflict(
              "The upgrade payment did not go through, so the plan did not change. Update the card in Payment details, then try again.",
            );
          return yield* confirmMutation(
            workspace,
            upgraded,
            "stripe.upgrade_pending",
            (value) => planItem(value)?.plan === input.plan,
          );
        }
        // A smaller plan starts at the next renewal: the current phase ends with the period, and
        // the schedule releases the subscription one month into the new plan.
        if (scheduledChange(schedule, item, plan)?.plan === input.plan) return;
        const managed =
          schedule ??
          (yield* call("subscription.schedule_create", () =>
            stripe.subscriptionSchedules.create(
              { from_subscription: subscription.id },
              { idempotencyKey: key(`schedule-${input.plan}`) },
            ),
          ));
        const phaseStart = managed.current_phase?.start_date;
        if (!ownedSchedule(managed, subscription) || phaseStart === undefined)
          return yield* Model.unavailable("stripe.schedule_mismatch");
        // Stripe unsets phase settings an update leaves out. TalkTo sets no discounts, tax rates or
        // trials on paid subscriptions; its ownership metadata is carried into both phases.
        const tags = { ...subscription.metadata };
        const scheduled = yield* call("subscription.schedule_downgrade", () =>
          stripe.subscriptionSchedules.update(
            managed.id,
            {
              end_behavior: "release",
              proration_behavior: "none",
              metadata: metadata(workspace.accountId),
              phases: [
                {
                  items: [{ price: item.price.id, quantity: 1 }],
                  start_date: phaseStart,
                  end_date: item.current_period_end,
                  metadata: tags,
                  proration_behavior: "none",
                },
                {
                  items: [{ price, quantity: 1 }],
                  duration: { interval: "month", interval_count: 1 },
                  metadata: tags,
                  proration_behavior: "none",
                },
              ],
            },
            { idempotencyKey: key(`downgrade-${input.plan}`) },
          ),
        ).pipe(Effect.result);
        const observed = yield* scopedSubscription(workspace).pipe(
          Effect.flatMap((value) =>
            subscriptionSchedule(value).pipe(
              Effect.map((found) => {
                const now = planItem(value);
                return (
                  now !== undefined &&
                  scheduledChange(found, now.item, now.plan)?.plan === input.plan
                );
              }),
            ),
          ),
          Effect.result,
        );
        if (Result.isSuccess(observed) && observed.success) return;
        return yield* Result.isFailure(scheduled)
          ? scheduled.failure
          : Result.isFailure(observed)
            ? observed.failure
            : Model.unavailable("stripe.downgrade_pending");
      }),
      keepPlan: Effect.fn("Stripe.keepPlan")(function* (workspace, requestKey) {
        yield* merchant();
        const subscription = yield* scopedSubscription(workspace);
        const mutation = yield* releaseSchedule(
          subscription,
          `talkto:${scope(config)}:keep-plan:${workspace.accountId}:${requestKey}`,
        ).pipe(Effect.as(subscription), Effect.result);
        yield* confirmMutation(
          workspace,
          mutation,
          "stripe.keep_plan_pending",
          (current) => id(current.schedule ?? null) === null,
        );
      }),
      verify: Effect.fn("Stripe.webhook")(function* (body, signature) {
        const raw = yield* Effect.tryPromise({
          try: () =>
            stripe.webhooks.constructEventAsync(
              body,
              signature,
              Redacted.value(config.webhookSecret),
              undefined,
              Stripe.createSubtleCryptoProvider(),
            ),
          catch: () =>
            new Model.Failure({
              code: "invalid_input",
              operation: "stripe.signature",
              message: "Invalid Stripe webhook signature or payload.",
            }),
        });
        if (!eventTypes.has(raw.type)) return null;
        const event = yield* Schema.decodeUnknownEffect(verifiedEvent)(raw).pipe(
          Effect.mapError(() => Model.unavailable("stripe.event_contract")),
        );
        if (
          event.livemode !== config.live ||
          (event.account !== undefined && event.account !== config.accountId)
        )
          return yield* new Model.Failure({
            code: "invalid_input",
            operation: "stripe.event_scope",
            message: "The Stripe event belongs to another environment.",
          });
        const object = event.data.object;
        if (disputeEvents.has(event.type)) {
          const chargeId = id(object.charge ?? null);
          if (chargeId === null) return null;
          const charge = yield* call("charge.retrieve", () => stripe.charges.retrieve(chargeId));
          const customerId = charge.livemode === config.live ? id(charge.customer) : null;
          return customerId === null
            ? null
            : { id: event.id, type: event.type, customerId, chargeId };
        }
        const customerId = id(object.customer ?? null);
        const chargeId = chargeEvents.has(event.type) ? (object.id ?? null) : null;
        return customerId === null
          ? null
          : { id: event.id, type: event.type, customerId, chargeId };
      }),
    });
  });
