import { Context, DateTime, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import * as G from "@talkto/api/guests";
import * as Envelope from "@talkto/api/envelope";
import * as Security from "@talkto/api/security";
import * as M from "@talkto/api/models";
import { trace } from "@talkto/telemetry/effect";
import { capabilities } from "../capabilities.js";
import * as Configuration from "../configuration.js";
import * as EmailHttp from "../email/http.js";
import type * as EmailModel from "../email/model.js";
import * as Platform from "../platform/service.js";
import * as PlatformHttp from "../platform/http.js";
import * as PlatformModel from "../platform/model.js";
import * as PlatformD1 from "../platform/d1.js";
import * as InvitationD1 from "../platform/invitation-d1.js";
import * as InvitationPolicy from "../platform/invitation-policy.js";
import * as Provisioning from "../platform/provisioning-policy.js";
import * as Servers from "../platform/servers.js";
import * as Telemetry from "../telemetry.js";
import * as D1 from "./d1.js";
import * as Model from "./model.js";
import * as Service from "./service.js";

/*
  The Worker boundary for server guests (docs/dashboard-api.md, "Server guests"): the adapters for
  each port, the people's API and the minute cron's clean-up.
*/

/** A queue that failed: reported without any address, and the inviter shares the link instead. */
const unqueued = (error: PlatformModel.Failure | EmailModel.Failure) =>
  Effect.sync(() =>
    Telemetry.failure(error.code, crypto.randomUUID(), error, "email", "warning", "guests.mail"),
  );

/**
 * The invitation and "joined" emails, queued in TalkTo's own email outbox (docs/email.md, "Server
 * invitations") and sent by the minute cron. While `TALKTO_EMAIL` is off nothing is queued and
 * the invitation travels by its copyable link.
 */
const mailLayer = (env: Env) =>
  Layer.effect(
    Model.Mail,
    Effect.gen(function* () {
      const identity = yield* Platform.Identity;
      return Model.Mail.of({
        invited: (row) =>
          identity.user(row.inviterId).pipe(
            Effect.flatMap((inviter) =>
              EmailHttp.queueServerInvitation(env, row, Model.personName(inviter)),
            ),
            Effect.catch((error) => unqueued(error).pipe(Effect.as(false))),
          ),
        joined: (row, guest) =>
          EmailHttp.queueServerJoined(env, row, Model.personName(guest)).pipe(
            Effect.catch(unqueued),
          ),
      });
    }),
  );

/** Every port the guest operations need, over this deployment's bindings. */
const application = Effect.fn("GuestsHttp.application")(function* (
  env: Env,
  identity: Layer.Layer<Platform.Identity>,
) {
  const origin = yield* Configuration.readOrigin(env).pipe(
    Effect.mapError(
      () =>
        new PlatformModel.Failure({
          code: "storage_unavailable",
          message: "Server invitations are not configured.",
        }),
    ),
  );
  return Service.layer.pipe(
    Layer.provide([
      PlatformD1.layer(env.PLATFORM, Provisioning.configuration(env)),
      identity,
      Servers.layer(env.SERVERS, capabilities(env)),
      InvitationD1.layer(env.PLATFORM, InvitationPolicy.configuration(env)),
      D1.layer(env.PLATFORM),
      mailLayer(env).pipe(Layer.provide(identity)),
      Layer.succeed(Model.Settings, Model.Settings.of({ origin })),
    ]),
  );
});

/** Guest refusals answer with their own codes; platform failures keep the shared ones. */
const failure = (error: Model.Failure, meta: Envelope.Meta) => {
  if (error._tag !== "GuestRefusal") return PlatformHttp.failure(error, meta);
  Telemetry.failure(error.code, meta.requestId, error);
  switch (error.code) {
    case "invitation_email_mismatch":
      return {
        error: { code: error.code, message: error.message, sentTo: error.sentTo ?? "" },
        meta,
      };
    case "email_unverified":
      return { error: { code: error.code, message: error.message }, meta };
    case "invitation_unavailable":
      return { error: { code: error.code, message: error.message }, meta };
  }
};
const respond = Effect.fn("GuestsHttp.respond")(function* <A>(
  operation: (actor: PlatformModel.Actor) => Effect.Effect<A, Model.Failure>,
) {
  const { actor, meta } = yield* PlatformHttp.RequestContext;
  const data = yield* operation(actor).pipe(Effect.mapError((error) => failure(error, meta)));
  return { data, meta };
});
const handlers = HttpApiBuilder.group(G.Api, "guests", (routes) =>
  Effect.gen(function* () {
    const service = yield* Service.Service;
    return routes.handleAll({
      listServerInvitations: ({ params }) =>
        respond((actor) => service.list(actor, params.serverId)),
      inviteGuest: ({ params, payload }) =>
        respond((actor) => service.invite(actor, params.serverId, payload)),
      resendServerInvitation: ({ params }) =>
        respond((actor) => service.resend(actor, params.serverId, params.invitationId)),
      cancelServerInvitation: ({ params }) =>
        respond((actor) => service.cancel(actor, params.serverId, params.invitationId)),
      previewInvitation: ({ params }) =>
        respond((actor) => service.preview(actor, params.invitationId)),
      acceptInvitation: ({ params }) =>
        respond((actor) => service.accept(actor, params.invitationId)),
      shared: () => respond((actor) => service.shared(actor)),
    });
  }),
);

/** Whether a path is the server-guest API. */
export const isPath = (path: string) =>
  /^\/v1\/servers\/[^/]+\/invitations(?:\/[^/]+(?:\/resend)?)?$/.test(path) ||
  /^\/v1\/invitations\/[^/]+(?:\/accept)?$/.test(path) ||
  path === "/v1/shared";

/** Thin authenticated adapter over the shared guest operations. */
export const handle = Effect.fn("GuestsHttp.handle")(function* (
  request: globalThis.Request,
  actor: PlatformModel.Actor,
  meta: Envelope.Meta,
  env: Env,
  identity: Layer.Layer<Platform.Identity>,
) {
  const configured = yield* application(env, identity).pipe(Effect.result);
  if (configured._tag === "Failure")
    return Response.json(PlatformHttp.failure(configured.failure, meta), { status: 503 });
  const web = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(G.Api).pipe(
      Layer.provide(handlers),
      Layer.provide(configured.success),
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

/** The minute cron's `guests` stage: delete invitations kept past their 30 days. */
export const prune = Effect.fn("GuestsHttp.prune")(function* (env: Env) {
  yield* D1.prune(env.PLATFORM, M.Timestamp.make(DateTime.formatIso(yield* DateTime.now)));
});
