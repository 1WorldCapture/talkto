import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import * as P from "@talkto/api/platform";
import * as Envelope from "@talkto/api/envelope";
import * as Security from "@talkto/api/security";
import * as Model from "./model.js";
import * as Platform from "./service.js";
import * as Activity from "./activity.js";
import * as InvitationPolicy from "./invitation-policy.js";
import { trace } from "@talkto/telemetry/effect";
import * as Telemetry from "../telemetry.js";

/** Verified identity and request metadata supplied by the Worker. */
export class RequestContext extends Context.Service<
  RequestContext,
  {
    readonly actor: Model.Actor;
    readonly meta: Envelope.Meta;
    /** Absent for adapters that never claim offers; treated as no website session. */
    readonly evidence?: Model.Evidence;
    /** Set on a self-hosted copy that signs people in with Cloudflare Access or Better Auth. */
    readonly signIn?: "cloudflare-access" | "better-auth";
  }
>()("@talkto/platform/RequestContext") {}
/** An exhausted invitation budget: 429 with the retry time; the Worker adds Retry-After. */
const invitationLimited = (error: Model.InvitationLimited, meta: Envelope.Meta) => ({
  error: {
    code: "invitation_limited" as const,
    message: error.message,
    retryable: true as const,
    action: "retry_after" as const,
    retryAfterSeconds: InvitationPolicy.retryAfterSeconds(error.retryAt, meta.serverTime),
    retryAt: error.retryAt,
    scope: error.scope,
  },
  meta,
});
/** Translate application failures to shared public errors. */
export const failure = (error: Model.Failure | Model.InvitationLimited, meta: Envelope.Meta) => {
  if (error._tag === "InvitationLimited") return invitationLimited(error, meta);
  Telemetry.failure(error.code, meta.requestId, error);
  const make = <const C extends Envelope.SimpleFailureCode>(code: C) =>
    Envelope.makeFailure(code, error.message, meta);
  switch (error.code) {
    case "invalid_input":
      return make("invalid_input");
    case "unauthenticated":
      return make("unauthenticated");
    case "forbidden":
      return make("forbidden");
    case "people_limit_reached":
      return make("people_limit_reached");
    case "starter_unavailable":
      return make("starter_unavailable");
    case "server_limit_reached":
      return make("server_limit_reached");
    case "not_found":
      return make("not_found");
    case "idempotency_conflict":
      return make("idempotency_conflict");
    case "storage_unavailable":
      return make("storage_unavailable");
    case "identity_unavailable":
      return make("identity_unavailable");
  }
};
const respond = Effect.fn("PlatformHttp.respond")(function* <A>(
  operation: (actor: Model.Actor) => Effect.Effect<A, Model.Failure | Model.InvitationLimited>,
) {
  const context = yield* RequestContext;
  const data = yield* operation(context.actor).pipe(
    Effect.mapError((error) => failure(error, context.meta)),
  );
  return { data, meta: context.meta };
});
/** Like `respond`, with what the Worker vouches for about the request: a website session or not. */
const respondWithEvidence = Effect.fn("PlatformHttp.respondWithEvidence")(function* <A>(
  operation: (actor: Model.Actor, evidence: Model.Evidence) => Effect.Effect<A, Model.Failure>,
) {
  const context = yield* RequestContext;
  return yield* respond((actor) => operation(actor, context.evidence ?? Model.noEvidence));
});
const handlers = HttpApiBuilder.group(P.Api, "platform", (routes) =>
  Effect.gen(function* () {
    const service = yield* Platform.Service;
    const activity = yield* Activity.Service;
    return routes.handleAll({
      dashboard: ({ params, query }) =>
        respond((actor) => activity.home(actor, params.accountId, query)),
      activity: ({ params, query }) =>
        respond((actor) => activity.feed(actor, params.accountId, query)),
      renameAccount: ({ params, payload }) =>
        respondWithEvidence((actor, evidence) =>
          service.renameAccount(actor, evidence, params.accountId, payload),
        ),
      renameServer: ({ params, payload }) =>
        respondWithEvidence((actor, evidence) =>
          service.renameServer(actor, evidence, params.accountId, params.serverId, payload),
        ),
      serverRenames: ({ params }) =>
        respond((actor) => service.serverRenames(actor, params.accountId, params.serverId)),
      deleteServer: ({ params, payload }) =>
        respond((actor) => service.deleteServer(actor, params.accountId, params.serverId, payload)),
      managedServer: ({ params }) =>
        respond((actor) => service.managedServer(actor, params.accountId, params.serverId)),
      currentUser: () =>
        Effect.gen(function* () {
          const context = yield* RequestContext;
          return yield* respond((actor) =>
            service.currentUser(actor).pipe(
              Effect.map((user) => {
                const mcpUrl = new URL("/mcp", context.meta.instructions.url).href;
                const instructionsUrl = context.meta.instructions.url;
                return {
                  user,
                  permissions: { createAccount: true as const },
                  connection:
                    context.signIn === undefined
                      ? { mcpUrl, instructionsUrl }
                      : { mcpUrl, instructionsUrl, signIn: context.signIn },
                };
              }),
            ),
          );
        }),
      createAccount: ({ payload }) => respond((actor) => service.createAccount(actor, payload)),
      listAccounts: ({ query }) => respond((actor) => service.listAccounts(actor, query)),
      getAccount: ({ params }) => respond((actor) => service.getAccount(actor, params.accountId)),
      listMembers: ({ params, query }) =>
        respond((actor) => service.listMembers(actor, params.accountId, query)),
      managedServers: ({ params, query }) =>
        respond((actor) => service.managedServers(actor, params.accountId, query)),
      resumeServer: ({ params }) =>
        respond((actor) => service.resumeServer(actor, params.accountId, params.serverId)),
      listInvitations: ({ params, query }) =>
        respond((actor) => service.listInvitations(actor, params.accountId, query.after)),
      sendInvitation: ({ params, payload }) =>
        respond((actor) => service.sendInvitation(actor, params.accountId, payload)),
      resendInvitation: ({ params }) =>
        respond((actor) => service.resendInvitation(actor, params.accountId, params.invitationId)),
      cancelInvitation: ({ params }) =>
        respond((actor) => service.cancelInvitation(actor, params.accountId, params.invitationId)),
      removeMember: ({ params }) =>
        respond((actor) => service.removeMember(actor, params.accountId, params.userId)),
      createServer: ({ params, payload }) =>
        respond((actor) => service.createServer(actor, params.accountId, payload)),
      discoverServers: ({ query }) =>
        respond((actor) => service.discoverServers(actor, query.after)),
      listGrants: ({ params, query }) =>
        respond((actor) => service.listGrants(actor, params.serverId, query.after)),
      listGrantCandidates: ({ params, query }) =>
        respond((actor) => service.listGrantCandidates(actor, params.serverId, query)),
      grantAccess: ({ params }) =>
        respond((actor) => service.grantAccess(actor, params.serverId, params.userId)),
      revokeAccess: ({ params }) =>
        respond((actor) => service.revokeAccess(actor, params.serverId, params.userId)),
    });
  }),
);
/** Thin platform HTTP adapter over the reusable service layer. */
export const makeHandler = (application: Layer.Layer<Platform.Service | Activity.Service>) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(P.Api).pipe(
      Layer.provide(handlers),
      Layer.provide(application),
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
