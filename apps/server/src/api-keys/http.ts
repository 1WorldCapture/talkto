import { Clock, Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import * as K from "@talkto/api/api-keys";
import * as Envelope from "@talkto/api/envelope";
import * as Security from "@talkto/api/security";
import { run, trace } from "@talkto/telemetry/effect";
import * as PlatformHttp from "../platform/http.js";
import * as Model from "../platform/model.js";
import * as Guard from "./guard.js";
import * as Store from "./store.js";
import * as ApiKeys from "./service.js";

/*
  The Worker boundary for personal API keys: the person's routes, and turning a key into its person
  before any other route runs.
*/

const respond = Effect.fn("ApiKeysHttp.respond")(function* <A>(
  operation: (actor: Model.Actor, evidence: Model.Evidence) => Effect.Effect<A, Model.Failure>,
) {
  const { actor, meta, evidence } = yield* PlatformHttp.RequestContext;
  const data = yield* operation(actor, evidence ?? Model.noEvidence).pipe(
    Effect.mapError((error) => PlatformHttp.failure(error, meta)),
  );
  return { data, meta };
});
const handlers = HttpApiBuilder.group(K.Api, "apiKeys", (routes) =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    const guard = yield* Guard.Guard;
    const provided = <A>(operation: Effect.Effect<A, Model.Failure, Store.Store | Guard.Guard>) =>
      operation.pipe(
        Effect.provideService(Store.Store, store),
        Effect.provideService(Guard.Guard, guard),
      );
    return routes.handleAll({
      list: () => respond((actor) => provided(ApiKeys.list(actor))),
      create: ({ payload }) =>
        respond((actor, evidence) => provided(ApiKeys.create(actor, payload, evidence))),
      revoke: ({ params }) => respond((actor) => provided(ApiKeys.revoke(actor, params.id))),
    });
  }),
);

/**
 * A 429 for a network that sent too many bad keys, or null: checked before the key is looked up, so
 * a flood of guesses costs no D1 read. A key this isolate already checked passes, so a person's
 * working key is not locked out with the guesses.
 */
export const refusedNetwork = Effect.fn("ApiKeysHttp.refusedNetwork")(function* (
  env: Env,
  request: Request,
  credential: string,
  meta: Envelope.Meta,
) {
  const seconds = yield* Guard.make(env, request).retryAfter;
  if (seconds === null || (yield* ApiKeys.remembered(credential))) return null;
  return Response.json(
    {
      error: {
        code: "rate_limited",
        message:
          "Too many requests with an unknown, revoked or expired API key came from this network. Wait, then try again with a valid key.",
        retryable: true,
        action: "retry_after",
        retryAfterSeconds: seconds,
        scope: "network",
      },
      meta,
    },
    { status: 429, headers: { "retry-after": String(seconds) } },
  );
});

/** Whether a path is the API keys routes. */
export const isPath = (path: string) => /^\/v1\/me\/api-keys(?:\/[^/]+)?$/.test(path);

/** Whether a request's bearer credential is an API key rather than a WorkOS token. */
export const bearerKey = (request: Request) => {
  const credential = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  return credential !== undefined && K.looksLikeKey(credential) ? credential : undefined;
};

/**
 * The person an API key acts as, refused when the key may not make this request. The key's last use
 * is recorded after the response through `waitUntil`.
 */
export const authenticate = Effect.fn("ApiKeysHttp.authenticate")(function* (
  env: Env,
  credential: string,
  request: Request,
  waitUntil: (task: Promise<unknown>) => void,
) {
  const layer = Store.layer(env.PLATFORM);
  const verified = yield* ApiKeys.verify(credential).pipe(
    Effect.provide(layer),
    Effect.provideService(Guard.Guard, Guard.make(env, request)),
  );
  yield* ApiKeys.permits(verified.key, request.method, new URL(request.url).pathname).pipe(
    Effect.provide(layer),
  );
  if (verified.record) {
    const at = yield* Clock.currentTimeMillis;
    waitUntil(
      run(
        Store.Store.pipe(
          Effect.flatMap((store) => store.used(verified.key.id, at, ApiKeys.usedInterval)),
          Effect.provide(layer),
          Effect.ignore,
        ),
      ),
    );
  }
  return verified.actor;
});

/** The signed-in person's own API keys. Each route reads and changes only the caller's keys. */
export const handle = Effect.fn("ApiKeysHttp.handle")(function* (
  request: Request,
  actor: Model.Actor,
  meta: Envelope.Meta,
  evidence: Model.Evidence,
  env: Env,
) {
  const web = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(K.Api).pipe(
      Layer.provide(handlers),
      Layer.provide(Store.layer(env.PLATFORM)),
      Layer.provide(Layer.succeed(Guard.Guard, Guard.make(env, null))),
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
      web.handler(request, Context.make(PlatformHttp.RequestContext, { actor, meta, evidence })),
    );
  } finally {
    yield* Effect.promise(() => web.dispose());
  }
});
