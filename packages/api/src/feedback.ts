import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import * as M from "./models.js";
import * as P from "./platform.js";
import * as Envelope from "./envelope.js";
import { Authorization } from "./security.js";

/*
  Feedback and bug reports (docs/feedback.md), from the dashboard's Feedback button or from an
  agent's `send_feedback` MCP tool. Stored in D1 for the owner to read; never emailed or forwarded.
*/

/** Messages a person can send per UTC day. */
export const dailyLimit = 10;
/** Longest message, in characters. */
export const messageLimit = 5000;

/** Stored feedback identity. */
export const FeedbackId = Schema.String.check(Schema.isUUID(4)).pipe(Schema.brand("FeedbackId"));
/** Parsed feedback identity. */
export type FeedbackId = typeof FeedbackId.Type;
/** What the person is telling us. */
export const FeedbackKind = Schema.Literals(["feedback", "bug"]);
/** Parsed feedback kind. */
export type FeedbackKind = typeof FeedbackKind.Type;
/** Where a message came from: the dashboard's Feedback button or the `send_feedback` tool. */
export const FeedbackSource = Schema.Literals(["dashboard", "agent"]);
/** Parsed feedback source. */
export type FeedbackSource = typeof FeedbackSource.Type;
/** The person's words, trimmed. */
export const FeedbackMessage = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(messageLimit),
);
/** The page it was sent from: a path only, so no query string or fragment is ever stored. */
export const PagePath = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^\/[^\s?#]*$/),
);
/** The web build the person was using, for example `talkto@<commit>`. */
export const AppVersion = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:@+-]{1,100}$/));

/**
 * One message. `accountId` is the organization the person had open, if any; it is kept only when
 * the person can open it. Retrying with the same `requestKey` returns the first message.
 */
export const SendFeedback = Schema.Struct({
  kind: FeedbackKind,
  message: FeedbackMessage,
  page: PagePath,
  appVersion: Schema.optionalKey(AppVersion),
  accountId: Schema.optionalKey(P.AccountId),
  requestKey: M.RequestKey,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed feedback request. */
export interface SendFeedback extends Schema.Schema.Type<typeof SendFeedback> {}

/** The stored message, without its text. */
export const SentFeedback = Schema.Struct({
  id: FeedbackId,
  kind: FeedbackKind,
  createdAt: M.Timestamp,
});
/** Parsed stored feedback. */
export interface SentFeedback extends Schema.Schema.Type<typeof SentFeedback> {}

/** The MCP tool's name. */
export const toolName = "send_feedback";
/**
 * The `send_feedback` tool's input. The message is the signed-in person's, sent by their agent.
 * `participantId` names the agent and needs `serverId`; it is kept only when that agent was
 * registered on that server through the person's own access, and the server only when the
 * person can open it.
 */
export const AgentFeedback = Schema.Struct({
  kind: FeedbackKind,
  message: FeedbackMessage,
  requestKey: M.RequestKey,
  serverId: Schema.optionalKey(M.ServerId),
  participantId: Schema.optionalKey(M.ParticipantId),
})
  .check(
    Schema.makeFilter(
      (input) => input.participantId === undefined || input.serverId !== undefined,
      { message: "participantId needs the serverId of the server the agent joined." },
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed agent feedback. */
export interface AgentFeedback extends Schema.Schema.Type<typeof AgentFeedback> {}

/** The signed-in person's feedback. Fails with `feedback_limited` (429) after the daily limit. */
export const Api = HttpApi.make("talkto-feedback").add(
  HttpApiGroup.make("feedback")
    .add(
      HttpApiEndpoint.post("send", "/v1/feedback", {
        payload: SendFeedback,
        success: P.response(SentFeedback),
        error: Envelope.failures,
      }),
    )
    .middleware(Authorization),
);
