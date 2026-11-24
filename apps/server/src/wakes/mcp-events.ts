import { Effect, Result, Schema } from "effect";
import { describeFailure, safeName } from "../failure-log.js";
import * as W from "@talkto/api/wake";
import type { Adapter } from "./kind.js";
import * as Crypto from "./crypto.js";
import type * as Transport from "./transport.js";
import type * as E from "@talkto/api/errors";
import type { CallbackFailed, TargetLimit } from "./errors.js";

/**
 * MCP events, webhook delivery, as ChatGPT implements it.
 * Methods and delivery: https://developers.openai.com/plugins/build/mcp-events and the draft
 * extension SEP-3415 (https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415).
 * The client supplies the callback URL and a `whsec_` secret in `events/subscribe`; TalkTo proves
 * the callback with a signed challenge before storing anything, then signs every event with
 * Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC>`).
 * Host: OpenAI documents no callback hostname. `connectors.api.openai.com` is what a ChatGPT
 * subscription was observed to send (modelcontextprotocol/experimental-ext-triggers-events#8);
 * any other callback host is refused.
 */
export const adapter: Adapter = {
  kind: "mcp_events",
  policy: {
    hosts: ["connectors.api.openai.com"],
    path: /^\/[\x21-\x7e]{0,2000}$/,
    query: true,
    minIntervalMs: 60_000,
    maxAttempts: 5,
    // `webhook-id` stays the same across retries, so the receiver drops a duplicate.
    retryOnTimeout: true,
  },
  checkToken: (secret) =>
    Crypto.webhookKey(secret) === null
      ? "delivery.secret must be whsec_ followed by the base64 of 24–64 random bytes."
      : null,
  request: (delivery) =>
    signed(
      delivery.url,
      delivery.secret,
      delivery.attemptId,
      delivery.at,
      JSON.stringify({
        eventId: delivery.attemptId,
        name: W.eventName,
        timestamp: new Date(delivery.at).toISOString(),
        data: delivery.notice,
        cursor: null,
      }),
      delivery.wakeId,
    ),
};
const signed = (
  url: string,
  secret: string,
  id: string,
  at: number,
  body: string,
  subscriptionId: W.WakeId | null,
) =>
  Effect.gen(function* () {
    const key = Crypto.webhookKey(secret);
    if (key === null) return yield* new Crypto.SealBroken();
    const timestamp = Math.floor(at / 1000);
    const common = {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": yield* Crypto.signWebhook(key, id, timestamp, body),
    };
    const request: Transport.Request = {
      policy: adapter.policy,
      url,
      headers:
        subscriptionId === null ? common : { ...common, "x-mcp-subscription-id": subscriptionId },
      body,
    };
    return request;
  });
/**
 * The signed challenge a callback must echo before a subscription is stored. OpenAI requires
 * `X-MCP-Subscription-Id` on verification requests too; it carries the ID this subscribe will
 * return, which is deterministic and known before anything is stored.
 */
export const challenge = (
  url: string,
  secret: string,
  value: string,
  at: number,
  subscriptionId: W.WakeId,
) =>
  Effect.gen(function* () {
    const id = `msg_verification_${yield* Crypto.random(18)}`;
    return yield* signed(
      url,
      secret,
      id,
      at,
      JSON.stringify({ type: "verification", challenge: value }),
      subscriptionId,
    );
  });

/** SEP-3415's extension identifier. */
export const extension = "io.modelcontextprotocol/events";
/** The one event's description. Every authenticated connection may discover it. */
export const description =
  "New incoming TalkTo messages are waiting for one participant. The event carries only counts and IDs (serverId, participantId, pending, urgent, more), never message text, senders or channel names. When it arrives, call get_updates with the same serverId and participantId to read the messages. Many messages share one event; at most one event a minute.";

/** Subscription lifetime: the client's request, kept between 5 minutes and 1 day. */
export const minTtlMs = 300_000;
export const maxTtlMs = 86_400_000;
/** Rows outlive `refreshBefore` by this much, so a late refresh keeps its delivery state. */
export const graceMs = 900_000;
export const ttl = (requested: number | null | undefined) =>
  requested === undefined || requested === null
    ? maxTtlMs
    : Math.min(maxTtlMs, Math.max(minTtlMs, Math.floor(requested)));

/** `events/subscribe` params as ChatGPT sends them. */
export const SubscribeParams = Schema.Struct({
  name: Schema.String,
  arguments: W.EventArguments,
  delivery: Schema.Struct({ mode: Schema.String, url: Schema.String, secret: Schema.String }),
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
  maxAgeMs: Schema.optional(Schema.NullOr(Schema.Number)),
  ttlMs: Schema.optional(Schema.NullOr(Schema.Number)),
});
/** `events/unsubscribe` params; `delivery.mode` is accepted but not required. */
export const UnsubscribeParams = Schema.Struct({
  name: Schema.String,
  arguments: W.EventArguments,
  delivery: Schema.Struct({ mode: Schema.optional(Schema.String), url: Schema.String }),
});
/** `events/list` params. */
export const ListParams = Schema.Struct({ cursor: Schema.optional(Schema.NullOr(Schema.String)) });

