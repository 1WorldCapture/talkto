import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import * as AI from "@talkto/api/agent-invites";
import * as Envelope from "@talkto/api/envelope";
import * as Security from "@talkto/api/security";
import { trace } from "@talkto/telemetry/effect";
import * as Access from "../access.js";
import * as Persons from "../people.js";
import * as PlatformHttp from "../platform/http.js";
import type * as Model from "../platform/model.js";
import * as Guard from "./guard.js";
import * as Invites from "./service.js";
import * as Store from "./store.js";

/*
  The Worker boundary for agent invites (docs/agent-invites.md):
  - `/v1/agent-invites/…`: redeeming a code and checking a request, with no sign-in;
  - `/v1/servers/{serverId}/agent-invites…`: links, the waiting list and the mode;
  - an invited agent's key (`tka_`): checked here, with no D1 read, and admitted only to an explicit
    list of agent routes on its own server. It is never a person and never carries the website or
    API-key marker.
*/

/** The request's caller and envelope metadata, for the invite routes. */
export class RequestContext extends Context.Service<
  RequestContext,
  {
    readonly caller: Invites.Caller;
    readonly meta: Envelope.Meta;
    readonly request: Request;
    readonly origin: string;
  }
>()("@talkto/invites/RequestContext") {}

/** The server objects, as invites call them. */
export const servers = (env: Env): Invites.Servers => ({
  inviter: (serverId, principal, participantId) =>
    env.SERVERS.getByName(serverId).inviter(principal, participantId),
  admit: (input) => env.SERVERS.getByName(input.serverId).admitInvited(input),
  name: (serverId, name) => env.SERVERS.getByName(serverId).inviteName(name),
  removeInvitedBy: (serverId, principal, name, participantId) =>
    env.SERVERS.getByName(serverId).removeInvitedBy(principal, name, participantId),
});

/** Whether a request is an agent removal, however its path is spelled (case, extra slashes). */
export const isRemoval = (method: string, path: string) =>
  method.toUpperCase() === "POST" &&
  /^\/v1\/servers\/[^/]+\/participants\/[^/]+\/remove$/.test(
    path.replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase(),
  );

const RemovalAnswer = Schema.fromJsonString(
  Schema.Struct({ data: Schema.Struct({ participant: Schema.Struct({ id: Schema.String }) }) }),
);

/**
 * After a person removed an agent: revoke the invite links it made, naming the agent as the server
 * object's answer does. Removal itself is the server object's; if this fails, `admitInvited`
 * still refuses newcomers through those links.
 */
export const removed = Effect.fn("InvitesHttp.removed")(function* (
  env: Env,
  serverId: string,
  response: Response,
) {
  if (response.status !== 200) return;
  const text = yield* Effect.promise(() => response.clone().text());
  const answer = Schema.decodeUnknownOption(RemovalAnswer)(text);
  if (Option.isNone(answer)) return;
  const participantId = answer.value.data.participant.id;
  yield* Store.Store.use((store) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) =>
      store.revokeMadeBy(serverId, participantId, at),
    ),
  ).pipe(Effect.provide(Store.layer(env.PLATFORM)), Effect.ignore);
});

const failure = (error: Invites.InviteFailure, meta: Envelope.Meta) => {
  const make = <const C extends Envelope.SimpleFailureCode>(code: C) =>
    Envelope.makeFailure(code, error.message, meta);
  switch (error.code) {
    case "forbidden":
      return make("forbidden");
    case "not_found":
      return make("not_found");
    case "server_unavailable":
      return make("server_unavailable");
    case "storage_unavailable":
      return make("storage_unavailable");
    case "idempotency_conflict":
      return make("idempotency_conflict");
    case "name_taken":
      return make("name_taken");
    case "waiting_list_full":
      return make("waiting_list_full");
  }
};

const respond = Effect.fn("InvitesHttp.respond")(function* <A, R>(
  operation: (
    caller: Invites.Caller,
    context: RequestContext["Service"],
  ) => Effect.Effect<A, Invites.InviteFailure | Model.Failure, R>,
) {
  const context = yield* RequestContext;
  const data = yield* operation(context.caller, context).pipe(
    Effect.mapError((error) =>
      error._tag === "InviteFailure"
        ? failure(error, context.meta)
        : PlatformHttp.failure(error, context.meta),
    ),
  );
  return { data, meta: context.meta };
});

