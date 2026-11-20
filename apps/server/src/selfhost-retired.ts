import { Effect, Schema } from "effect";

/** An event's type, for the log line only; nothing else in the body is read. */
const StripeEvent = Schema.fromJsonString(
  Schema.Struct({ type: Schema.String.check(Schema.isPattern(/^[a-z_.]{1,80}$/)) }),
);

/**
 * `POST /webhooks/stripe-selfhost` after self-host license sales ended (owner decision, November 19,
 * 2026: TalkTo is licensed under Apache-2.0, `LICENSE`). Stripe may still send events for a yearly
 * self-host subscription, or for a Payment Link nobody deactivated. Each is acknowledged so Stripe
 * stops retrying, and logged by type only. Nothing is verified, stored or delivered, and no GitHub
 * access changes. A completed checkout is a warning: someone paid, and the owner refunds them.
 */
export const acknowledge = Effect.fn("SelfHostRetired.acknowledge")(function* (
  payload: string,
  requestId: string,
) {
  const event = Schema.decodeUnknownOption(StripeEvent)(payload);
  const type = event._tag === "Some" ? event.value.type : null;
  const entry = { requestId, type };
  if (type !== null && type.startsWith("checkout.session."))
    yield* Effect.sync(() =>
      console.warn("TalkTo self-host sales have ended; ignored a self-host checkout", entry),
    );
  else
    yield* Effect.sync(() =>
      console.info("TalkTo self-host sales have ended; ignored a Stripe event", entry),
    );
  return Response.json({ received: true });
});