/** A request as it crosses Durable Object RPC; the object decodes it again. */
export const Command = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("subscribe"),
    arguments: W.EventArguments,
    url: Schema.String,
    secret: Schema.String,
    ttlMs: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({
    op: Schema.Literal("unsubscribe"),
    arguments: W.EventArguments,
    url: Schema.String,
  }),
]);
/** Parsed events command. */
export type Command = typeof Command.Type;
/** `deliveryStatus` on a refresh. A type alias so it satisfies JSON-RPC result typing. */
export type DeliveryStatus = {
  readonly active: boolean;
  readonly lastDeliveryAt: string | null;
  readonly lastError:
    | "connection_refused"
    | "timeout"
    | "tls_error"
    | "http_4xx"
    | "http_5xx"
    | "challenge_failed"
    | null;
};
/** The `events/subscribe` result. */
export type Subscribed = {
  readonly resultType: "complete";
  readonly id: W.WakeId;
  readonly refreshBefore: string;
  readonly cursor: null;
  readonly truncated: false;
  readonly deliveryStatus?: DeliveryStatus;
};
/** JSON-RPC error codes. CallbackEndpointError uses OpenAI's -32015; SEP-3415 renumbers it. */
export const codes = {
  invalidParams: -32602,
  internal: -32603,
  notFound: -32023,
  forbidden: -32024,
  resourceExhausted: -32025,
  unsupported: -32026,
  callbackEndpoint: -32015,
} as const;
/** Structured `data` on a JSON-RPC error. */
export type ErrorData =
  | { readonly reason: string }
  | { readonly limit: "subscriptions"; readonly max: number }
  | { readonly kind: "event" }
  | { readonly feature: string; readonly value: string };
/**
 * Why a call was refused, for TalkTo's log only; never sent to the client. Every field is a code
 * TalkTo chose: a failure tag, a delivery reason, an HTTP status, or a params path.
 */
export type Diagnostic = {
  readonly failure: string;
  readonly detail?: string;
  readonly status?: number | null;
  readonly fields?: ReadonlyArray<string>;
};
/** A refused call: the JSON-RPC error and its log-only diagnostic. */
export type Refusal = {
  readonly code: number;
  readonly message: string;
  readonly data?: ErrorData;
  readonly diagnostic?: Diagnostic;
};
/** What the server object answers; serializable over Durable Object RPC. */
export type Answer =
  | { readonly ok: Subscribed | Record<string, never> }
  | { readonly error: Refusal };

/** Map a typed failure to its JSON-RPC error. Messages never echo a secret or a host response. */
export const failure = (
  error:
    | E.ServerAccessDenied
    | E.StorageUnavailable
    | E.InvalidInput
    | E.ParticipantNotFound
    | E.NotAnAgent
    | E.AgentNotOwned
    | E.ParticipantRemoved
    | E.ConversationNotFound
    | E.WrongConversationKind
    | CallbackFailed
    | TargetLimit,
): Answer => {
  const diagnostic = { failure: error._tag };
  switch (error._tag) {
    case "ServerAccessDenied":
      return {
        error: { code: codes.forbidden, message: "The server is unavailable.", diagnostic },
      };
    case "AgentNotOwned":
      return { error: { code: codes.forbidden, message: error.message, diagnostic } };
    case "StorageUnavailable":
      return {
        error: {
          code: codes.internal,
          message: "Server storage is temporarily unavailable.",
          diagnostic,
        },
      };
    case "InvalidInput":
    case "ParticipantNotFound":
    case "NotAnAgent":
    case "ParticipantRemoved":
    case "ConversationNotFound":
    case "WrongConversationKind":
      return { error: { code: codes.invalidParams, message: error.message, diagnostic } };
    case "CallbackFailed":
      return {
        error: {
          code: codes.callbackEndpoint,
          message: "The callback did not answer the signed verification challenge.",
          data: { reason: error.reason },
          diagnostic: { ...diagnostic, detail: error.detail, status: error.status },
        },
      };
    case "TargetLimit":
      return {
        error: {
          code: codes.resourceExhausted,
          message: `This participant already has the most subscriptions allowed (${error.max}).`,
          data: { limit: "subscriptions", max: error.max },
          diagnostic,
        },
      };
  }
};