const handlers = (env: Env) =>
  HttpApiBuilder.group(AI.Api, "agentInvites", (routes) =>
    Effect.gen(function* () {
      const store = yield* Store.Store;
      const at = servers(env);
      const stored = <A, E>(effect: Effect.Effect<A, E, Store.Store>) =>
        effect.pipe(Effect.provideService(Store.Store, store));
      return routes.handleAll({
        create: ({ params, payload }) =>
          respond((caller, context) =>
            stored(Invites.create(env, at, caller, params.serverId, payload, context.origin)),
          ),
        list: ({ params }) =>
          respond((caller) => stored(Invites.list(at, caller, params.serverId))),
        revoke: ({ params }) =>
          respond((caller) => stored(Invites.revoke(at, caller, params.serverId, params.inviteId))),
        requests: ({ params }) =>
          respond((caller) => stored(Invites.requests(at, caller, params.serverId))),
        approve: ({ params }) =>
          respond((caller) =>
            stored(Invites.decide(at, caller, params.serverId, params.requestId, "approved")),
          ),
        decline: ({ params }) =>
          respond((caller) =>
            stored(Invites.decide(at, caller, params.serverId, params.requestId, "declined")),
          ),
        removeInvited: ({ params }) =>
          respond((caller) =>
            stored(Invites.removeInvited(at, caller, params.serverId, params.participantId)),
          ),
        mode: ({ params }) =>
          respond((caller) => stored(Invites.mode(at, caller, params.serverId))),
        setMode: ({ params, payload }) =>
          respond((caller) => stored(Invites.setMode(at, caller, params.serverId, payload))),
      });
    }),
  );

/** The pickup header, when it is shaped like a minted secret; else null. */
const pickupOf = (request: Request) => {
  const header = request.headers.get(AI.pickupHeader);
  return header !== null && AI.isPickup(header) ? header : null;
};

const joinHandlers = (env: Env) =>
  HttpApiBuilder.group(AI.Api, "agentJoin", (routes) =>
    Effect.gen(function* () {
      const store = yield* Store.Store;
      const at = servers(env);
      const stored = <A, E>(effect: Effect.Effect<A, E, Store.Store>) =>
        effect.pipe(Effect.provideService(Store.Store, store));
      return routes.handleAll({
        redeem: ({ payload }) =>
          respond((_, context) => stored(Invites.redeem(env, at, context.request, payload))),
        check: ({ params, query }) =>
          respond((_, context) =>
            stored(
              Invites.check(
                env,
                at,
                context.request,
                params.requestId,
                // Only a minted secret's shape is checked; anything else matches no request.
                pickupOf(context.request),
                query.wait ?? 0,
                query.name ?? null,
              ),
            ),
          ),
      });
    }),
  );

const serve = Effect.fn("InvitesHttp.serve")(function* (
  request: Request,
  env: Env,
  context: RequestContext["Service"],
) {
  const web = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(AI.Api).pipe(
      Layer.provide(handlers(env)),
      Layer.provide(joinHandlers(env)),
      Layer.provide(Store.layer(env.PLATFORM)),
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
    return yield* Effect.promise(() => web.handler(request, Context.make(RequestContext, context)));
  } finally {
    yield* Effect.promise(() => web.dispose());
  }
});

const nobody: Invites.Caller = {
  principal: Access.invitedKey("0".repeat(64)),
  userId: null,
  name: null,
  byPerson: false,
};

/** Behind Cloudflare Access an invited agent's key cannot work, so joining is refused there. */
export const hostedOnly = (meta: Envelope.Meta) =>
  Response.json(
    {
      error: {
        code: "forbidden",
        message: "Agent invites do not work on a copy behind Cloudflare Access.",
      },
      meta,
    },
    { status: 403 },
  );

/** Redeeming and checking a request: no sign-in, so they are routed before any. */
export const isJoinPath = (path: string) => path.startsWith("/v1/agent-invites/");
/** A server's invite links, waiting list and mode. */
export const isServerPath = (path: string) =>
  /^\/v1\/servers\/[^/]+\/agent-invites(\/|$)/.test(path);

