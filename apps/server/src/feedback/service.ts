import { Clock, Context, DateTime, Effect, Schema } from "effect";
import * as F from "@talkto/api/feedback";
import * as M from "@talkto/api/models";
import type * as P from "@talkto/api/platform";
import * as Model from "../platform/model.js";
import * as Platform from "../platform/service.js";
import * as Store from "./store.js";

/*
  Feedback and bug reports (docs/feedback.md): store one message for the owner to read, from the
  dashboard's Feedback button or an agent's `send_feedback` tool. Nothing is emailed, forwarded or
  logged; the text never leaves D1. Both sources count toward one limit: each person can send
  `F.dailyLimit` a UTC day. A retried request key returns its first message and does not count
  again.
*/

/**
 * The person sent today's maximum number of messages; nothing was stored. `retryAt` is the next
 * UTC midnight.
 */
export class FeedbackLimited extends Schema.TaggedError<FeedbackLimited>()("FeedbackLimited", {
  retryAt: M.Timestamp,
  message: Schema.String,
}) {}

/** What the boundary read from the request itself, never from its body. */
export interface Observed {
  /** The browser's or agent app's User-Agent, cut to 256 characters. */
  readonly userAgent: string | null;
}

/**
 * One message as the caller sent it. The account, server and agent are what the caller named;
 * `send` keeps each only after checking it belongs to the signed-in person.
 */
export interface Submission {
  readonly source: F.FeedbackSource;
  readonly kind: F.FeedbackKind;
  readonly message: string;
  readonly requestKey: M.RequestKey;
  readonly page: string | null;
  readonly appVersion: string | null;
  readonly accountId: P.AccountId | null;
  readonly serverId: M.ServerId | null;
  readonly participantId: M.ParticipantId | null;
}

/** What one server says about the caller, through the caller's own server access. */
export interface Attribution {
  /** The caller can open the server. */
  readonly server: boolean;
  /** The named agent was registered on that server through the caller's access. */
  readonly participant: boolean;
}
/**
 * Asks a server whether the caller can open it and registered the named agent. Never fails: an
 * unanswered check keeps nothing, and the message is still stored.
 */
export class Agents extends Context.Service<
  Agents,
  {
    readonly attribute: (
      actor: Model.Actor,
      serverId: M.ServerId,
      participantId: M.ParticipantId | null,
    ) => Effect.Effect<Attribution>;
  }
>()("@talkto/feedback/Agents") {}

const iso = (value: DateTime.DateTime) => M.Timestamp.make(DateTime.formatIso(value));
const none: Attribution = { server: false, participant: false };

/** Store one message under the signed-in person, keeping only the context they can open. */
export const send = Effect.fn("Feedback.send")(function* (
  actor: Model.Actor,
  input: Submission,
  observed: Observed,
): Effect.fn.Return<
  F.SentFeedback,
  Model.Failure | FeedbackLimited,
  Store.Store | Platform.Service | Agents
> {
  const store = yield* Store.Store;
  const platform = yield* Platform.Service;
  const agents = yield* Agents;
  const now = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
  // Feedback still arrives when a check cannot be made; it then names less.
  const accountId =
    input.accountId === null
      ? null
      : yield* platform.getAccount(actor, input.accountId).pipe(
          Effect.map((account) => account.id),
          Effect.orElseSucceed(() => null),
        );
  const attribution =
    input.serverId === null
      ? none
      : yield* agents.attribute(actor, input.serverId, input.participantId);
  const id = F.FeedbackId.make(crypto.randomUUID());
  const row = yield* store.record(
    {
      id,
      userId: actor.userId,
      requestKey: input.requestKey,
      source: input.source,
      kind: input.kind,
      message: input.message,
      accountId,
      serverId: attribution.server ? input.serverId : null,
      participantId: attribution.server && attribution.participant ? input.participantId : null,
      page: input.page,
      appVersion: input.appVersion,
      userAgent: observed.userAgent,
      at: iso(now),
    },
    iso(DateTime.startOf(now, "day")),
    F.dailyLimit,
  );
  if (row === null)
    return yield* new FeedbackLimited({
      retryAt: iso(DateTime.startOf(DateTime.add(now, { days: 1 }), "day")),
      message: `You have sent today's ${F.dailyLimit} messages. Nothing was sent this time.`,
    });
  if (
    row.id !== id &&
    (row.source !== input.source ||
      row.kind !== input.kind ||
      row.message !== input.message ||
      row.page !== input.page)
  )
    return yield* new Model.Failure({
      code: "idempotency_conflict",
      message: "This request key already sent a different message. Send it as a new message.",
    });
  return { id: row.id, kind: row.kind, createdAt: row.createdAt };
});