/** Top-level `events/subscribe` and `events/unsubscribe` params TalkTo reads. */
const knownParams = new Set([
  "name",
  "arguments",
  "delivery",
  "cursor",
  "maxAgeMs",
  "ttlMs",
  "_meta",
]);
/** A DNS name or IPv4 address as `URL` normalizes it; any other host is logged as `?`. */
const hostname =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;
/** An optional field that reads as absent when it has the wrong type. */
const loose = <S extends Schema.Constraint>(schema: S) =>
  Schema.optionalKey(Schema.catchDecoding<S>(() => Effect.succeedNone)(schema));
/**
 * Any events params, read only as far as a log line needs. A field of the wrong type reads as
 * absent, so every request decodes.
 */
export const Observed = Schema.Struct({
  name: loose(Schema.String),
  arguments: loose(Schema.Record(Schema.String, Schema.Unknown)),
  delivery: loose(
    Schema.Struct({
      mode: loose(Schema.String),
      url: loose(Schema.String),
      secret: loose(Schema.String),
    }),
  ),
  cursor: loose(Schema.NullOr(Schema.String)),
  ttlMs: loose(Schema.NullOr(Schema.Number)),
});
/** Parsed events params, for logging only. */
export type Observed = typeof Observed.Type;
/** Read any params for the log. */
export const observe = Schema.decodeUnknownResult(Observed);
/** Object keys as identifier-shaped names; any other key is logged as `?`. */
const names = (keys: ReadonlyArray<string>) => keys.map((key) => safeName(key) ?? "?").toSorted();
/** The callback URL's host, only when it is a hostname, and whether TalkTo would send to it. */
const callbackOf = (url: string | undefined) => {
  if (url === undefined || !URL.canParse(url))
    return { callbackHost: null, callbackAllowed: false };
  const host = new URL(url).hostname;
  return {
    callbackHost: hostname.test(host) ? host : "?",
    callbackAllowed: W.checkUrl(adapter.policy, url)._tag === "Allowed",
  };
};
/**
 * What one events request looked like: event name, argument keys, delivery mode, callback host
 * and whether it is allowed, the secret's validity, and the lifetime asked for. Never the
 * callback path or query, the secret, a cursor, or any argument value.
 */
export const requestSummary = (
  observed: Result.Result<Observed, Schema.SchemaError>,
  keys: ReadonlyArray<string>,
) => {
  const params: Observed = Result.getOrElse(observed, () => ({}));
  const secret = params.delivery?.secret;
  return {
    name: params.name === undefined ? null : safeName(params.name),
    argumentKeys: params.arguments === undefined ? null : names(Object.keys(params.arguments)),
    unknownParams: names(keys.filter((key) => !knownParams.has(key))),
    deliveryMode: params.delivery?.mode === undefined ? null : safeName(params.delivery.mode),
    ...callbackOf(params.delivery?.url),
    secret:
      secret === undefined ? "absent" : adapter.checkToken(secret) === null ? "valid" : "invalid",
    cursor: params.cursor === undefined ? "absent" : params.cursor === null ? "null" : "present",
    ttlMs: params.ttlMs ?? null,
  };
};
/** The summary of one request, as `logEntry` records it. */
export type RequestSummary = ReturnType<typeof requestSummary>;
/** How an events call ended, as its log line records it. */
export type Outcome =
  | { readonly _tag: "Subscribed"; readonly refreshed: boolean }
  | { readonly _tag: "Unsubscribed" }
  | { readonly _tag: "Refused"; readonly refusal: Refusal }
  | { readonly _tag: "Failed"; readonly cause: unknown };
/**
 * One safe log line for `events/subscribe` or `events/unsubscribe`: the outcome code, the
 * JSON-RPC error code and its categorized reason, TalkTo's own diagnostic codes, and the request's
 * shape. Never the secret, a token, the callback path, message text, or an error's message.
 */
export const logEntry = (
  method: "events/subscribe" | "events/unsubscribe",
  request: RequestSummary,
  outcome: Outcome,
  ms: number,
) => {
  const base = { event: "mcp_events", method, ms, request };
  switch (outcome._tag) {
    case "Subscribed":
      return { ...base, outcome: outcome.refreshed ? "refreshed" : "subscribed" };
    case "Unsubscribed":
      return { ...base, outcome: "unsubscribed" };
    case "Refused": {
      const { code, data, diagnostic } = outcome.refusal;
      return {
        ...base,
        outcome: "refused",
        code,
        reason: data !== undefined && "reason" in data ? safeName(data.reason) : null,
        failure: diagnostic === undefined ? null : safeName(diagnostic.failure),
        detail: diagnostic?.detail === undefined ? null : safeName(diagnostic.detail),
        status: diagnostic?.status ?? null,
        fields: (diagnostic?.fields ?? []).map((field) => safeName(field) ?? "?"),
      };
    }
    case "Failed":
      return {
        ...base,
        outcome: "failed",
        code: codes.internal,
        error: describeFailure(outcome.cause),
      };
  }
};