/** A 429 when this network sent too many wrong codes, keys or pickup secrets; else null. */
const refused = Effect.fn("InvitesHttp.refused")(function* (request: Request, meta: Envelope.Meta) {
  const seconds = yield* Guard.retryAfter(request);
  if (seconds === null) return null;
  return Response.json(
    {
      error: {
        code: "rate_limited",
        message: `Too many invite requests, or wrong codes or keys, from this network. Wait ${seconds} seconds, then try again.`,
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

/** Redeem a code or check a request. */
export const join = Effect.fn("InvitesHttp.join")(function* (
  request: Request,
  env: Env,
  meta: Envelope.Meta,
  origin: string,
) {
  const blocked = yield* refused(request, meta);
  if (blocked !== null) return blocked;
  // Every redeem and check counts against the network, valid or not.
  if (!(yield* Guard.used(env, request))) {
    const limited = yield* refused(request, meta);
    if (limited !== null) return limited;
  }
  return yield* serve(request, env, { caller: nobody, meta, request, origin });
});

/** A person's call to a server's invite routes. */
export const handle = Effect.fn("InvitesHttp.handle")(function* (
  request: Request,
  env: Env,
  caller: Invites.Caller,
  meta: Envelope.Meta,
  origin: string,
) {
  return yield* serve(request, env, { caller, meta, request, origin });
});

/** The `tka_` key a request carries as its bearer, if any. */
export const bearerKey = (request: Request) => {
  const value = request.headers.get("authorization");
  const match = value === null ? null : /^Bearer\s+(\S+)$/i.exec(value);
  const credential = match?.[1];
  return credential !== undefined && AI.looksLikeInvitedKey(credential) ? credential : undefined;
};

/**
 * The agent routes an invited agent may call on its own server, by method and path after
 * `/v1/servers/{serverId}`. Everything else, including every `people/me` route, every platform,
 * account and key route, wakes, removals and the server's settings, is refused.
 */
const agentRoutes: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/^GET$/, /^$/],
  [/^GET$/, /^\/archive$/],
  [/^GET$/, /^\/board(\/labels|\/tasks(\/[^/]+)?)?$/],
  [/^(GET|POST)$/, /^\/channels$/],
  [/^PATCH$/, /^\/channels\/[^/]+$/],
  [/^GET$/, /^\/conversations\/[^/]+$/],
  [/^(GET|POST)$/, /^\/conversations\/[^/]+\/messages$/],
  [/^(GET|POST)$/, /^\/direct-chats$/],
  [/^GET$/, /^\/files\/(pack-command|shares|transfers(\/[^/]+)?)$/],
  [/^POST$/, /^\/files\/transfers(\/[^/]+\/(complete|download|fetch))?$/],
  [/^GET$/, /^\/memory$/],
  [/^GET$/, /^\/messages(\/search|\/[^/]+\/context)$/],
  [/^(GET|POST)$/, /^\/participants$/],
  [/^GET$/, /^\/participants\/[^/]+$/],
  [/^POST$/, /^\/participants\/[^/]+\/memory\/access$/],
  [/^POST$/, /^\/participants\/[^/]+\/rename$/],
  [/^(GET|POST|DELETE)$/, /^\/participants\/[^/]+\/signals(\/[^/]+)?$/],
  [/^POST$/, /^\/participants\/[^/]+\/tasks(\/claim|\/[^/]+\/updates)?$/],
  [/^GET$/, /^\/tasks(\/[^/]+)?$/],
  [/^POST$/, /^\/updates$/],
];

/** Whether an invited agent may make this request on this server. */
export const allowed = (serverId: string, method: string, path: string) => {
  const root = `/v1/servers/${serverId}`;
  if (path !== root && !path.startsWith(`${root}/`)) return false;
  const rest = path.slice(root.length);
  if (/^\/agent-invites(\/[^/]+)?$/.test(rest)) return true;
  return agentRoutes.some(([verbs, paths]) => verbs.test(method) && paths.test(rest));
};

/**
 * Check an invited agent's key without D1: its tag must be this deployment's. The key's SHA-256
 * becomes the principal only the server object resolves. A failure is 403, never 401: a 401 sends
 * MCP clients to sign-in.
 */
export const genuine = Effect.fn("InvitesHttp.genuine")(function* (
  request: Request,
  env: Env,
  key: string,
  meta: Envelope.Meta,
) {
  const blocked = yield* refused(request, meta);
  if (blocked !== null) return { kind: "refused", response: blocked } as const;
  const serverId = yield* Guard.genuine(env, "key", key);
  if (serverId === null) {
    yield* Guard.failed(env, request);
    return {
      kind: "refused",
      response: deny(meta, "This invited agent key is not valid. Get a new invite."),
    } as const;
  }
  const principal = Access.invitedKey(yield* Guard.hash(key));
  return { kind: "invited", serverId, principal } as const;
});

/** A genuine key (`genuine`) whose server is the one in the path, on an agent route. */
export const verify = Effect.fn("InvitesHttp.verify")(function* (
  request: Request,
  env: Env,
  key: string,
  meta: Envelope.Meta,
) {
  const checked = yield* genuine(request, env, key, meta);
  if (checked.kind === "refused") return checked;
  const url = new URL(request.url);
  if (!allowed(checked.serverId, request.method, url.pathname))
    return {
      kind: "refused",
      response: deny(
        meta,
        "An invited agent's key works only on its own server's agent routes: messages, channels, direct chats, files, signal links, tasks, updates and invites.",
      ),
    } as const;
  return checked;
});

const deny = (meta: Envelope.Meta, message: string) =>
  Response.json({ error: { code: "forbidden", message }, meta }, { status: 403 });

/**
 * The name an invite chain shows for the person it started from: their first name only, never
 * their email (invited agents from anywhere see it). "Person" when they gave none.
 */
export const originName = (user: { readonly firstName: string | null }) =>
  Persons.displayName({ firstName: user.firstName, email: "" });

/**
 * An invited agent's call the server object answered `server_unavailable`: its participant was
 * removed or a later pickup replaced its key. 403 and "get a new invite", never a retryable answer.
 */
export const stopped = Effect.fn("InvitesHttp.stopped")(function* (
  response: Response,
  meta: Envelope.Meta,
) {
  if (response.status !== 404) return response;
  const text = yield* Effect.promise(() => response.clone().text());
  const code = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ code: Schema.String }) })),
  )(text).pipe(Option.map((value) => value.error.code));
  if (Option.getOrNull(code) !== "server_unavailable") return response;
  return Response.json(
    {
      error: {
        code: "forbidden",
        message:
          "This invited agent's key no longer works: its agent was removed from the server. Ask for a new invite.",
      },
      meta,
    },
    { status: 403 },
  );
});
