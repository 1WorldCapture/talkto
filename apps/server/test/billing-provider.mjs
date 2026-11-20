import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";

/** Controlled Stripe HTTP boundary; the application still uses the real SDK, signatures, Worker and D1. */
export function provider() {
  const customers = new Map();
  const sessions = new Map();
  const subscriptions = new Map();
  const invoices = new Map();
  const paymentMethods = new Map();
  const schedules = new Map();
  // Charges for paid invoices, created on demand by `charge()`, with their disputes.
  const charges = new Map();
  const disputes = new Map();
  const idempotency = new Map();
  const cachedErrors = new Set();
  const requests = [];
  const control = {
    lose: null,
    hold: null,
    down: false,
    accountId: "acct_talkto",
    portalUpdates: false,
    // The card on file declines the next upgrade payment.
    declineUpgrade: false,
    hideSubscriptions: false,
    recoveryDown: false,
    cacheError: null,
    expireDown: false,
    completeOnExpire: false,
    expireHold: null,
    fingerprint: "card_unique_test",
    funding: "credit",
    cardAvailable: true,
    conversionPaid: true,
    subscriptionDenied: false,
    subscriptionRefetchDown: false,
    chargesDenied: false,
  };
  let deniedSubscriptionWrite = false;
  const prices = Object.fromEntries(
    Object.entries({ shop: 1200, studio: 6000, factory: 15000 }).map(([plan, amount]) => [
      `price_${plan}`,
      {
        id: `price_${plan}`,
        active: true,
        livemode: false,
        currency: "usd",
        unit_amount: amount,
        metadata: { app: "talkto", environment: "test", plan, plan_version: "2026-11-11" },
        recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
      },
    ]),
  );
  const list = (data) => Response.json({ object: "list", data, has_more: false });
  const handler = async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const input = new URLSearchParams(request.method === "POST" ? await request.text() : "");
    const key = request.headers.get("idempotency-key");
    requests.push({ method: request.method, path, input, key });
    assert.equal(request.headers.get("stripe-version"), "2026-08-26.dahlia");
    if (control.down)
      return Response.json(
        { error: { type: "api_error", message: "Unavailable" } },
        { status: 503 },
      );
    if (path === "/v1/account") return Response.json({ id: control.accountId });
    if (path === "/v1/payment_method_configurations/pmc_trial")
      return Response.json({
        id: "pmc_trial",
        active: true,
        livemode: false,
        card: { available: control.cardAvailable, display_preference: { value: "on" } },
        link: { available: true, display_preference: { value: "off" } },
      });
    if (path.startsWith("/v1/payment_methods/"))
      return Response.json(paymentMethods.get(path.split("/").at(-1)));
    if (
      control.recoveryDown &&
      request.method === "GET" &&
      ["/v1/customers", "/v1/checkout/sessions"].includes(path)
    )
      return Response.json(
        { error: { type: "api_error", message: "Lookup unavailable" } },
        { status: 503 },
      );
    if (path.startsWith("/v1/prices/")) return Response.json(prices[path.split("/").at(-1)]);
    if (path === "/v1/billing_portal/configurations/bpc_talkto")
      return Response.json({
        id: "bpc_talkto",
        active: true,
        livemode: false,
        metadata: { app: "talkto", environment: "test" },
        features: {
          subscription_cancel: { enabled: false },
          subscription_update: { enabled: control.portalUpdates },
        },
      });
    if (path === "/v1/billing_portal/sessions") {
      assert.equal(input.get("configuration"), "bpc_talkto");
      assert.ok(customers.has(input.get("customer")));
      return Response.json({ url: "https://billing.stripe.test/session" });
    }
    if (request.method === "POST" && path === "/v1/subscription_schedules") {
      assert.ok(key);
      // Stripe accepts no other parameters together with from_subscription.
      assert.deepEqual([...input.keys()], ["from_subscription"]);
      if (!idempotency.has(key)) {
        const subscription = subscriptions.get(input.get("from_subscription"));
        assert.equal(subscription.schedule, null);
        const item = subscription.items.data[0];
        const phase = { start_date: item.current_period_start, end_date: item.current_period_end };
        const schedule = {
          id: `sub_sched_${randomUUID().replaceAll("-", "")}`,
          customer: subscription.customer,
          livemode: false,
          subscription: subscription.id,
          status: "active",
          metadata: {},
          end_behavior: "release",
          current_phase: phase,
          phases: [{ ...phase, items: [{ price: item.price.id, quantity: 1 }] }],
        };
        schedules.set(schedule.id, schedule);
        subscription.schedule = schedule.id;
        idempotency.set(key, structuredClone(schedule));
      }
      return Response.json(idempotency.get(key));
    }
    if (path.startsWith("/v1/subscription_schedules/")) {
      const parts = path.split("/");
      const schedule = schedules.get(parts[3]);
      if (request.method === "POST" && parts[4] === "release") {
        assert.ok(key);
        schedule.status = "released";
        subscriptions.get(schedule.subscription).schedule = null;
      } else if (request.method === "POST") {
        assert.ok(key);
        assert.equal(schedule.status, "active");
        const subscription = subscriptions.get(schedule.subscription);
        const item = subscription.items.data[0];
        // The current phase is kept as it is and ends with the period; the next starts then.
        assert.equal(input.get("end_behavior"), "release");
        assert.equal(input.get("proration_behavior"), "none");
        assert.equal(Number(input.get("phases[0][start_date]")), schedule.current_phase.start_date);
        assert.equal(Number(input.get("phases[0][end_date]")), item.current_period_end);
        assert.equal(input.get("phases[0][items][0][price]"), item.price.id);
        assert.equal(input.get("phases[0][items][0][quantity]"), "1");
        assert.equal(input.get("phases[1][duration][interval]"), "month");
        assert.equal(input.get("phases[1][duration][interval_count]"), "1");
        assert.equal(input.get("phases[1][items][0][quantity]"), "1");
        assert.equal(input.has("phases[2][items][0][price]"), false);
        // Ownership metadata survives into both phases; Stripe unsets what an update omits.
        for (const phase of [0, 1])
          for (const [name, value] of Object.entries(subscription.metadata))
            assert.equal(input.get(`phases[${phase}][metadata][${name}]`), value);
        const end = item.current_period_end;
        schedule.metadata = Object.fromEntries(
          ["app", "environment", "workspace_id"].map((name) => [
            name,
            input.get(`metadata[${name}]`),
          ]),
        );
        schedule.phases = [
          { ...schedule.current_phase, items: [{ price: item.price.id, quantity: 1 }] },
          {
            start_date: end,
            end_date: end + (item.current_period_end - item.current_period_start),
            items: [{ price: input.get("phases[1][items][0][price]"), quantity: 1 }],
          },
        ];
      }
      return Response.json(schedule);
    }
    if (
      request.method === "POST" &&
      (path === "/v1/customers" || path === "/v1/checkout/sessions")
    ) {
      assert.ok(key);
      if (cachedErrors.has(key))
        return Response.json(
          { error: { type: "api_error", message: "Cached provider failure" } },
          { status: 500 },
        );
      let value = idempotency.get(key);
      if (value === undefined) {
        const metadata = Object.fromEntries(
          ["app", "environment", "workspace_id", "operation_id"].flatMap((name) =>
            input.has(`metadata[${name}]`) ? [[name, input.get(`metadata[${name}]`)]] : [],
          ),
        );
        if (path === "/v1/customers") {
          value = { id: `cus_${randomUUID().replaceAll("-", "")}`, livemode: false, metadata };
          customers.set(value.id, value);
        } else {
          assert.equal(input.get("mode"), "subscription");
          assert.equal(input.get("line_items[0][quantity]"), "1");
          assert.equal(input.has("payment_method_types[0]"), false);
          assert.equal(input.has("automatic_tax[enabled]"), false);
          assert.equal(input.get("billing_address_collection"), "required");
          assert.equal(input.get("customer_update[address]"), "auto");
          assert.equal(input.get("customer_update[name]"), "auto");
          assert.match(input.get("integration_identifier"), /^talkto_checkout_[a-z]{8}$/);
          value = {
            id: `cs_${randomUUID().replaceAll("-", "")}`,
            livemode: false,
            mode: "subscription",
            customer: input.get("customer"),
            client_reference_id: input.get("client_reference_id"),
            metadata,
            url: "https://checkout.stripe.test/session",
            status: "open",
            expires_at: Number(input.get("expires_at")),
            subscription: null,
            testPrice: input.get("line_items[0][price]"),
            testTrialDays: Number(input.get("subscription_data[trial_period_days]")),
          };
          sessions.set(value.id, value);
        }
        idempotency.set(key, value);
        if (control.cacheError === path) {
          cachedErrors.add(key);
          return Response.json(
            { error: { type: "api_error", message: "Cached provider failure" } },
            { status: 500 },
          );
        }
        if (control.hold !== null) {
          const hold = control.hold;
          control.hold = null;
          hold.started.resolve();
          await hold.release.promise;
        }
        if (control.lose === path) {
          control.lose = null;
          return Response.json(
            { error: { type: "api_error", message: "Committed response lost" } },
            { status: 503 },
          );
        }
      }
      return Response.json(value);
    }
    if (path === "/v1/customers") return list([...customers.values()]);
    if (path.startsWith("/v1/customers/"))
      return Response.json(customers.get(path.split("/").at(-1)));
    if (path === "/v1/checkout/sessions")
      return list(
        [...sessions.values()].filter(
          (value) => value.customer === url.searchParams.get("customer"),
        ),
      );
    if (request.method === "POST" && /^\/v1\/checkout\/sessions\/[^/]+\/expire$/.test(path)) {
      const session = sessions.get(path.split("/").at(-2));
      assert.ok(key);
      if (control.expireHold) {
        const hold = control.expireHold;
        control.expireHold = null;
        hold.started.resolve();
        await hold.release.promise;
      }
      if (control.expireDown)
        return Response.json(
          { error: { type: "api_error", message: "Unavailable" } },
          { status: 503 },
        );
      if (control.completeOnExpire) {
        control.completeOnExpire = false;
        complete(session.id);
      }
      if (session.status !== "open")
        return Response.json(
          { error: { type: "invalid_request_error", message: "Session is not open" } },
          { status: 400 },
        );
      session.status = "expired";
      session.url = null;
      if (control.lose === path) {
        control.lose = null;
        return Response.json(
          { error: { type: "api_error", message: "Committed response lost" } },
          { status: 503 },
        );
      }
      return Response.json(session);
    }
    if (path.startsWith("/v1/checkout/sessions/"))
      return Response.json(sessions.get(path.split("/").at(-1)));
    if (path === "/v1/subscriptions")
      return list(
        [...subscriptions.values()]
          .filter((value) => value.customer === url.searchParams.get("customer"))
          .filter(() => !control.hideSubscriptions),
      );
    if (path.startsWith("/v1/subscriptions/")) {
      if (request.method !== "GET" && control.subscriptionDenied) {
        deniedSubscriptionWrite = true;
        return Response.json(
          {
            error: {
              type: "invalid_request_error",
              code: "permission_denied",
              message: "PRIVATE_PROVIDER_DIAGNOSTIC",
            },
          },
          { status: 403, headers: { "request-id": "req_deniedTest123" } },
        );
      }
      if (request.method === "GET" && deniedSubscriptionWrite && control.subscriptionRefetchDown)
        return Response.json(
          { error: { type: "api_error", message: "PRIVATE_RECOVERY_DIAGNOSTIC" } },
          { status: 503, headers: { "request-id": "req_recoveryTest456" } },
        );
      const subscription = subscriptions.get(path.split("/").at(-1));
      // Stripe's test-mode retention policy deletes ended subscriptions without a webhook.
      if (subscription === undefined)
        return Response.json(
          {
            error: {
              type: "invalid_request_error",
              code: "resource_missing",
              message: "No such subscription",
            },
          },
          { status: 404 },
        );
      if (request.method === "DELETE") {
        subscription.status = "canceled";
      } else if (request.method === "POST") {
        assert.ok(key);
        if (input.has("items[0][price]")) {
          // An upgrade with payment now: "error_if_incomplete" rejects the whole update with a
          // 402 when the prorated invoice cannot be paid. Replays return the first reply.
          assert.equal(input.get("items[0][id]"), subscription.items.data[0].id);
          assert.equal(input.get("items[0][quantity]"), "1");
          assert.equal(input.get("proration_behavior"), "always_invoice");
          assert.equal(input.get("payment_behavior"), "error_if_incomplete");
          // TalkTo releases a scheduled downgrade first, or it would undo the upgrade at renewal.
          assert.equal(subscription.schedule, null);
          if (!idempotency.has(key)) {
            if (control.declineUpgrade) {
              idempotency.set(key, {
                status: 402,
                body: {
                  error: {
                    type: "card_error",
                    code: "card_declined",
                    message: "PRIVATE_DECLINE_DIAGNOSTIC",
                  },
                },
              });
            } else {
              const plan = input.get("items[0][price]").replace(/^price_/, "");
              upgrade(subscription.id, plan, Math.floor(Date.now() / 1000));
              idempotency.set(key, { status: 200 });
            }
          }
          const reply = idempotency.get(key);
          if (reply.status !== 200) return Response.json(reply.body, { status: reply.status });
          return Response.json(subscription);
        }
        // Stripe refuses cancellation changes on a subscription its schedule manages.
        if (input.has("cancel_at_period_end") && subscription.schedule)
          return Response.json(
            { error: { type: "invalid_request_error", message: "Managed by a schedule" } },
            { status: 400 },
          );
        if (input.has("cancel_at_period_end"))
          subscription.cancel_at_period_end = input.get("cancel_at_period_end") === "true";
        if (input.get("trial_end") === "now" && subscription.status === "trialing") {
          const end = Math.floor(Date.now() / 1000);
          const attempted = input.get("payment_behavior") !== "default_incomplete";
          const paid = attempted && control.conversionPaid;
          subscription.trial_end = end;
          subscription.status = paid ? "active" : "past_due";
          const invoice = structuredClone(invoices.get(subscription.latest_invoice));
          invoice.id = `in_${randomUUID().replaceAll("-", "")}`;
          invoice.status = paid ? "paid" : "open";
          invoice.attempted = attempted;
          // Stripe emits subscription_update when trial_end=now starts paid billing.
          invoice.billing_reason = "subscription_update";
          invoice.lines.data[0].id = `il_${randomUUID().replaceAll("-", "")}`;
          invoice.lines.data[0].period = { start: end, end: end + 30 * 86400 };
          invoices.set(invoice.id, invoice);
          subscription.latest_invoice = invoice.id;
        }
      }
      if (request.method !== "GET" && control.lose === path) {
        control.lose = null;
        return Response.json(
          { error: { type: "api_error", message: "Committed reply lost" } },
          { status: 503 },
        );
      }
      return Response.json(subscription);
    }
    if (path === "/v1/invoices") {
      const ordered = [...invoices.values()]
        .reverse()
        .filter(
          (value) =>
            value.customer === url.searchParams.get("customer") &&
            value.status === "paid" &&
            (url.searchParams.get("subscription") === null ||
              value.parent.subscription_details.subscription ===
                url.searchParams.get("subscription")),
        );
      const after = url.searchParams.get("starting_after");
      const start = after === null ? 0 : ordered.findIndex((value) => value.id === after) + 1;
      const limit = Number(url.searchParams.get("limit"));
      return Response.json({
        object: "list",
        data: ordered.slice(start, start + limit),
        has_more: start + limit < ordered.length,
      });
    }
    if (path.startsWith("/v1/invoices/"))
      return Response.json(invoices.get(path.split("/").at(-1)));
    if (path.startsWith("/v1/charges/")) {
      // A restricted key without Charges read.
      if (control.chargesDenied)
        return Response.json(
          { error: { type: "invalid_request_error", code: "permission_denied" } },
          { status: 403 },
        );
      const value = charges.get(path.split("/").at(-1));
      return value
        ? Response.json(value)
        : Response.json(
            { error: { type: "invalid_request_error", code: "resource_missing" } },
            { status: 404 },
          );
    }
    if (path === "/v1/invoice_payments") {
      assert.equal(url.searchParams.get("payment[type]"), "payment_intent");
      const intent = url.searchParams.get("payment[payment_intent]");
      return list(
        [...charges.values()]
          .filter((value) => value.payment_intent === intent)
          .map((value) => ({
            id: `inpay_${value.id}`,
            invoice: value.testInvoice,
            status: "paid",
            payment: { type: "payment_intent", payment_intent: intent },
          })),
      );
    }
    if (path === "/v1/disputes")
      return list(
        [...disputes.values()].filter((value) => value.charge === url.searchParams.get("charge")),
      );
    throw new Error(`Unexpected Stripe request: ${request.method} ${path}`);
  };
  const complete = (sessionId, status = "paid") => {
    const session = sessions.get(sessionId);
    const subscriptionId = `sub_${randomUUID().replaceAll("-", "")}`;
    const subscription = {
      id: subscriptionId,
      customer: session.customer,
      metadata: session.metadata,
      livemode: false,
      status: status === "paid" ? "active" : "incomplete",
      cancel_at_period_end: false,
      schedule: null,
      items: {
        data: [{ id: "si_test", quantity: 1, price: prices[session.testPrice] }],
        has_more: false,
      },
    };
    const start = Math.floor(Date.now() / 1000);
    subscription.items.data[0].current_period_start = start;
    subscription.items.data[0].current_period_end = start + 30 * 86400;
    const invoice = {
      id: `in_${randomUUID().replaceAll("-", "")}`,
      customer: session.customer,
      livemode: false,
      status,
      billing_reason: "subscription_create",
      parent: {
        subscription_details: { subscription: subscriptionId, metadata: session.metadata },
      },
      lines: {
        has_more: false,
        data: [
          {
            id: "il_test",
            quantity: 1,
            currency: "usd",
            period: { start, end: start + 30 * 86400 },
            parent: {
              subscription_item_details: {
                subscription: subscriptionId,
                subscription_item: "si_test",
                proration: false,
              },
            },
            pricing: { price_details: { price: session.testPrice } },
          },
        ],
      },
    };
    subscription.latest_invoice = invoice.id;
    if (session.testTrialDays > 0) {
      subscription.status = "trialing";
      subscription.trial_start = start;
      subscription.trial_end = start + session.testTrialDays * 86400;
      invoice.lines.data[0].period.end = subscription.trial_end;
      invoice.amount_paid = 0;
      const method = {
        id: `pm_${randomUUID().replaceAll("-", "")}`,
        customer: session.customer,
        livemode: false,
        type: "card",
        card: { fingerprint: control.fingerprint, funding: control.funding },
      };
      paymentMethods.set(method.id, method);
      subscription.default_payment_method = method.id;
    }
    subscriptions.set(subscription.id, subscription);
    invoices.set(invoice.id, invoice);
    session.status = "complete";
    session.subscription = subscriptionId;
    session.url = null;
    return { subscription, invoice, session };
  };
  const line = (subscription, price, period, amount, proration) => ({
    id: `il_${randomUUID().replaceAll("-", "")}`,
    quantity: 1,
    currency: "usd",
    amount,
    period,
    parent: {
      subscription_item_details: {
        subscription: subscription.id,
        subscription_item: "si_test",
        proration,
      },
    },
    pricing: { price_details: { price } },
  });
  const bill = (subscription, reason, lines, status = "paid") => {
    const invoice = {
      id: `in_${randomUUID().replaceAll("-", "")}`,
      customer: subscription.customer,
      livemode: false,
      status,
      billing_reason: reason,
      parent: {
        subscription_details: {
          subscription: subscription.id,
          metadata: subscription.metadata,
        },
      },
      lines: { has_more: false, data: lines },
    };
    invoices.set(invoice.id, invoice);
    subscription.latest_invoice = invoice.id;
    return invoice;
  };
  /**
   * An upgrade with proration "always_invoice": the price changes now and Stripe invoices
   * a credit for the old plan's unused time and a charge for the new plan's remaining time.
   */
  const upgrade = (subscriptionId, plan, at, status = "paid") => {
    const subscription = subscriptions.get(subscriptionId);
    const item = subscription.items.data[0];
    const from = item.price;
    const period = { start: at, end: item.current_period_end };
    const share = (period.end - at) / (item.current_period_end - item.current_period_start);
    item.price = prices[`price_${plan}`];
    return bill(
      subscription,
      "subscription_update",
      [
        line(subscription, from.id, period, -Math.round(from.unit_amount * share), true),
        line(subscription, item.price.id, period, Math.round(item.price.unit_amount * share), true),
      ],
      status,
    );
  };
  /** A cheaper plan, as TalkTo schedules it: the next phase starts at the period end. */
  const scheduleDowngrade = (subscriptionId, plan) => {
    const subscription = subscriptions.get(subscriptionId);
    const item = subscription.items.data[0];
    const schedule = {
      id: `sub_sched_${randomUUID().replaceAll("-", "")}`,
      customer: subscription.customer,
      livemode: false,
      subscription: subscription.id,
      status: "active",
      current_phase: { start_date: item.current_period_start, end_date: item.current_period_end },
      phases: [
        {
          start_date: item.current_period_start,
          end_date: item.current_period_end,
          items: [{ price: item.price.id, quantity: 1 }],
        },
        {
          start_date: item.current_period_end,
          end_date: null,
          items: [{ price: `price_${plan}`, quantity: 1 }],
        },
      ],
    };
    schedules.set(schedule.id, schedule);
    subscription.schedule = schedule.id;
    return schedule;
  };
  /** The next month: a scheduled change takes effect, then the renewal invoice is paid. */
  const renew = (subscriptionId) => {
    const subscription = subscriptions.get(subscriptionId);
    const item = subscription.items.data[0];
    const schedule = schedules.get(subscription.schedule);
    if (schedule) {
      item.price = prices[schedule.phases[1].items[0].price];
      schedule.status = "released";
      subscription.schedule = null;
    }
    const length = item.current_period_end - item.current_period_start;
    item.current_period_start = item.current_period_end;
    item.current_period_end = item.current_period_start + length;
    const period = { start: item.current_period_start, end: item.current_period_end };
    return bill(subscription, "subscription_cycle", [
      line(subscription, item.price.id, period, item.price.unit_amount, false),
    ]);
  };
  /** The card charge that paid an invoice, created once. */
  const charge = (invoiceId) => {
    const existing = [...charges.values()].find((value) => value.testInvoice === invoiceId);
    if (existing) return existing;
    const invoice = invoices.get(invoiceId);
    const value = {
      id: `ch_${randomUUID().replaceAll("-", "")}`,
      object: "charge",
      customer: invoice.customer,
      livemode: false,
      payment_intent: `pi_${randomUUID().replaceAll("-", "")}`,
      amount: 1200,
      amount_refunded: 0,
      refunded: false,
      disputed: false,
      testInvoice: invoiceId,
    };
    charges.set(value.id, value);
    return value;
  };
  /** Refund an invoice's charge in full, or only `amount` cents of it. */
  const refund = (invoiceId, amount) => {
    const value = charge(invoiceId);
    value.amount_refunded = amount ?? value.amount;
    value.refunded = value.amount_refunded === value.amount;
    return value;
  };
  /** Open a dispute on an invoice's charge, or move its dispute to `status`. */
  const dispute = (invoiceId, status = "needs_response") => {
    const value = charge(invoiceId);
    value.disputed = true;
    const id = `dp_${value.id}`;
    disputes.set(id, { id, object: "dispute", charge: value.id, status, livemode: false });
    return { charge: value, dispute: disputes.get(id) };
  };
  return {
    charge,
    refund,
    dispute,
    schedules,
    upgrade,
    scheduleDowngrade,
    renew,
    handler,
    requests,
    control,
    paymentMethods,
    customers,
    sessions,
    subscriptions,
    invoices,
    prices,
    complete,
  };
}

/** Sign the exact bytes delivered to the public webhook, using the harness-only ephemeral secret. */
export function event(x, customerId, options = {}) {
  const payload = JSON.stringify({
    id: options.id ?? `evt_${randomUUID().replaceAll("-", "")}`,
    type: options.type ?? "invoice.paid",
    livemode: options.live ?? false,
    data: { object: options.object ?? { id: "in_test", customer: customerId } },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", x.webhookSecret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return x.raw("/webhooks/stripe", {
    method: "POST",
    body: payload,
    headers: {
      "stripe-signature": `t=${timestamp},v1=${signature}`,
      "content-type": "application/json",
    },
  });
}
