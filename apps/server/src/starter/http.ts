import { Context, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import * as S from "@talkto/api/starter";
import * as Envelope from "@talkto/api/envelope";
import * as Security from "@talkto/api/security";
import * as M from "@talkto/api/models";
import { trace } from "@talkto/telemetry/effect";
import * as Platform from "../platform/service.js";
import * as PlatformHttp from "../platform/http.js";
import * as Identity from "../platform/model.js";
import * as Provisioning from "../platform/provisioning-policy.js";
import * as Metering from "../metering/model.js";
import * as Quotas from "../metering/bindings.js";
import * as Telemetry from "../telemetry.js";
import * as Configuration from "./configuration.js";
import * as ShareHttp from "../share/http.js";
import * as D1 from "./d1.js";
import * as Model from "./model.js";
import * as Starter from "./service.js";

/** Expected denials are not incidents; only storage failures reach error reporting. */
export const failure = (error: Model.Failure | Identity.Failure, meta: Envelope.Meta) => {
  switch (error._tag) {
    case "PlatformFailure":
      return PlatformHttp.failure(error, meta);
    case "StarterDenied":
      return error.reason === "owner_only"
        ? Envelope.makeFailure("forbidden", error.message, meta)
        : Envelope.makeFailure("starter_unavailable", error.message, meta);
    case "StarterUnavailable":
      Telemetry.failure("storage_unavailable", meta.requestId, error);
      return Envelope.makeFailure("storage_unavailable", error.message, meta);
  }
};
/** Same failure as a platform value, for onboarding's single error channel. */
export const platformFailure = (error: Model.Failure) =>
  error._tag === "StarterDenied"
    ? new Identity.Failure({ code: "starter_unavailable", message: error.message })
    : new Identity.Failure({ code: "storage_unavailable", message: error.message });

/** Read-only probe of each live server's unreported block; any failure means "not known". */
export const metersLayer = (namespace: Env["SERVERS"]) =>
  Layer.succeed(
    Model.Meters,
    Model.Meters.of({
      unreported: (serverIds, periodStart) =>
        Effect.forEach(
          serverIds,
          (id) =>
            Effect.tryPromise(() => namespace.getByName(id).unreportedUsage()).pipe(
              Effect.flatMap((value) =>
                Schema.decodeUnknownEffect(
                  Schema.NullOr(Schema.Struct({ periodStart: M.Timestamp, used: M.Count })),
                )(value),
              ),
              Effect.map((value) => (value?.periodStart === periodStart ? value.used : 0)),
            ),
          { concurrency: 3 },
        ).pipe(
          Effect.map((counts) => counts.reduce((sum, count) => sum + count, 0)),
          Effect.orElseSucceed(() => null),
        ),
    }),
  );

/** Everything the free start needs beyond the platform application. */
export const application = Effect.fn("StarterHttp.application")(function* (
  env: Env,
  platform: Layer.Layer<Platform.Service>,
) {
  const configuration = yield* Configuration.configuration(env);
  const quotas = yield* Quotas.configure(env).pipe(
    Effect.mapError(() => Model.unavailable("metering.configure")),
  );
  // Missing creation settings already stop every new server; the free start then reports "paused".
  const servers = yield* Provisioning.configuration(env).pipe(Effect.orElseSucceed(() => null));
  const layer = Starter.layer(configuration, servers).pipe(
    Layer.provide([
      platform,
      D1.layer(env.PLATFORM),
      metersLayer(env.SERVERS),
      Layer.succeed(Metering.Quotas, quotas),
      Layer.succeed(Model.Assessment, Model.noAssessment),
    ]),
  );
  return { layer, configuration };
});

/** This environment's public offers, read once per request. */
class Offers extends Context.Service<Offers, S.PublicOffers>()("@talkto/starter/Offers") {}

const respond = Effect.fn("StarterHttp.respond")(function* <A>(
  operation: (
    actor: Identity.Actor,
    evidence: Model.Evidence,
  ) => Effect.Effect<A, Model.Failure | Identity.Failure>,
) {
  const { actor, meta, evidence } = yield* PlatformHttp.RequestContext;
  const data = yield* operation(actor, evidence ?? Identity.noEvidence).pipe(
    Effect.mapError((error) => failure(error, meta)),
  );
  return { data, meta };
});
const handlers = HttpApiBuilder.group(S.Api, "starter", (routes) =>
  Effect.gen(function* () {
    const service = yield* Starter.Service;
    return routes.handleAll({
      eligibility: () => respond(service.eligibility),
      state: ({ params }) =>
        respond((actor, evidence) => service.state(actor, params.accountId, evidence)),
      claim: ({ params, payload }) =>
        respond((actor, evidence) => service.claim(actor, params.accountId, payload, evidence)),
    });
  }),
);
const offerHandlers = HttpApiBuilder.group(S.Api, "offers", (routes) =>
  routes.handleAll({
    offers: () =>
      Effect.gen(function* () {
        const { meta } = yield* PlatformHttp.RequestContext;
        return { data: yield* Offers, meta };
      }),
  }),
);
const publicOffers = (
  configuration: Configuration.Configuration | null,
  share: S.PublicOffers["share"] | null,
): S.PublicOffers => {
  const open = configuration !== null && configuration.admissions !== null;
  const free = open && configuration.free;
  const base: S.PublicOffers = {
    starter: open && !free ? Model.offer : null,
  };
  // Share links (docs/share-links-spec.md) only while they are on; absent otherwise.
  const offers = share === null || share === undefined ? base : { ...base, share };
  // With the switch off the answer is exactly what it was before the Free plan existed.
  return free ? { ...offers, free: Model.freeOffer } : offers;
};

/** Thin authenticated adapter over the shared free-start operations. */
export const handle = Effect.fn("StarterHttp.handle")(function* (
  request: globalThis.Request,
  actor: Identity.Actor,
  meta: Envelope.Meta,
  evidence: Model.Evidence,
  env: Env,
  platform: Layer.Layer<Platform.Service>,
) {
  const configured = yield* application(env, platform).pipe(Effect.result);
  if (configured._tag === "Failure")
    return Response.json(failure(configured.failure, meta), { status: 503 });
  const { layer, configuration } = configured.success;
  const web = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(S.Api).pipe(
      Layer.provide([handlers, offerHandlers]),
      Layer.provide(layer),
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
  const shared = yield* ShareHttp.publicOffer(env);
  try {
    return yield* Effect.promise(() =>
      web.handler(
        request,
        Context.make(PlatformHttp.RequestContext, { actor, meta, evidence }).pipe(
          Context.add(Offers, publicOffers(configuration, shared)),
        ),
      ),
    );
  } finally {
    yield* Effect.promise(() => web.dispose());
  }
});

/**
 * Signed-out offer facts: the Free plan (switch on) or the free start while admissions are open.
 */
export const offers = Effect.fn("StarterHttp.offers")(function* (env: Env, meta: Envelope.Meta) {
  const configuration = yield* Configuration.configuration(env).pipe(
    Effect.orElseSucceed(() => null),
  );
  return Response.json(
    { data: publicOffers(configuration, yield* ShareHttp.publicOffer(env)), meta },
    { headers: { "cache-control": "no-store" } },
  );
});

/** Scheduled publication repair and observation expiry; adds no provider calls. */
export const synchronize = Effect.fn("StarterHttp.synchronize")(function* (env: Env) {
  const configuration = yield* Configuration.configuration(env);
  const quotas = yield* Quotas.configure(env).pipe(
    Effect.mapError(() => Model.unavailable("metering.configure")),
  );
  yield* Starter.synchronize(configuration).pipe(
    Effect.provide([D1.layer(env.PLATFORM), Layer.succeed(Metering.Quotas, quotas)]),
  );
});
