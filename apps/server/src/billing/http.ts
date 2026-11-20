import { Config, ConfigProvider, Context, DateTime, Effect, Layer, Result } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import * as B from "@talkto/api/billing";
import type * as P from "@talkto/api/platform";
import * as Envelope from "@talkto/api/envelope";
import * as Security from "@talkto/api/security";
import * as Model from "./model.js";
import * as Billing from "./service.js";
import * as Stripe from "./stripe.js";
import * as Entitlements from "../account-entitlements.js";
import * as Metering from "../metering/model.js";
import * as Quotas from "../metering/bindings.js";
import * as D1 from "./d1.js";
import * as Platform from "../platform/service.js";
import * as People from "../platform/people.js";
import * as GuestsD1 from "../guests/d1.js";
import * as M from "@talkto/api/models";
import * as PlatformHttp from "../platform/http.js";
import type * as Identity from "../platform/model.js";
import * as Responses from "../responses.js";
import * as Telemetry from "../telemetry.js";
import { trace } from "@talkto/telemetry/effect";

/** Translate expected billing failures with safe request-correlated diagnostics. */
export function failure(error: Model.Failure, meta: Envelope.Meta) {
  return Responses.failure(
    error.code === "billing_unavailable"
      ? 503
      : error.code === "billing_conflict"
        ? 409
        : error.code === "forbidden"
          ? 403
          : 400,
    error.code,
    error.message,
    meta,
    error,
  );
}
const respond = Effect.fn("BillingHttp.respond")(function* <A>(
  operation: (actor: Identity.Actor) => Effect.Effect<A, Identity.Failure | Model.Failure>,
) {
  const { actor, meta } = yield* PlatformHttp.RequestContext;
  const data = yield* operation(actor).pipe(
    Effect.mapError((error) => {
      if (error._tag === "PlatformFailure") return PlatformHttp.failure(error, meta);
      Telemetry.failure(error.code, meta.requestId, error, "billing");
      switch (error.code) {
        case "billing_unavailable":
          return Envelope.makeFailure("billing_unavailable", error.message, meta);
        case "billing_conflict":
          return Envelope.makeFailure("billing_conflict", error.message, meta);
        case "invalid_input":
          return Envelope.makeFailure("invalid_input", error.message, meta);
        case "forbidden":
          return Envelope.makeFailure("forbidden", error.message, meta);
      }
    }),
  );
  return { data, meta };
});
const handlers = HttpApiBuilder.group(B.Api, "billing", (routes) =>
  Effect.gen(function* () {
    const service = yield* Billing.Service;
    return routes.handleAll({
      state: ({ params }) => respond((actor) => service.state(actor, params.accountId)),
      checkout: ({ params, payload }) =>
        respond((actor) => service.checkout(actor, params.accountId, payload)),
      cancelCheckout: ({ params, payload }) =>
        respond((actor) => service.cancelCheckout(actor, params.accountId, payload)),
      confirmCheckout: ({ params }) =>
        respond((actor) => service.confirmCheckout(actor, params.accountId)),
      portal: ({ params }) => respond((actor) => service.portal(actor, params.accountId)),
      changePlan: ({ params, payload }) =>
        respond((actor) => service.changePlan(actor, params.accountId, payload)),
      keepPlan: ({ params, payload }) =>
        respond((actor) => service.keepPlan(actor, params.accountId, payload.requestKey)),
      renewal: ({ params, payload }) =>
        respond((actor) => service.renewal(actor, params.accountId, payload)),
      startPaid: ({ params, payload }) =>
        respond((actor) => service.startPaid(actor, params.accountId, payload.requestKey)),
    });
  }),
);
const makeLayer = Effect.fn("BillingHttp.configure")(function* (
  env: Env,
  application: Layer.Layer<Platform.Service>,
) {
  if (!(yield* Stripe.enabled(env)))
    return yield* new Model.Failure({
      code: "billing_unavailable",
      operation: "configuration.disabled",
      message: Entitlements.isSelfHosted(env)
        ? "This is a self-hosted TalkTo. Billing is off, and every organization is unlimited."
        : "Billing is not enabled in this environment.",
    });
  const config = yield* Stripe.configuration(env);
  const quotas = yield* Quotas.configure(env).pipe(
    Effect.mapError(() => Model.unavailable("metering.configure")),
  );
  return Billing.layer(config.trials, Stripe.scope(config)).pipe(
    Layer.provide([
      application,
      D1.layer(env.PLATFORM, Stripe.scope(config)),
      Stripe.layer(config),
      Layer.succeed(Metering.Quotas, quotas),
    ]),
  );
});
/** Existing verified human context feeds typed billing handlers; no MCP purchasing surface. */
export const handle = Effect.fn("BillingHttp.handle")(function* (
  request: Request,
  actor: Identity.Actor,
  meta: Envelope.Meta,
  env: Env,
  application: Layer.Layer<Platform.Service>,
) {
  const configured = yield* makeLayer(env, application).pipe(Effect.result);
  if (Result.isFailure(configured)) return failure(configured.failure, meta);
  const web = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(B.Api).pipe(
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
/**
 * Signed webhook receipt needs no human session and persists before acknowledging Stripe. Returns
 * the organization of a newly recorded event, for `apply`.
 */
export const receive = Effect.fn("BillingHttp.receive")(function* (
  payload: string,
  signature: string,
  env: Env,
) {
  if (!(yield* Stripe.enabled(env))) return yield* Model.unavailable("configuration.disabled");
  const config = yield* Stripe.configuration(env);
  return yield* Billing.receive(payload, signature).pipe(
    Effect.provide([Stripe.layer(config), D1.layer(env.PLATFORM, Stripe.scope(config))]),
  );
});
/**
 * Apply a recorded event's organization before answering Stripe, within a bound that keeps the
 * acknowledgment prompt. A failure or timeout is only logged: the event stays marked for the cron.
 */
export const apply = Effect.fn("BillingHttp.apply")(function* (
  env: Env,
  id: P.AccountId,
  requestId: string,
) {
  const outcome = yield* Effect.gen(function* () {
    const config = yield* Stripe.configuration(env);
    const quotas = yield* Quotas.configure(env).pipe(
      Effect.mapError(() => Model.unavailable("metering.configure")),
    );
    yield* Billing.apply(id).pipe(
      Effect.provide([
        D1.layer(env.PLATFORM, Stripe.scope(config)),
        Stripe.layer(config),
        Layer.succeed(Metering.Quotas, quotas),
      ]),
    );
  }).pipe(Effect.timeoutOption("8 seconds"), Effect.result);
  if (Result.isSuccess(outcome) && outcome.success._tag === "None")
    yield* Effect.logWarning("Billing event will be applied by the scheduled repair", {
      requestId,
      code: "timeout",
      operation: "billing.apply",
    });
  if (Result.isFailure(outcome))
    yield* Effect.logWarning("Billing event will be applied by the scheduled repair", {
      requestId,
      code: outcome.failure.code,
      operation: outcome.failure.operation,
    });
});
/**
 * Account deletion's billing step: cancel the organization's subscription at once. Disabled
 * billing has no subscriptions to cancel and makes no calls.
 */
export const close = Effect.fn("BillingHttp.close")(function* (env: Env, id: P.AccountId) {
  if (!(yield* Stripe.enabled(env))) return;
  const config = yield* Stripe.configuration(env);
  const quotas = yield* Quotas.configure(env).pipe(
    Effect.mapError(() => Model.unavailable("metering.configure")),
  );
  yield* Billing.close(id).pipe(
    Effect.provide([
      D1.layer(env.PLATFORM, Stripe.scope(config)),
      Stripe.layer(config),
      Layer.succeed(Metering.Quotas, quotas),
    ]),
  );
});
/** Independent scheduled billing repair; disabled billing adds no provider or storage calls. */
export const synchronize = Effect.fn("BillingHttp.synchronize")(function* (env: Env) {
  if (!(yield* Stripe.enabled(env))) return;
  const config = yield* Stripe.configuration(env);
  const quotas = yield* Quotas.configure(env).pipe(
    Effect.mapError(() => Model.unavailable("metering.configure")),
  );
  yield* Billing.synchronize().pipe(
    Effect.provide([
      D1.layer(env.PLATFORM, Stripe.scope(config)),
      Stripe.layer(config),
      Layer.succeed(Metering.Quotas, quotas),
    ]),
  );
});

/**
 * Scheduled: keep the current plan when a scheduled move to Shop would start with more people than
 * Shop includes. The identity provider is asked only when such a move starts within two hours.
 */
export const holdDowngrades = Effect.fn("BillingHttp.holdDowngrades")(function* (
  env: Env,
  identity: Effect.Effect<Layer.Layer<Platform.Identity>, Identity.Failure>,
) {
  if (!(yield* Stripe.enabled(env))) return;
  const config = yield* Stripe.configuration(env);
  const quotas = yield* Quotas.configure(env).pipe(
    Effect.mapError(() => Model.unavailable("metering.configure")),
  );
  const unlimited = yield* Config.all({ grant: Entitlements.unlimitedAccounts }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Effect.mapError(() => Model.unavailable("configuration.unlimited_accounts")),
  );
  let directory: Platform.Identity["Service"] | null = null;
  const people = Effect.fn("BillingHttp.countPeople")(function* (
    downgrade: Model.Downgrade,
    limit: number,
  ) {
    if (Entitlements.covers(unlimited.grant, downgrade.accountId)) return null;
    // Built on first use only: most minutes have no move to check.
    const service: Platform.Identity["Service"] =
      directory ??
      (yield* Effect.gen(function* () {
        return yield* Platform.Identity;
      }).pipe(
        Effect.provide(yield* identity.pipe(Effect.mapError(() => Model.unavailable("identity")))),
      ));
    directory = service;
    const at = M.Timestamp.make(DateTime.formatIso(yield* DateTime.now));
    return yield* People.count(
      service,
      GuestsD1.places(env.PLATFORM),
      downgrade.organizationId,
      at,
      limit,
    ).pipe(Effect.mapError(() => Model.unavailable("people.count")));
  });
  yield* Billing.holdDowngrades(people).pipe(
    Effect.provide([
      D1.layer(env.PLATFORM, Stripe.scope(config)),
      Stripe.layer(config),
      Layer.succeed(Metering.Quotas, quotas),
    ]),
  );
});
