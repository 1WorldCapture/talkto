import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import * as O from "@talkto/api/onboarding";
import * as Security from "@talkto/api/security";
import * as Model from "../platform/model.js";
import { RequestContext, failure } from "../platform/http.js";
import * as Onboarding from "./service.js";
import { trace } from "@talkto/telemetry/effect";
const respond = Effect.fn("OnboardingHttp.respond")(function* <A>(
  operation: (
    actor: Model.Actor,
    evidence: Model.Evidence,
  ) => Effect.Effect<A, Model.Failure | Model.InvitationLimited>,
) {
  const context = yield* RequestContext;
  const data = yield* operation(context.actor, context.evidence ?? Model.noEvidence).pipe(
    Effect.mapError((error) => failure(error, context.meta)),
  );
  return { data, meta: context.meta };
});
const handlers = HttpApiBuilder.group(O.Api, "onboarding", (routes) =>
  Effect.gen(function* () {
    const service = yield* Onboarding.Service;
    return routes.handleAll({
      state: () => respond((actor) => service.state(actor)),
      command: ({ payload }) =>
        respond((actor, evidence) => service.command(actor, payload.command, evidence)),
      progress: ({ query }) => respond((actor) => service.progress(actor, query.runId)),
    });
  }),
);
/** Thin authenticated adapter shares the same verified identity context as platform HTTP. */
export const makeHandler = (application: Layer.Layer<Onboarding.Service>) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(O.Api).pipe(
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
