import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type * as A from "@talkto/api/agent";
import * as F from "@talkto/api/feedback";
import * as Envelope from "@talkto/api/envelope";
import * as Security from "@talkto/api/security";
import { run, trace } from "@talkto/telemetry/effect";
import * as PlatformHttp from "../platform/http.js";
import * as InvitationPolicy from "../platform/invitation-policy.js";
import * as Model from "../platform/model.js";
import * as Platform from "../platform/service.js";
import * as Store from "./store.js";
import * as Feedback from "./service.js";

/*
  The Worker boundary for feedback: the dashboard's `POST /v1/feedback` and the agents'
  `send_feedback` MCP tool. Both are signed in only and run the same `Feedback.send`.
*/

/** The User-Agent, cut to 256 characters. It is the only fact read from the request headers. */
export const observe = (request: Request): Feedback.Observed => {
  const agent = request.headers.get("user-agent")?.trim().slice(0, 256);
  return { userAgent: agent === undefined || agent.length === 0 ? null : agent };
};

/** 429 with the next UTC midnight; the Worker adds Retry-After. */
const limited = (error: Feedback.FeedbackLimited, meta: Envelope.Meta) => ({
  error: {
    code: "feedback_limited" as const,
    message: error.message,
    retryable: true as const,
    action: "retry_after" as const,
    retryAfterSeconds: InvitationPolicy.retryAfterSeconds(error.retryAt, meta.serverTime),
    retryAt: error.retryAt,
  },
  meta,
});
/** Server checks through the private server binding, under the caller's own principal. */
const agents = (env: Env) =>
  Layer.succeed(
    Feedback.Agents,
    Feedback.Agents.of({
      attribute: (actor, serverId, participantId) =>
        Effect.tryPromise(() =>
          env.SERVERS.getByName(serverId).feedbackAttribution(
            actor.principalKey,
            null,
            participantId,
          ),
        ).pipe(Effect.orElseSucceed(() => ({ server: false, participant: false }))),
    }),
  );
const handlers = (observed: Feedback.Observed) =>
  HttpApiBuilder.group(F.Api, "feedback", (routes) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<Store.Store | Platform.Service | Feedback.Agents>();
      return routes.handleAll({
        send: ({ payload }) =>
          Effect.gen(function* () {
            const { actor, meta } = yield* PlatformHttp.RequestContext;
            const submission: Feedback.Submission = {
              source: "dashboard",
              kind: payload.kind,
              message: payload.message,
              requestKey: payload.requestKey,
              page: payload.page,
              appVersion: payload.appVersion ?? null,
              accountId: payload.accountId ?? null,
              serverId: null,
              participantId: null,
            };
            const data = yield* Feedback.send(actor, submission, observed).pipe(
              Effect.provide(context),
              Effect.mapError((error) =>
                error._tag === "FeedbackLimited"
                  ? limited(error, meta)
                  : PlatformHttp.failure(error, meta),
              ),
            );
            return { data, meta };
          }),
      });
    }),
  );

/** Whether a path is the feedback API. */
export const isPath = (path: string) => path === "/v1/feedback";

/** Store the signed-in person's message. Never emails or forwards it. */
export const handle = Effect.fn("FeedbackHttp.handle")(function* (
  request: Request,
  actor: Model.Actor,
  meta: Envelope.Meta,
  env: Env,
  platform: Layer.Layer<Platform.Service>,
) {
  const web = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(F.Api).pipe(
      Layer.provide(handlers(observe(request))),
      Layer.provide([Store.layer(env.PLATFORM), platform, agents(env)]),
      Layer.provide(
        Layer.succeed(
          Security.Authorization,
          Security.Authorization.of({ bearer: (effect) => effect, webSession: (effect) => effect }),
        ),
      ),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true, middleware: trace },
  );
  try {
    return yield* Effect.promise(() =>
      web.handler(request, Context.make(PlatformHttp.RequestContext, { actor, meta })),
    );
  } finally {
    yield* Effect.promise(() => web.dispose());
  }
});

/**
 * The `send_feedback` MCP tool: the signed-in person's message, sent by their agent. Answers in
 * the tool reply envelope; a failure names a code and safe message, never the text.
 */
export const agent = (
  request: Request,
  actor: Model.Actor,
  input: F.AgentFeedback,
  meta: A.Meta,
  env: Env,
  platform: Layer.Layer<Platform.Service>,
): Promise<A.UncheckedReply> =>
  run(
    Feedback.send(
      actor,
      {
        source: "agent",
        kind: input.kind,
        message: input.message,
        requestKey: input.requestKey,
        page: null,
        appVersion: null,
        accountId: null,
        serverId: input.serverId ?? null,
        participantId: input.participantId ?? null,
      },
      observe(request),
    ).pipe(
      Effect.provide([Store.layer(env.PLATFORM), platform, agents(env)]),
      Effect.match({
        onSuccess: (data) => ({ data, included: { participants: [], conversations: [] }, meta }),
        onFailure: (error) =>
          error._tag === "FeedbackLimited"
            ? { error: limited(error, meta).error, meta }
            : { error: { code: error.code, message: error.message }, meta },
      }),
    ),
  );
