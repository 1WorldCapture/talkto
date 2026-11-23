import { run } from "@talkto/telemetry/effect";
import * as A from "@talkto/api/agent";
import * as Mcp from "./mcp.js";
import * as Signals from "./signals.js";
import * as SignalGuard from "./signal-guard.js";
import { describeFailure } from "./failure-log.js";
import * as McpAuth from "./mcp-auth.js";
import * as Browser from "./browser-auth.js";
import type { JWTVerifyGetKey } from "jose";
import * as CloudflareAccess from "./cloudflare-access.js";
import * as BetterAuthSwitch from "./better-auth-switch.js";
import * as LocalIdentity from "./platform/local-identity.js";
import { Context, Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import { Api } from "@talkto/api/api";
import * as P from "@talkto/api/platform";
import * as O from "@talkto/api/onboarding";
import * as Onboarding from "./onboarding/service.js";
import type * as Starter from "./starter/service.js";
import * as OnboardingAdapters from "./onboarding/adapters.js";
import * as OnboardingHttp from "./onboarding/http.js";
import { Identifiers } from "./talkto.js";
import * as M from "@talkto/api/models";
import * as Envelope from "@talkto/api/envelope";
import * as Responses from "./responses.js";
import * as Configuration from "./configuration.js";
import { capabilities } from "./capabilities.js";
import * as Model from "./platform/model.js";
import * as Platform from "./platform/service.js";
import * as PlatformHttp from "./platform/http.js";
import * as D1 from "./platform/d1.js";
import * as InvitationD1 from "./platform/invitation-d1.js";
import * as InvitationPolicy from "./platform/invitation-policy.js";
import * as Projection from "./platform/activity-projection.js";
import * as Activity from "./platform/activity.js";
import * as ActivityD1 from "./platform/activity-d1.js";
import * as Servers from "./platform/servers.js";
import * as WorkOS from "./platform/workos.js";
import { installGuide } from "@talkto/api/agent-guides";
import instructions from "./instructions.md";
import skill from "./skill.md";
import * as Llms from "./llms.js";
import * as Robots from "./robots.js";
import { renderDocumentation } from "@talkto/api/documentation";
import * as BillingApi from "@talkto/api/billing";
import * as BillingHttp from "./billing/http.js";
import * as SelfHostRetired from "./selfhost-retired.js";
import * as StarterApi from "@talkto/api/starter";
import * as StarterHttp from "./starter/http.js";
import * as AccountApi from "@talkto/api/account";
import * as EmailApi from "@talkto/api/email";
import * as AccountHttp from "./account-deletion/http.js";
import * as EmailHttp from "./email/http.js";
import * as SignInsApi from "@talkto/api/sign-ins";
import * as SignInsHttp from "./sign-ins/http.js";
import * as FeedbackHttp from "./feedback/http.js";
import * as ShareApi from "@talkto/api/share";
import * as FeedbackApi from "@talkto/api/feedback";
import * as ShareHttp from "./share/http.js";
import * as GuestsApi from "@talkto/api/guests";
import * as GuestsHttp from "./guests/http.js";
import * as Provisioning from "./platform/provisioning-policy.js";
import * as Telemetry from "./telemetry.js";
import * as Access from "./access.js";
import * as Shell from "./shell.js";
import * as Persons from "./people.js";
import * as UpdateSignal from "./update-signal.js";
import * as UpdateWait from "./update-wait.js";
import * as Refusals from "./refusals.js";
import * as Entitlements from "./account-entitlements.js";

/** Boundary dependencies allow real HTTP/SQLite tests without calling the identity provider. */
export interface Authentication {
  readonly verify: (request: Request) => Effect.Effect<Model.Actor, Model.Failure>;
  readonly identity: Layer.Layer<Platform.Identity>;
  readonly mcp?: McpAuth.Authentication;
  readonly browser?: Browser.Authentication;
  /**
   * A self-hosted copy's own sign-in, which verifies each website and API request itself instead
   * of a TalkTo bearer token: Cloudflare Access's signed token (docs/self-host-cloudflare-access.md)
   * or Better Auth's session cookie (docs/self-host-better-auth.md). Without `mcp`, it verifies
   * `/mcp` too, as Access does.
   */
  readonly edge?: {
    readonly verify: (
      request: Request,
      route: CloudflareAccess.Route,
    ) => Effect.Effect<
      {
        readonly actor: Model.Actor;
        readonly website: boolean;
        /** A renewed session cookie for the response. */
        readonly setCookies?: ReadonlyArray<string>;
      },
      Model.Failure
    >;
  };
  /** The self-hosted sign-in in use, which the dashboard shows (invitations send no email there). */
  readonly signIn?: "cloudflare-access" | "better-auth";
  /** Upkeep the minute cron runs after synchronizing access. */
  readonly maintain?: Effect.Effect<void, Model.Failure>;
}
const status = (code: Model.Failure["code"]) =>
  ({
    invalid_input: 400,
    unauthenticated: 401,
    forbidden: 403,
    not_found: 404,
    idempotency_conflict: 409,
    people_limit_reached: 409,
    starter_unavailable: 409,
    server_limit_reached: 409,
    storage_unavailable: 503,
    identity_unavailable: 503,
  })[code];
/** Every public failure: the shared envelope's and the few only guest endpoints answer. */
const publicFailure = Schema.Union([...Envelope.failures, ...GuestsApi.failures]);
const platformPath = (path: string) =>
  path === "/v1/me" ||
  path.startsWith("/v1/accounts") ||
  path === "/v1/servers" ||
  /^\/v1\/servers\/[^/]+\/access(?:\/|$)/.test(path);
const openapi = () => {
  const core = OpenApi.fromApi(Api);
  const platform = OpenApi.fromApi(P.Api);
  const auth = OpenApi.fromApi(P.AuthApi);
  const billing = OpenApi.fromApi(BillingApi.Api);
  const onboarding = OpenApi.fromApi(O.Api);
  const starter = OpenApi.fromApi(StarterApi.Api);
  const account = OpenApi.fromApi(AccountApi.Api);
  const email = OpenApi.fromApi(EmailApi.Api);
  const signIns = OpenApi.fromApi(SignInsApi.Api);
  const share = OpenApi.fromApi(ShareApi.Api);
  const feedback = OpenApi.fromApi(FeedbackApi.Api);
  const guests = OpenApi.fromApi(GuestsApi.Api);
  return {
    ...core,
    paths: {
      ...core.paths,
      ...platform.paths,
      ...auth.paths,
      ...billing.paths,
      ...onboarding.paths,
      ...starter.paths,
      ...account.paths,
      ...email.paths,
      ...signIns.paths,
      ...share.paths,
      ...feedback.paths,
      ...guests.paths,
    },
    components: {
      ...core.components,
      schemas: {
        ...core.components?.schemas,
        ...platform.components?.schemas,
        ...auth.components?.schemas,
        ...billing.components?.schemas,
        ...onboarding.components?.schemas,
        ...starter.components?.schemas,
        ...account.components?.schemas,
        ...email.components?.schemas,
        ...signIns.components?.schemas,
        ...share.components?.schemas,
        ...feedback.components?.schemas,
        ...guests.components?.schemas,
      },
    },
  };
};
const body = Effect.fn("Hosted.readBody")(function* (request: Request) {
  const stream = request.body;
  if (stream === null) return null;
  return yield* Effect.tryPromise({
    try: async () => {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 131072) {
            await reader.cancel();
            return "too_large" as const;
          }
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes;
      } finally {
        reader.releaseLock();
      }
    },
    catch: () =>
      new Model.Failure({ code: "invalid_input", message: "The request body could not be read." }),
  });
});
const application = (env: Env, identity: Layer.Layer<Platform.Identity>) => {
  const directory = D1.layer(env.PLATFORM, Provisioning.configuration(env));
  const shared = Layer.merge(directory, identity);
  return Layer.merge(
    Platform.layer.pipe(
      Layer.provide([
        Servers.layer(env.SERVERS, capabilities(env)),
        InvitationD1.layer(env.PLATFORM, InvitationPolicy.configuration(env)),
      ]),
    ),
    Activity.layer.pipe(
      Layer.provide([ActivityD1.layer(env.PLATFORM), ActivityD1.serversLayer(env.SERVERS)]),
    ),
  ).pipe(Layer.provide(shared));
};

