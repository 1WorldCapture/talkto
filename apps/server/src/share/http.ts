import { Context, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import * as Share from "@talkto/api/share";
import * as Envelope from "@talkto/api/envelope";
import * as Security from "@talkto/api/security";
import * as M from "@talkto/api/models";
import { share } from "@talkto/api/pricing";
import { trace } from "@talkto/telemetry/effect";
import * as Platform from "../platform/service.js";
import * as PlatformHttp from "../platform/http.js";
import * as Identity from "../platform/model.js";
import * as Metering from "../metering/model.js";
import * as Quotas from "../metering/bindings.js";
import * as Configuration from "../configuration.js";
import * as StarterConfiguration from "../starter/configuration.js";
import * as BillingStripe from "../billing/stripe.js";
import * as Telemetry from "../telemetry.js";
import * as D1 from "./d1.js";
import * as Cards from "./stripe.js";
import * as Model from "./model.js";
import * as Service from "./service.js";

/*
  The Worker boundary for share links (docs/share-links-spec.md): configuration, the adapters for
  each port, the people's API and the minute cron's `share` stage.
*/

const Flag = Schema.Union([Schema.Boolean, Schema.Literals(["true", "false"])]);
const Setting = Schema.Struct({ TALKTO_SHARE_LINKS_ENABLED: Schema.optionalKey(Flag) });
/** `TALKTO_SHARE_LINKS_ENABLED` ("true" or "false", default off). Malformed is off. */
const switchedOn = (env: Env) => {
  const parsed = Schema.decodeUnknownOption(Setting)(env);
  const value = parsed._tag === "Some" ? parsed.value.TALKTO_SHARE_LINKS_ENABLED : undefined;
  return value === true || value === "true";
};

/**
 * Share links run only with the switch on and the free start open: the bonus goes to a free
 * allowance, so without one there is nothing to give. A self-hosted copy has no free start.
 */
export const configuration = Effect.fn("ShareHttp.configuration")(function* (env: Env) {
  // Off (the default) reads nothing else, so no other setting can make it fail.
  if (!switchedOn(env)) return { enabled: false, origin: "" } satisfies Model.Configuration;
  const origin = yield* Configuration.readOrigin(env).pipe(
    Effect.mapError(() => Model.unavailable("configuration.origin")),
  );
  const starter = yield* StarterConfiguration.configuration(env).pipe(
    Effect.orElseSucceed(() => null),
  );
  return {
    enabled: switchedOn(env) && starter !== null && starter.admissions !== null,
    origin,
  } satisfies Model.Configuration;
});

/** This environment's public share offer, for `GET /v1/offers`; null while links are off. */
export const publicOffer = Effect.fn("ShareHttp.publicOffer")(function* (env: Env) {
  const value = yield* configuration(env).pipe(Effect.orElseSucceed(() => null));
  return value?.enabled === true ? Service.offer : null;
});

const ActivityAnswer = Schema.NullOr(
  Schema.Struct({ messages: M.Count, days: Schema.Array(Schema.String) }),
);
/** Each server answers from its own usage journal; any failure means "ask again later". */
const activityLayer = (namespace: Env["SERVERS"]) =>
  Layer.succeed(
    Model.Activity,
    Model.Activity.of({
      metered: (servers, from, to) =>
        Effect.forEach(
          servers,
          (id) =>
            Effect.tryPromise(() => namespace.getByName(id).meteredActivity({ from, to })).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ActivityAnswer)),
              Effect.flatMap((answer) =>
                answer === null ? Effect.fail("unavailable" as const) : Effect.succeed(answer),
              ),
            ),
          { concurrency: 3 },
        ).pipe(
          Effect.map((answers) => ({
            messages: answers.reduce((sum, answer) => sum + answer.messages, 0),
            days: new Set(answers.flatMap((answer) => answer.days)),
          })),
          Effect.orElseSucceed(() => null),
        ),
    }),
  );
/** The quota authority adds bonuses; a free allowance is a free start or a Free plan month. */
const allowancesLayer = (quotas: Metering.Quotas["Service"]) =>
  Layer.succeed(
    Model.Allowances,
    Model.Allowances.of({
      add: (accountId, id) =>
        quotas
          .addBonus(accountId, { id, messages: share.messages })
          .pipe(Effect.mapError(() => Model.unavailable("metering.bonus"))),
      free: (accountId) =>
        quotas.read(accountId).pipe(
          Effect.map(
            (usage) =>
              usage.status !== "payment_required" &&
              (usage.kind === "starter" || usage.kind === "free"),
          ),
          Effect.mapError(() => Model.unavailable("metering.read")),
        ),
    }),
  );
