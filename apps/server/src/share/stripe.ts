import Stripe from "stripe";
import { Effect, Layer, Redacted, Schema } from "effect";
import * as P from "@talkto/api/platform";
import type * as BillingStripe from "../billing/stripe.js";
import * as Model from "./model.js";

/*
  The same-card check for share links (docs/share-links-spec.md): the card fingerprints of each
  organization's saved card payment methods, read from Stripe when a referral qualifies and never
  stored. Only organizations with a Stripe customer in this provider scope have cards.
*/

const Customer = Schema.Struct({ customerId: Schema.NullOr(Schema.String) });

/** Compare the fingerprints of two organizations' saved cards. */
export const layer = (config: BillingStripe.Configuration, scope: string, database: D1Database) =>
  Layer.sync(Model.Cards, () => {
    const stripe = new Stripe(Redacted.value(config.key), {
      apiVersion: "2026-08-26.dahlia",
      httpClient: Stripe.createFetchHttpClient(),
      maxNetworkRetries: 0,
      timeout: 15000,
      telemetry: false,
    });
    const db = database.withSession("first-primary");
    const customer = Effect.fn("ShareCards.customer")(function* (accountId: P.AccountId) {
      const row = yield* Effect.tryPromise({
        try: () =>
          db
            .prepare(
              "SELECT customer_id AS customerId FROM workspace_billing WHERE account_id=? AND provider_scope=?",
            )
            .bind(accountId, scope)
            .first(),
        catch: () => Model.unavailable("storage.read"),
      });
      if (row === null) return null;
      const parsed = yield* Schema.decodeUnknownEffect(Customer)(row).pipe(
        Effect.mapError(() => Model.unavailable("storage.decode")),
      );
      return parsed.customerId;
    });
    const fingerprints = Effect.fn("ShareCards.fingerprints")(function* (customerId: string) {
      const methods = yield* Effect.tryPromise({
        try: () => stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 20 }),
        catch: () => Model.unavailable("stripe.payment_methods"),
      });
      const found = new Set<string>();
      for (const method of methods.data)
        if (method.livemode === config.live && method.card?.fingerprint)
          found.add(method.card.fingerprint);
      return found;
    });
    return Model.Cards.of({
      shared: Effect.fn("ShareCards.shared")(function* (a, b) {
        const [left, right] = yield* Effect.all([customer(a), customer(b)], { concurrency: 2 });
        if (left === null || right === null) return false;
        if (left === right) return true;
        const [mine, theirs] = yield* Effect.all([fingerprints(left), fingerprints(right)], {
          concurrency: 2,
        });
        for (const fingerprint of mine) if (theirs.has(fingerprint)) return true;
        return false;
      }),
    });
  });
