import { Context, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import * as S from "@talkto/api/sign-ins";
import * as Envelope from "@talkto/api/envelope";
import * as Security from "@talkto/api/security";
import { run, trace } from "@talkto/telemetry/effect";
import * as PlatformHttp from "../platform/http.js";
import * as Model from "../platform/model.js";
import * as Platform from "../platform/service.js";
import * as Telemetry from "../telemetry.js";
import * as Store from "./store.js";
import * as SignIns from "./service.js";

/*
  The Worker boundary for signed-in computers: the MCP admission check, the person's API, and the
  minute cron's retention stage.
*/

const defaultLifetimeSeconds = 86_400;
const Lifetime = Schema.Struct({
  TALKTO_MCP_TOKEN_MAX_LIFETIME_SECONDS: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 300, maximum: 2_592_000 }),
    ),
  ),
});
/**
 * `TALKTO_MCP_TOKEN_MAX_LIFETIME_SECONDS` (default 86400, 300 to 2592000): how long a client-wide
 * sign-out is enforced. Keep it at least AuthKit's access token duration. A malformed value uses
 * the default rather than breaking sign-out; the production preflight rejects it before a deploy.
 */
export const settings = (env: Env): SignIns.Settings => {
  const parsed = Schema.decodeUnknownOption(Lifetime)(env);
  if (Option.isNone(parsed))
    console.warn("TalkTo ignored an invalid TALKTO_MCP_TOKEN_MAX_LIFETIME_SECONDS value");
  const seconds = Option.match(parsed, {
    onNone: () => defaultLifetimeSeconds,
    onSome: (value) => value.TALKTO_MCP_TOKEN_MAX_LIFETIME_SECONDS ?? defaultLifetimeSeconds,
  });
  return { maxTokenLifetimeMs: seconds * 1000 };
};

const Location = Schema.Struct({
  city: Schema.optionalKey(Schema.String),
  country: Schema.optionalKey(Schema.String),
});
const bounded = (value: string | undefined, limit: number) => {
  const text = value?.trim();
  return text === undefined || text.length === 0 ? null : text.slice(0, limit);
};
/**
 * What TalkTo records about an MCP request: the User-Agent's first product, and Cloudflare's city
 * and country. Never the IP address.
 */
export const observe = (request: Request): SignIns.Observed => {
  const agent = request.headers.get("user-agent")?.match(/^([A-Za-z][A-Za-z0-9._-]{0,39})/)?.[1];
  const location = Option.getOrUndefined(Schema.decodeUnknownOption(Location)(request.cf));
  return {
    agent: agent === undefined ? null : agent.toLowerCase(),
    city: bounded(location?.city, 80),
    country: bounded(location?.country, 8),
  };
};

/**
 * Refuse a signed-out MCP sign-in, and record the request after the response. True when the
 * token is refused. Tokens that name no client are neither checked nor recorded.
 */
export const admit = Effect.fn("SignInsHttp.admit")(function* (
  env: Env,
  actor: Model.Actor,
  request: Request,
  requestId: string,
  waitUntil: (task: Promise<unknown>) => void,
) {
  if (actor.mcpClient === undefined) return false;
  const report = (error: Model.Failure, operation: string) =>
    Telemetry.failure(error.code, requestId, error, "mcp", "warning", operation);
  const decided = yield* SignIns.admit(
    actor.userId,
    actor.mcpClient,
    observe(request),
    report,
  ).pipe(Effect.provide(Store.layer(env.PLATFORM)));
  if (decided.background !== null)
    waitUntil(run(decided.background.pipe(Effect.provide(Store.layer(env.PLATFORM)))));
  return decided.revoked;
});

/** The minute cron's retention stage. */
export const prune = Effect.fn("SignInsHttp.prune")(function* (env: Env) {
  const deleted = yield* SignIns.prune().pipe(Effect.provide(Store.layer(env.PLATFORM)));
  if (deleted.sessions > 0 || deleted.revocations > 0)
    yield* Effect.logInfo("TalkTo signed-in computers retention", deleted);
});

const respond = Effect.fn("SignInsHttp.respond")(function* <A>(
  operation: (actor: Model.Actor) => Effect.Effect<A, Model.Failure>,
) {
  const { actor, meta } = yield* PlatformHttp.RequestContext;
  const data = yield* operation(actor).pipe(
    Effect.mapError((error) => PlatformHttp.failure(error, meta)),
  );
  return { data, meta };
});
const handlers = (configured: SignIns.Settings) =>
  HttpApiBuilder.group(S.Api, "signIns", (routes) =>
    Effect.gen(function* () {
      const store = yield* Store.Store;
      const identity = yield* Platform.Identity;
      const provided = <A>(
        operation: Effect.Effect<A, Model.Failure, Store.Store | Platform.Identity>,
      ) =>
        operation.pipe(
          Effect.provideService(Store.Store, store),
          Effect.provideService(Platform.Identity, identity),
        );
      return routes.handleAll({
        list: () => respond((actor) => provided(SignIns.list(actor))),
        signOut: ({ params, payload }) =>
          respond((actor) =>
            provided(SignIns.signOut(actor, params.id, payload.scope ?? "this", configured)),
          ),
      });
    }),
  );

/** Whether a path is the signed-in computers API. */
export const isPath = (path: string) => /^\/v1\/me\/sign-ins(?:\/[^/]+\/sign-out)?$/.test(path);

/** The signed-in person's own sign-ins. Each route reads and changes only the caller's rows. */
export const handle = Effect.fn("SignInsHttp.handle")(function* (
  request: Request,
  actor: Model.Actor,
  meta: Envelope.Meta,
  env: Env,
  identity: Layer.Layer<Platform.Identity>,
) {
  const web = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(S.Api).pipe(
      Layer.provide(handlers(settings(env))),
      Layer.provide(Store.layer(env.PLATFORM)),
      Layer.provide(identity),
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
