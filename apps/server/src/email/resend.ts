import { Effect, Layer, Option, Redacted, Schema, SchemaGetter } from "effect";
import * as Crypto from "../wakes/crypto.js";
import * as Model from "./model.js";

/*
  Resend (https://resend.com/docs), over HTTP with the TALKTO_RESEND_API_KEY secret. Batches go to
  POST /emails/batch (at most 100) with an Idempotency-Key, which Resend keeps for 24 hours: a retry
  with the same key and body returns the first result instead of sending again. Nothing from a
  response is kept but message IDs and the error name.
*/

const endpoint = "https://api.resend.com/emails/batch";
const Sent = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const ErrorBody = Schema.Struct({ name: Schema.optionalKey(Schema.String) });

/** Classify a refusal: what was sent (nothing, or maybe) decides how the outbox retries. */
const refusal = (status: number, name: string | undefined) => {
  if (status === 429)
    return Model.failure(
      "resend.send",
      name === "daily_quota_exceeded" || name === "monthly_quota_exceeded"
        ? "quota"
        : "rate_limited",
      status,
    );
  // Another request with this key is still running: only the same key may try again.
  if (status === 409 && name === "concurrent_idempotent_requests")
    return Model.failure("resend.send", "ambiguous", status);
  if (status === 401 || status === 403) return Model.failure("resend.send", "unauthorized", status);
  if (status >= 500) return Model.failure("resend.send", "ambiguous", status);
  return Model.failure("resend.send", "refused", status);
};

/** One email in Resend's batch request body. */
interface ResendEmail {
  readonly from: string;
  readonly to: ReadonlyArray<string>;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly tags: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  reply_to?: string;
}

/** The Resend `Email` port. */
export const layer = (settings: {
  readonly apiKey: Redacted.Redacted<string>;
  readonly replyTo: string | null;
}) =>
  Layer.succeed(
    Model.Email,
    Model.Email.of({
      maxBatch: 100,
      send: Effect.fn("Resend.send")(function* (messages, idempotencyKey) {
        const body = messages.map((message) => {
          const email: ResendEmail = {
            from: message.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
            headers: message.headers,
            tags: [{ name: "kind", value: message.kind }],
          };
          if (settings.replyTo !== null) email.reply_to = settings.replyTo;
          return email;
        });
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(endpoint, {
              method: "POST",
              redirect: "manual",
              signal: AbortSignal.timeout(15_000),
              headers: {
                authorization: `Bearer ${Redacted.value(settings.apiKey)}`,
                "content-type": "application/json",
                "idempotency-key": idempotencyKey,
                "user-agent": "talkto-email",
              },
              body: JSON.stringify(body),
            }),
          // A timeout or dropped connection may have sent the batch.
          catch: () => Model.failure("resend.send", "ambiguous"),
        });
        const json = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null));
        if (response.status !== 200) {
          const error = Schema.decodeUnknownOption(ErrorBody)(json);
          return yield* refusal(
            response.status,
            Option.isSome(error) ? error.value.name : undefined,
          );
        }
        const sent = Schema.decodeUnknownOption(Sent)(json);
        // Accepted but unreadable: it was sent, so it must never be sent again under a new key.
        if (Option.isNone(sent) || sent.value.data.length !== messages.length)
          return messages.map(() => "resend_unreadable");
        return sent.value.data.map((item) => item.id);
      }),
    }),
  );

/** The webhook events that stop future sends to an address. */
export const SuppressingEvent = Schema.Literals([
  "email.bounced",
  "email.complained",
  "email.suppressed",
]);
/** Resend sends `to` as a list; a single address is accepted as a list of one. */
const Recipients = Schema.Union([
  Schema.Array(Schema.String),
  Schema.String.pipe(
    Schema.decodeTo(Schema.Array(Schema.String), {
      decode: SchemaGetter.transform((value: string) => [value]),
      encode: SchemaGetter.transform((values: ReadonlyArray<string>) => values[0] ?? ""),
    }),
  ),
]);
const Event = Schema.Struct({
  type: Schema.String,
  data: Schema.optionalKey(Schema.Struct({ to: Schema.optionalKey(Recipients) })),
});
/** A verified webhook delivery: its Svix ID, event type and recipients. */
export interface Webhook {
  readonly id: string;
  readonly type: string;
  readonly to: ReadonlyArray<string>;
}
/** How long a signed delivery stays acceptable, against replays. */
const toleranceSeconds = 300;
/**
 * Verify a Resend (Svix) webhook: HMAC-SHA256 of `{svix-id}.{svix-timestamp}.{raw body}` under the
 * `whsec_` secret, compared in constant time against every `v1,` signature in the header, with the
 * timestamp within five minutes. Returns null for anything unsigned, stale or malformed.
 */
export const verifyWebhook = Effect.fn("Resend.verifyWebhook")(function* (
  secret: Redacted.Redacted<string>,
  headers: Headers,
  body: string,
  nowSeconds: number,
) {
  const key = Crypto.webhookKey(Redacted.value(secret));
  const id = headers.get("svix-id") ?? "";
  const timestamp = headers.get("svix-timestamp") ?? "";
  const signatures = (headers.get("svix-signature") ?? "").split(" ").filter(Boolean);
  if (key === null || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || !/^\d{1,12}$/.test(timestamp))
    return null;
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return null;
  const expected = yield* Crypto.signWebhook(key, id, Number(timestamp), body);
  if (!signatures.some((signature) => Crypto.sameText(signature, expected))) return null;
  const event = Schema.decodeUnknownOption(Schema.fromJsonString(Event))(body);
  if (Option.isNone(event)) return null;
  return { id, type: event.value.type, to: event.value.data?.to ?? [] } satisfies Webhook;
});