const onboardingApplication = (
  env: Env,
  identity: Layer.Layer<Platform.Identity>,
  starter: Layer.Layer<Starter.Service>,
) =>
  Onboarding.layer.pipe(
    Layer.provide([
      starter,
      application(env, identity),
      identity,
      D1.layer(env.PLATFORM, Provisioning.configuration(env)),
      OnboardingAdapters.storeLayer(env.PLATFORM),
      OnboardingAdapters.serversLayer(env.SERVERS),
      Layer.succeed(
        Identifiers,
        Identifiers.of({ uuid: () => Effect.sync(() => crypto.randomUUID()) }),
      ),
    ]),
  );

const mcpPath = (path: string) =>
  path === "/mcp" || path === "/.well-known/oauth-protected-resource/mcp";
const mcpIngress = Effect.fn("Hosted.mcp")(function* (
  request: Request,
  env: Env,
  auth: Authentication,
  waitUntil: (task: Promise<unknown>) => void,
) {
  const origin = yield* Configuration.readOrigin(env).pipe(
    Effect.mapError(
      () =>
        new Model.Failure({
          code: "identity_unavailable",
          message: "The service is not configured.",
        }),
    ),
  );
  const meta = Mcp.metadata(origin);
  const issuer = auth.mcp?.issuer;
  const mcpAuth = auth.mcp;
  // A copy's own sign-in answers agents only when TalkTo runs no OAuth server: Access does.
  const edge = mcpAuth === undefined ? auth.edge : undefined;
  if (edge === undefined && (issuer === undefined || mcpAuth === undefined))
    return Responses.failure(
      503,
      "identity_unavailable",
      "MCP authentication is not configured.",
      meta,
    );
  const configured = Schema.decodeUnknownOption(
    Schema.Struct({ TALKTO_MCP_ALLOWED_ORIGINS: Schema.String }),
  )(env);
  const allowed =
    configured._tag === "Some"
      ? configured.value.TALKTO_MCP_ALLOWED_ORIGINS.split(",").map((v) => v.trim())
      : [];
  const callerOrigin = request.headers.get("origin");
  if (callerOrigin !== null && callerOrigin !== origin && !allowed.includes(callerOrigin))
    return Responses.failure(403, "forbidden", "This browser origin is not allowed.", meta);
  const finish = (response: Response) => {
    const headers = new Headers(response.headers);
    headers.set("link", `<${origin}/instructions>; rel="help"`);
    headers.set("cache-control", "no-store");
    if (callerOrigin !== null) {
      headers.set("access-control-allow-origin", callerOrigin);
      headers.set("vary", "Origin");
      headers.set("access-control-allow-methods", "POST, GET, OPTIONS");
      headers.set(
        "access-control-allow-headers",
        "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
      );
      headers.set("access-control-expose-headers", "WWW-Authenticate, Link, MCP-Protocol-Version");
    }
    return new Response(response.body, { status: response.status, headers });
  };
  if (request.method === "OPTIONS") return finish(new Response(null, { status: 204 }));
  if (new URL(request.url).pathname === "/.well-known/oauth-protected-resource/mcp") {
    // Behind Access, Managed OAuth answers agents' sign-in; TalkTo advertises no server of its own.
    if (edge !== undefined || issuer === undefined)
      return finish(
        Responses.failure(404, "not_found", "Cloudflare Access handles sign-in.", meta),
      );
    if (request.method !== "GET")
      return finish(new Response(null, { status: 405, headers: { allow: "GET, OPTIONS" } }));
    return finish(
      Response.json({
        resource: `${origin}/mcp`,
        authorization_servers: [issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: ["openid", "offline_access"],
        resource_documentation: `${origin}/instructions`,
      }),
    );
  }
  const refuse = (failure: Model.Failure) => {
    const response = Responses.failure(status(failure.code), failure.code, failure.message, meta);
    if (failure.code === "unauthenticated" && edge === undefined) {
      const suppliedToken = /^Bearer\s+\S/i.test(request.headers.get("authorization") ?? "");
      response.headers.set(
        "www-authenticate",
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="openid offline_access"${suppliedToken ? ', error="invalid_token"' : ""}`,
      );
    }
    return finish(response);
  };
  const verified = yield* (
    edge !== undefined
      ? edge.verify(request, "mcp").pipe(Effect.map((value) => value.actor))
      : mcpAuth !== undefined
        ? mcpAuth.verify(request)
        : Effect.fail(
            new Model.Failure({ code: "identity_unavailable", message: "MCP is not configured." }),
          )
  ).pipe(Effect.result);
  if (Result.isFailure(verified)) return refuse(verified.failure);
  // A sign-in the person signed out on the Signed-in computers page: the client re-authorizes.
  // Behind Access, Zero Trust lists and revokes agents' sessions instead.
  if (
    edge === undefined &&
    (yield* SignInsHttp.admit(env, verified.success, request, meta.requestId, waitUntil))
  )
    return refuse(
      new Model.Failure({
        code: "unauthenticated",
        message:
          "This TalkTo sign-in was signed out on the Signed-in computers page. Sign in again to reconnect.",
      }),
    );
  const payload = yield* body(request);
  if (payload === "too_large")
    return finish(
      Responses.failure(413, "request_too_large", "The maximum request body is 128 KiB.", meta),
    );
  const actor = verified.success;
  const app: Mcp.Application = {
    feedback: (input, requestMeta) =>
      FeedbackHttp.agent(request, actor, input, requestMeta, env, application(env, auth.identity)),
    events: (command) =>
      env.SERVERS.getByName(command.arguments.serverId).invokeEvents(
        actor.principalKey,
        // Server access is the boundary: no organization narrows an agent's call.
        null,
        command,
      ),
    invoke: async (command, requestMeta) => {
      if (command.tool === "get_context" && command.input.serverId === undefined) {
        const input = command.input;
        if (
          input.participant !== undefined ||
          input.directChats !== undefined ||
          (input.page !== undefined && input.page.section !== "servers")
        )
          return {
            error: {
              code: "invalid_input",
              message: "Select a serverId for participant, channel, and chat context.",
            },
            meta: requestMeta,
          };
        const discovered = await run(
          Platform.Service.pipe(
            Effect.flatMap((service) => service.discoverServers(actor, input.page?.cursor)),
            Effect.provide(application(env, auth.identity)),
            Effect.result,
          ),
        );
        if (Result.isFailure(discovered)) {
          Telemetry.failure(
            discovered.failure.code,
            requestMeta.requestId,
            discovered.failure,
            "mcp",
            "error",
            "mcp.get_context",
          );
          return {
            error: { code: discovered.failure.code, message: discovered.failure.message },
            meta: requestMeta,
          };
        }
        const items = discovered.success.items.slice(0, input.page?.limit ?? 100);
        const cursor =
          discovered.success.items.length > items.length
            ? items.at(-1)?.id
            : discovered.success.nextCursor;
        const nextCursor = cursor === null || cursor === undefined ? null : M.Cursor.make(cursor);
        const nextActions: A.NextAction[] =
          nextCursor === null
            ? []
            : [
                {
                  reason: "Continue authorized servers.",
                  tool: "get_context",
                  arguments: {
                    page: {
                      section: "servers",
                      cursor: nextCursor,
                      limit: input.page?.limit ?? 100,
                    },
                  },
                },
              ];
        if (items.length === 1 && items[0] !== undefined)
          nextActions.push({
            reason: "Inspect this server before registering or reading messages.",
            tool: "get_context",
            arguments: { serverId: items[0].id },
          });
        let resultMeta: A.Meta = { ...requestMeta, nextActions };
        if (input.includeInstructions)
          resultMeta = {
            ...resultMeta,
            instructionSheet: renderDocumentation(
              instructions,
              new URL(requestMeta.instructions.url).origin,
            ),
          };
        if (items.length === 0)
          resultMeta = {
            ...resultMeta,
            instructions: {
              ...resultMeta.instructions,
              text: `No accessible servers. An owner must create a server or grant this user access through the platform API. ${resultMeta.instructions.text}`,
            },
          };
        return {
          data: { kind: "servers", items, nextCursor },
          included: { participants: [], conversations: [] },
          meta: resultMeta,
        };
      }
      const serverId = command.input.serverId;
      if (serverId === undefined)
        return {
          error: { code: "invalid_input", message: "serverId is required." },
          meta: requestMeta,
        };
      const caller = {
        serverId,
        principalKey: actor.principalKey,
        organizationId: null,
      };
      // An early retry of a refused read is answered from the Worker's memory; a waiting
      // get_updates is held here, on a watch, not in the server object.
      return run(
        Refusals.invokeAgent(
          caller,
          command,
          requestMeta,
          Effect.suspend(() =>
            UpdateWait.invokeAgent(
              () => env.SERVERS.getByName(serverId),
              caller,
              command,
              requestMeta,
            ),
          ),
        ),
      );
    },
  };
  return yield* Effect.promise(() =>
    Mcp.fetch(
      new Request(request.url, { method: request.method, headers: request.headers, body: payload }),
      app,
      origin,
      capabilities(env),
    ).then(finish),
  );
});

/** Hosted HTTP ingress. The messaging branch never constructs or calls the platform database. */
export function makeWorker(
  authenticate: (env: Env) => Effect.Effect<Authentication, Model.Failure>,
): ExportedHandler<Env> {
  return {
    async fetch(request, env, context) {
      const url = new URL(request.url);
      const meta = Responses.metadata(url.origin);
      const sessionUpdates: string[] = [];
      // A platform handler or server object that threw: reported with the 5xx it becomes.
      let upstream: unknown;
      const finish = (response: Response) => {
        for (const value of sessionUpdates) response.headers.append("set-cookie", value);
        return response;
      };
      try {
        if (Shell.isShellPath(url.pathname)) return await Shell.serveShell(request, env.ASSETS);
        // Install files (/agents/<id>.md) come from the dialog's recipes; other files under
        // /agents/ are static assets.
        if (url.pathname.startsWith("/agents/")) {
          const guide = request.method === "GET" ? installGuide(url.pathname, url.origin) : null;
          return guide === null
            ? await env.ASSETS.fetch(request)
            : new Response(guide, { headers: { "content-type": "text/markdown; charset=utf-8" } });
        }
        if (Shell.isSitePage(url.pathname))
          return Entitlements.isSelfHosted(env)
            ? Response.redirect(new URL("/app", url.origin).href, 302)
            : await env.ASSETS.fetch(request);
        // A self-hosted copy has no billing, so nothing may arrive here.
        if (url.pathname === "/webhooks/stripe" && Entitlements.isSelfHosted(env))
          return Responses.failure(404, "not_found", "This TalkTo has no billing.", meta);
        if (url.pathname === "/webhooks/stripe") {
          if (request.method !== "POST")
            return Responses.failure(405, "invalid_input", "Use POST for Stripe events.", meta);
          const received = await run(
            Effect.gen(function* () {
              const payload = yield* body(request);
              if (payload === "too_large")
                return Responses.failure(
                  413,
                  "request_too_large",
                  "The maximum request body is 128 KiB.",
                  meta,
                );
              const result = yield* BillingHttp.receive(
                new TextDecoder().decode(payload ?? new Uint8Array()),
                request.headers.get("stripe-signature") ?? "",
                env,
              ).pipe(Effect.result);
              if (Result.isFailure(result)) return BillingHttp.failure(result.failure, meta);
              // Apply the payment now instead of at the next minute cron, which remains the backstop.
              if (result.success !== null)
                yield* BillingHttp.apply(env, result.success, meta.requestId);
              return Response.json({ received: true });
            }),
          );
          return received;
        }
        // Self-host license sales ended on November 19, 2026 (TalkTo is Apache-2.0-licensed now). Stripe
        // events for old self-host subscriptions are acknowledged and ignored, never processed.
        if (url.pathname === "/webhooks/stripe-selfhost") {
          if (request.method !== "POST")
            return Responses.failure(405, "invalid_input", "Use POST for Stripe events.", meta);
          return await run(
            Effect.gen(function* () {
              const payload = yield* body(request);
              if (payload === "too_large")
                return Responses.failure(
                  413,
                  "request_too_large",
                  "The maximum request body is 128 KiB.",
                  meta,
                );
              return yield* SelfHostRetired.acknowledge(
                new TextDecoder().decode(payload ?? new Uint8Array()),
                meta.requestId,
              );
            }),
          );
        }
        // TalkTo's own email (docs/email.md): Resend's signed events and the public unsubscribe
        // page, which the signed token in the link authorizes without a sign-in.
        if (url.pathname === "/webhooks/resend" || EmailHttp.isUnsubscribePath(url.pathname)) {
          if (url.pathname === "/webhooks/resend" && request.method !== "POST")
            return Responses.failure(405, "invalid_input", "Use POST for email events.", meta);
          return await run(
            Effect.gen(function* () {
              const payload = yield* body(request);
              if (payload === "too_large")
                return Responses.failure(
                  413,
                  "request_too_large",
                  "The maximum request body is 128 KiB.",
                  meta,
                );
              const text = new TextDecoder().decode(payload ?? new Uint8Array());
              return url.pathname === "/webhooks/resend"
                ? yield* EmailHttp.webhook(request, env, text)
                : yield* EmailHttp.unsubscribePage(request, env, text);
            }),
          );
        }
        if (
          ["/auth/login", "/auth/callback", "/auth/logout"].includes(url.pathname) ||
          // Better Auth's pages and OAuth server, only on a copy that asks for Better Auth.
          (BetterAuthSwitch.isPath(url.pathname) && BetterAuthSwitch.requested(env))
        ) {
          const result = await run(
            authenticate(env).pipe(
              Effect.flatMap((auth) =>
                auth.browser === undefined
                  ? Effect.fail(
                      new Model.Failure({
                        code: "identity_unavailable",
                        message: "Website sign-in is not configured.",
                      }),
                    )
                  : auth.browser.route(request),
              ),
              Effect.result,
            ),
          );
          return Result.isSuccess(result)
            ? result.success
            : Responses.failure(
                status(result.failure.code),
                result.failure.code,
                result.failure.message,
                meta,
              );
        }
        // Signal links carry their own capability; they never reach the credential gate below.
        if (Signals.isSignalPath(url.pathname))
          return await Signals.ingress(
            request,
            meta,
            (serverId) => env.SERVERS.getByName(serverId),
            SignalGuard.make(env, request),
          );
        if (mcpPath(url.pathname)) {
          const result = await run(
            authenticate(env).pipe(
              Effect.flatMap((auth) =>
                mcpIngress(request, env, auth, (task) => context?.waitUntil(task)),
              ),
              Effect.result,
            ),
          );
          return Result.isSuccess(result)
            ? result.success
            : Responses.failure(
                status(result.failure.code),
                result.failure.code,
                result.failure.message,
                meta,
              );
        }
        if (request.method === "GET") {
          if (url.pathname === "/health") return Response.json({ status: "ok", meta });
          if (url.pathname === "/v1/offers") return await run(StarterHttp.offers(env, meta));
          if (url.pathname === "/instructions")
            return new Response(renderDocumentation(instructions, url.origin), {
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          if (url.pathname === "/skill.md")
            return new Response(renderDocumentation(skill, url.origin), {
              headers: { "content-type": "text/markdown; charset=utf-8" },
            });
          if (Llms.isLlmsPath(url.pathname)) return await Llms.serve(request, env.ASSETS);
          if (url.pathname === Robots.path) return Robots.serve(request, Robots.isProduction(env));
          if (url.pathname === "/openapi.json") return Response.json(openapi());
          if (url.pathname === "/auth") {
            const config = await run(WorkOS.configuration(env).pipe(Effect.result));
            if (Result.isFailure(config))
              return Responses.failure(503, "identity_unavailable", config.failure.message, meta);
            return Response.json({
              data: {
                clientId: config.success.clientId,
                issuer: config.success.issuer,
                flow: "workos-device",
              },
              meta,
            });
          }
        }
        const response = await run(
          Effect.gen(function* () {
            const origin = yield* Configuration.readOrigin(env).pipe(
              Effect.mapError(
                () =>
                  new Model.Failure({
                    code: "identity_unavailable",
                    message: "The service is not configured.",
                  }),
              ),
            );
            const auth = yield* authenticate(env);
            let verifiedRequest = request;
            let website = false;
            let edgeActor: Model.Actor | undefined;
            if (auth.edge !== undefined) {
              const verified = yield* auth.edge.verify(request, "api");
              edgeActor = verified.actor;
              sessionUpdates.push(...(verified.setCookies ?? []));
              website = verified.website;
            } else if (!request.headers.has("authorization")) {
              if (auth.browser === undefined || !Browser.hasSession(request))
                return yield* new Model.Failure({
                  code: "unauthenticated",
                  message: "Sign in or supply a valid TalkTo access token.",
                });
              const session = yield* auth.browser.session(request);
              if (session.setCookie !== null) sessionUpdates.push(session.setCookie);
              const headers = new Headers(request.headers);
              headers.set("authorization", `Bearer ${Redacted.value(session.accessToken)}`);
              // Verification only needs headers; preserve the original request body for handlers.
              verifiedRequest = new Request(request.url, { headers });
              website = true;
            }
            const actor = edgeActor ?? (yield* auth.verify(verifiedRequest));
            const payload = yield* body(request);
            if (payload === "too_large")
              return Responses.failure(
                413,
                "request_too_large",
                "The maximum request body is 128 KiB.",
                meta,
              );
            const headers = new Headers(request.headers);
            headers.delete("authorization");
            headers.delete("cookie");
            headers.delete(CloudflareAccess.tokenHeader);
            headers.delete("x-talkto-access");
            headers.delete(Access.websiteHeader);
            headers.delete(Persons.nameHeader);
            headers.delete(UpdateSignal.rereadHeader);
            if (website) headers.set(Access.websiteHeader, Access.websiteSession);
            headers.set("x-talkto-principal", actor.principalKey);
            // Joining or opening a person's chat can create their participant, named from their
            // verified WorkOS profile; nothing in the request names them.
            if (request.method === "POST" && Persons.createsPerson(url.pathname)) {
              const user = yield* Platform.Identity.use((identity) =>
                identity.user(actor.userId),
              ).pipe(Effect.provide(auth.identity));
              headers.set(Persons.nameHeader, Persons.displayName(user));
            }
            headers.set("x-talkto-request-id", meta.requestId);
            const forwarded = new Request(request.url, {
              method: request.method,
              headers,
              body: payload,
            });
            const requestMeta = Responses.metadata(origin, meta.requestId);
            // Edge-supplied, never a client header: Cloudflare overwrites cf-connecting-ip.
            const evidence = { website, network: request.headers.get("cf-connecting-ip") };
            if (/^\/v1\/(?:starter|accounts\/[^/]+\/starter)$/.test(url.pathname))
              return yield* StarterHttp.handle(
                forwarded,
                actor,
                requestMeta,
                evidence,
                env,
                application(env, auth.identity),
              );
            if (ShareHttp.isPath(url.pathname))
              return yield* ShareHttp.handle(
                forwarded,
                actor,
                requestMeta,
                env,
                application(env, auth.identity),
                auth.identity,
              );
            // Server guests: invitations to one server, accepted by the invited address.
            if (GuestsHttp.isPath(url.pathname))
              return yield* GuestsHttp.handle(forwarded, actor, requestMeta, env, auth.identity);
            if (EmailHttp.isPreferencesPath(url.pathname))
              return yield* EmailHttp.handle(forwarded, actor, requestMeta, env);
            if (SignInsHttp.isPath(url.pathname))
              return yield* SignInsHttp.handle(forwarded, actor, requestMeta, env, auth.identity);
            if (FeedbackHttp.isPath(url.pathname))
              return yield* FeedbackHttp.handle(
                forwarded,
                actor,
                requestMeta,
                env,
                application(env, auth.identity),
              );
            if (AccountHttp.isAccountPath(url.pathname)) {
              const answered = yield* AccountHttp.handle(
                forwarded,
                actor,
                requestMeta,
                evidence,
                env,
                auth.identity,
              );
              // A deleted account has no session left to keep; end the website's copy too.
              if (website && request.method === "POST" && answered.status === 200)
                sessionUpdates.push(Browser.clearSession());
              return answered;
            }
            if (/^\/v1\/accounts\/[^/]+\/billing(?:\/|$)/.test(url.pathname))
              return yield* BillingHttp.handle(
                forwarded,
                actor,
                requestMeta,
                env,
                application(env, auth.identity),
              );
            if (
              platformPath(url.pathname) ||
              url.pathname === "/v1/onboarding" ||
              url.pathname === "/v1/onboarding/progress"
            ) {
              const web = url.pathname.startsWith("/v1/onboarding")
                ? OnboardingHttp.makeHandler(
                    onboardingApplication(
                      env,
                      auth.identity,
                      (yield* StarterHttp.application(env, application(env, auth.identity)).pipe(
                        Effect.mapError(StarterHttp.platformFailure),
                      )).layer,
                    ),
                  )
                : PlatformHttp.makeHandler(application(env, auth.identity));
              try {
                return yield* Effect.tryPromise({
                  try: () =>
                    web.handler(
                      forwarded,
                      Context.make(
                        PlatformHttp.RequestContext,
                        auth.signIn === undefined
                          ? { actor, meta: requestMeta, evidence }
                          : { actor, meta: requestMeta, evidence, signIn: auth.signIn },
                      ),
                    ),
                  catch: (cause) => {
                    upstream = cause;
                    return new Model.Failure({
                      code: "storage_unavailable",
                      message: "The platform is temporarily unavailable.",
                    });
                  },
                });
              } finally {
                yield* Effect.promise(() => web.dispose());
              }
            }
            const parsed = Schema.decodeUnknownResult(M.ServerId)(url.pathname.split("/")[3]);
            if (!url.pathname.startsWith("/v1/servers/") || Result.isFailure(parsed))
              return Responses.failure(
                404,
                "not_found",
                "The API route does not exist.",
                requestMeta,
              );
            const caller = {
              serverId: parsed.success,
              principalKey: actor.principalKey,
              organizationId: null,
            };
            return yield* Effect.tryPromise({
              // An early retry of a refused read is answered from the Worker's memory; a waiting
              // POST …/updates is held here, on a watch, not in the server object.
              try: () =>
                run(
                  Refusals.forward(
                    caller,
                    website,
                    forwarded,
                    payload,
                    meta.requestId,
                    Effect.suspend(() =>
                      UpdateWait.forward(
                        () => env.SERVERS.getByName(parsed.success),
                        caller,
                        forwarded,
                        payload,
                      ),
                    ),
                  ),
                ),
              // An overloaded, reset or CPU-limited server object lands here; its class is tagged.
              catch: (cause) => {
                upstream = cause;
                return new Model.Failure({
                  code: "storage_unavailable",
                  message: "The server is temporarily unavailable.",
                });
              },
            });
          }).pipe(Effect.result),
        );
        if (Result.isFailure(response)) {
          if (
            response.failure.code === "unauthenticated" &&
            !request.headers.has("authorization") &&
            Browser.hasSession(request)
          )
            sessionUpdates.push(Browser.clearSession());
          return finish(
            Responses.failure(
              status(response.failure.code),
              response.failure.code,
              response.failure.message,
              meta,
              upstream,
            ),
          );
        }
        const result = new Response(response.success.body, response.success);
        result.headers.set("cache-control", "no-store");
        result.headers.set("x-request-id", meta.requestId);
        if (result.status < 400) return finish(result);
        const parsed = Schema.decodeUnknownResult(Schema.fromJsonString(publicFailure))(
          await result.text(),
        );
        if (Result.isSuccess(parsed)) {
          if (
            parsed.success.error.code === "invitation_limited" ||
            parsed.success.error.code === "feedback_limited"
          )
            result.headers.set("retry-after", String(parsed.success.error.retryAfterSeconds));
          return finish(
            Response.json(parsed.success, { status: result.status, headers: result.headers }),
          );
        }
        return finish(
          Responses.failure(
            result.status >= 500 ? 500 : result.status,
            result.status >= 500 ? "internal_error" : "invalid_input",
            result.status >= 500
              ? "An internal error occurred. Use the request ID for diagnosis."
              : "The request does not match the API contract. See /openapi.json.",
            meta,
          ),
        );
      } catch (cause) {
        console.error("TalkTo request failed", { requestId: meta.requestId });
        return finish(
          Responses.failure(
            500,
            "internal_error",
            "An internal error occurred. Use the request ID for diagnosis.",
            meta,
            cause,
          ),
        );
      }
    },
    async scheduled(event, env) {
      const runId = crypto.randomUUID();
      console.info("TalkTo scheduled receipt", { runId, scheduledTime: event.scheduledTime });
      const stage = Effect.fn("Hosted.scheduledStage")(function* <
        A,
        E extends Error & { readonly code: string },
      >(
        name:
          | "access"
          | "activity"
          | "billing"
          | "downgrades"
          | "starter"
          | "email"
          | "signins"
          | "share"
          | "guests",
        operation: Effect.Effect<A, E>,
      ) {
        yield* Effect.annotateCurrentSpan({ "talkto.stage": name, "talkto.request_id": runId });
        const outcome = yield* operation.pipe(Effect.result);
        yield* Effect.annotateCurrentSpan("talkto.outcome", outcome._tag);
        if (Result.isFailure(outcome))
          Telemetry.failure(outcome.failure.code, runId, outcome.failure, name);
        console.info("TalkTo scheduled stage", {
          runId,
          stage: name,
          outcome: outcome._tag,
          code: Result.isFailure(outcome) ? outcome.failure.code : "ok",
          // The wrapped message is generic; the identifier-shaped operation names the cause.
          operation: Result.isFailure(outcome) ? describeFailure(outcome.failure).operation : null,
        });
        return outcome;
      });
      const result = await run(
        Effect.gen(function* () {
          const { sync, activity, billing, downgrades, starter, email, signins, share, guests } =
            yield* Effect.all(
              {
                sync: stage(
                  "access",
                  authenticate(env).pipe(
                    Effect.flatMap(
                      Effect.fn("Hosted.synchronizeAccess")(function* (auth) {
                        const access = yield* Platform.Service.pipe(
                          Effect.flatMap((service) => service.synchronize()),
                          Effect.provide(application(env, auth.identity)),
                          Effect.result,
                        );
                        // Account deletions interrupted after sign-in ended finish here.
                        const deletions = yield* AccountHttp.resume(env, auth.identity).pipe(
                          Effect.result,
                        );
                        // A self-hosted sign-in's own upkeep, such as Better Auth's expired rows.
                        const upkeep = yield* (auth.maintain ?? Effect.void).pipe(Effect.result);
                        if (Result.isFailure(access)) return yield* access.failure;
                        if (Result.isFailure(deletions)) return yield* deletions.failure;
                        if (Result.isFailure(upkeep)) return yield* upkeep.failure;
                      }),
                    ),
                  ),
                ),
                activity: stage("activity", Projection.maintain(env.PLATFORM, env.SERVERS)),
                billing: stage("billing", BillingHttp.synchronize(env)),
                // A move to Shop that would start above its people limit keeps the current plan.
                downgrades: stage(
                  "downgrades",
                  BillingHttp.holdDowngrades(
                    env,
                    authenticate(env).pipe(Effect.map((auth) => auth.identity)),
                  ),
                ),
                starter: stage("starter", StarterHttp.synchronize(env)),
                // Off (the default) calls nothing: no identity provider, no storage.
                email: stage(
                  "email",
                  EmailHttp.enabled(env).pipe(
                    Effect.flatMap((on) =>
                      on
                        ? authenticate(env).pipe(
                            Effect.flatMap((auth) => EmailHttp.synchronize(env, auth.identity)),
                          )
                        : Effect.void,
                    ),
                  ),
                ),
                // Signed-in computers: rows unseen for 90 days and expired revocations.
                signins: stage("signins", SignInsHttp.prune(env)),
                // Share links (docs/share-links-spec.md): off (the default) reads nothing.
                share: stage("share", ShareHttp.synchronize(env)),
                // Server invitations kept 30 days after they were accepted, canceled or expired.
                guests: stage("guests", GuestsHttp.prune(env)),
              },
              { concurrency: 10 },
            );
          if (sync._tag === "Failure") return yield* sync.failure;
          if (activity._tag === "Failure") return yield* activity.failure;
          if (billing._tag === "Failure") return yield* billing.failure;
          if (downgrades._tag === "Failure") return yield* downgrades.failure;
          if (starter._tag === "Failure") return yield* starter.failure;
          if (email._tag === "Failure") return yield* email.failure;
          if (signins._tag === "Failure") return yield* signins.failure;
          if (share._tag === "Failure") return yield* share.failure;
          if (guests._tag === "Failure") return yield* guests.failure;
        }).pipe(Effect.result),
      );
      if (Result.isFailure(result)) {
        console.error("TalkTo synchronization failed; pending changes retained", {
          runId,
          code: result.failure.code,
        });
        // Keep the reported instance so the runtime wrapper preserves its identity
        // and Sentry does not emit a second, context-free error for the same failure.
        throw result.failure;
      }
      console.info("TalkTo scheduled complete", { runId });
    },
  };
}

// One verifier per Worker isolate retains jose's bounded signing-key cache.
let authentication: Authentication | undefined;
let accessAuthenticated: Authentication | undefined;
/**
 * Self-host sign-in with Cloudflare Access: Access's token on every request, and people,
 * organizations and invitations in the copy's own D1 database. Refused unless self-hosted.
 */
export const accessAuthentication = Effect.fn("Hosted.accessAuthentication")(function* (
  env: Env,
  keys?: (settings: CloudflareAccess.Settings) => JWTVerifyGetKey,
) {
  if (accessAuthenticated !== undefined) return accessAuthenticated;
  const settings = yield* CloudflareAccess.settings(env);
  const origin = yield* Configuration.readOrigin(env).pipe(
    Effect.mapError(
      () =>
        new Model.Failure({
          code: "identity_unavailable",
          message: "The service is not configured.",
        }),
    ),
  );
  const store = LocalIdentity.make(env.PLATFORM);
  const check = CloudflareAccess.verifier(
    settings,
    origin,
    (keys ?? CloudflareAccess.remoteKeys)(settings),
  );
  const verify = Effect.fn("Hosted.accessVerify")(function* (
    request: Request,
    route: CloudflareAccess.Route,
  ): Effect.fn.Return<CloudflareAccess.Verified, Model.Failure> {
    const checked = yield* check(request, route);
    const id = yield* store.signIns.identify(checked.email);
    return { ...checked, actor: Model.actor(id) };
  });
  accessAuthenticated = {
    verify: (request) => verify(request, "api").pipe(Effect.map((verified) => verified.actor)),
    identity: LocalIdentity.layer(store),
    browser: CloudflareAccess.browser(origin),
    edge: { verify },
    signIn: "cloudflare-access",
  };
  return accessAuthenticated;
});
let betterAuthenticated: Authentication | undefined;
/**
 * Self-host sign-in with Better Auth: email and password on this copy's own pages, its own OAuth
 * server for agents, and every record in the copy's D1 database. Refused unless self-hosted.
 */
export const betterAuthAuthentication = Effect.fn("Hosted.betterAuthAuthentication")(function* (
  env: Env,
) {
  if (betterAuthenticated !== undefined) return betterAuthenticated;
  const BetterAuth = yield* Effect.promise(() => import("./better-auth.js"));
  const settings = yield* BetterAuth.settings(env);
  const origin = yield* Configuration.readOrigin(env).pipe(
    Effect.mapError(
      () =>
        new Model.Failure({
          code: "identity_unavailable",
          message: "The service is not configured.",
        }),
    ),
  );
  const store = LocalIdentity.make(env.PLATFORM);
  const mode = BetterAuth.make(env, settings, origin, store);
  yield* mode.ready;
  betterAuthenticated = {
    verify: (request) => mode.verify(request).pipe(Effect.map((verified) => verified.actor)),
    identity: Layer.succeed(Platform.Identity, mode.identity),
    browser: mode.browser,
    mcp: mode.mcp,
    edge: { verify: (request) => mode.verify(request) },
    signIn: "better-auth",
    maintain: mode.maintain,
  };
  return betterAuthenticated;
});
/**
 * Cloudflare Access or Better Auth when a self-hosted copy asks for one; WorkOS otherwise. A copy
 * that asks for both is refused rather than guessing.
 */
export const configuredAuthentication = (env: Env) =>
  CloudflareAccess.requested(env) && BetterAuthSwitch.requested(env)
    ? Effect.fail(
        new Model.Failure({
          code: "identity_unavailable",
          message:
            "Choose one sign-in: remove either the Cloudflare Access settings or the Better Auth settings.",
        }),
      )
    : BetterAuthSwitch.requested(env)
      ? betterAuthAuthentication(env)
      : CloudflareAccess.requested(env)
        ? accessAuthentication(env)
        : workosAuthentication(env);
/** Production authentication has no development credential fallback. */
export const workosAuthentication = Effect.fn("Hosted.authentication")(function* (env: Env) {
  if (authentication !== undefined) return authentication;
  const config = yield* WorkOS.configuration(env);
  const issuer = Schema.decodeUnknownOption(
    Schema.Struct({
      WORKOS_MCP_ISSUER: Schema.String.check(Schema.isPattern(/^https:\/\/[^/]+$/)),
      WORKOS_MCP_ISSUER_ALIASES: Schema.optionalKey(Schema.String),
      WORKOS_MCP_JWKS: Schema.optionalKey(Schema.String),
    }),
  )(env);
  const origin = yield* Configuration.readOrigin(env).pipe(
    Effect.mapError(
      () =>
        new Model.Failure({
          code: "identity_unavailable",
          message: "The service is not configured.",
        }),
    ),
  );
  const base = { verify: WorkOS.verifier(config), identity: WorkOS.layer(config) };
  const browser = yield* Browser.make(env, config, origin);
  const mcp = Option.map(issuer, (settings) => {
    const aliases = McpAuth.issuerAliases(
      settings.WORKOS_MCP_ISSUER_ALIASES,
      settings.WORKOS_MCP_ISSUER,
    );
    return {
      issuer: settings.WORKOS_MCP_ISSUER,
      verify: McpAuth.verifier(
        settings.WORKOS_MCP_ISSUER,
        aliases,
        `${origin}/mcp`,
        McpAuth.fallbackKeys(settings.WORKOS_MCP_JWKS, [settings.WORKOS_MCP_ISSUER, ...aliases]),
      ),
    };
  });
  authentication = Option.isSome(mcp) ? { ...base, mcp: mcp.value } : base;
  if (browser !== undefined) authentication = { ...authentication, browser };
  return authentication;
});