/**
 * Recorded disputes flag an organization. Stripe Radar early fraud warnings and reviews are not
 * recorded by TalkTo; a Radar adapter would answer here too.
 */
const flagsLayer = (database: D1Database) =>
  Layer.succeed(
    Model.Flags,
    Model.Flags.of({
      flagged: (accountId) =>
        Effect.tryPromise({
          try: () =>
            database
              .withSession("first-primary")
              .prepare(
                "SELECT EXISTS(SELECT 1 FROM billing_revocations WHERE account_id=? AND reason='dispute') AS value",
              )
              .bind(accountId)
              .first<{ value: number }>(),
          catch: () => Model.unavailable("storage.read"),
        }).pipe(Effect.map((row) => row?.value === 1)),
    }),
  );
/**
 * Stripe's card fingerprints where hosted billing is on. Billing switched on but misconfigured
 * means cards cannot be compared, so qualifying referrals wait instead of passing unchecked.
 */
const cardsLayer = Effect.fn("ShareHttp.cards")(function* (env: Env) {
  const on = yield* BillingStripe.enabled(env).pipe(Effect.orElseSucceed(() => false));
  if (!on) return Layer.succeed(Model.Cards, Model.noCards);
  const config = yield* BillingStripe.configuration(env).pipe(Effect.option);
  if (config._tag === "None")
    return Layer.succeed(
      Model.Cards,
      Model.Cards.of({ shared: () => Effect.fail(Model.unavailable("billing.configuration")) }),
    );
  return Cards.layer(config.value, BillingStripe.scope(config.value), env.PLATFORM);
});
/** Every port the share-link operations need. */
const ports = Effect.fn("ShareHttp.ports")(function* (env: Env) {
  const quotas = yield* Quotas.configure(env).pipe(
    Effect.mapError(() => Model.unavailable("metering.configure")),
  );
  return Layer.mergeAll(
    D1.layer(env.PLATFORM),
    allowancesLayer(quotas),
    activityLayer(env.SERVERS),
    flagsLayer(env.PLATFORM),
    yield* cardsLayer(env),
  );
});

/** Expected platform failures keep their codes; storage failures are reported. */
const failure = (error: Service.Failure, meta: Envelope.Meta) => {
  if (error._tag === "PlatformFailure") return PlatformHttp.failure(error, meta);
  Telemetry.failure("storage_unavailable", meta.requestId, error);
  return Envelope.makeFailure("storage_unavailable", error.message, meta);
};
const respond = Effect.fn("ShareHttp.respond")(function* <A>(
  operation: (actor: Identity.Actor) => Effect.Effect<A, Service.Failure>,
) {
  const { actor, meta } = yield* PlatformHttp.RequestContext;
  const data = yield* operation(actor).pipe(Effect.mapError((error) => failure(error, meta)));
  return { data, meta };
});
const handlers = HttpApiBuilder.group(Share.Api, "share", (routes) =>
  Effect.gen(function* () {
    const service = yield* Service.Service;
    return routes.handleAll({
      state: ({ params }) => respond((actor) => service.state(actor, params.accountId)),
      link: ({ params }) => respond((actor) => service.link(actor, params.accountId)),
      join: ({ params, payload }) =>
        respond((actor) => service.join(actor, params.accountId, payload)),
    });
  }),
);

/** Whether a path is the share-link API. */
export const isPath = (path: string) =>
  /^\/v1\/accounts\/[^/]+\/share(?:\/(?:link|join))?$/.test(path);

/** Thin authenticated adapter over the shared share-link operations. */
export const handle = Effect.fn("ShareHttp.handle")(function* (
  request: globalThis.Request,
  actor: Identity.Actor,
  meta: Envelope.Meta,
  env: Env,
  platform: Layer.Layer<Platform.Service>,
  identity: Layer.Layer<Platform.Identity>,
) {
  const configured = yield* Effect.all([configuration(env), ports(env)]).pipe(Effect.result);
  if (configured._tag === "Failure")
    return Response.json(failure(configured.failure, meta), { status: 503 });
  const [settings, adapters] = configured.success;
  const web = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(Share.Api).pipe(
      Layer.provide(handlers),
      Layer.provide(Service.layer(settings)),
      Layer.provide([adapters, platform, identity]),
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

/** The minute cron's `share` stage: bounded bonus application and qualification checks. */
export const synchronize = Effect.fn("ShareHttp.synchronize")(function* (env: Env) {
  const settings = yield* configuration(env);
  if (!settings.enabled) return;
  yield* Service.synchronize(settings).pipe(Effect.provide(yield* ports(env)));
});
