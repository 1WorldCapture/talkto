import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import * as A from "@talkto/api/account";
import * as Envelope from "@talkto/api/envelope";
import * as Security from "@talkto/api/security";
import { trace } from "@talkto/telemetry/effect";
import { capabilities } from "../capabilities.js";
import * as BillingHttp from "../billing/http.js";
import * as D1 from "../platform/d1.js";
import * as PlatformHttp from "../platform/http.js";
import * as Model from "../platform/model.js";
import type * as Platform from "../platform/service.js";
import * as Provisioning from "../platform/provisioning-policy.js";
import * as Servers from "../platform/servers.js";
import * as Telemetry from "../telemetry.js";
import * as EmailHttp from "../email/http.js";
import * as D from "@talkto/api/dashboard";
import * as M from "@talkto/api/models";
import { Schema } from "effect";
import * as AccountD1 from "./d1.js";
import * as AccountDeletion from "./service.js";

/** Typed failures to the shared public envelope. */
export const failure = (error: Model.Failure | AccountDeletion.Blocked, meta: Envelope.Meta) => {
  if (error._tag === "PlatformFailure") return PlatformHttp.failure(error, meta);
  return Envelope.makeFailure("account_deletion_blocked", error.message, meta);
};

/** Account deletion wired to D1, the identity provider, the servers and billing. */
export const application = (env: Env, identity: Layer.Layer<Platform.Identity>) =>
  AccountDeletion.layer.pipe(
    Layer.provide([
      AccountD1.layer(env.PLATFORM),
      D1.layer(env.PLATFORM, Provisioning.configuration(env)),
      Servers.layer(env.SERVERS, capabilities(env)),
      identity,
      Layer.succeed(
        AccountDeletion.Notices,
        AccountDeletion.Notices.of({
          organizationDeleted: (notice) =>
            EmailHttp.queueOrganizationDeleted(env, notice).pipe(
              Effect.mapError(
                () =>
                  new Model.Failure({
                    code: "storage_unavailable",
                    message: "The members' emails could not be queued.",
                  }),
              ),
            ),
          // The server's own count, under the owner's grant; any failure leaves the count unknown.
          agents: (actor, serverId) =>
            Effect.tryPromise(() =>
              env.SERVERS.getByName(serverId).readSummary(actor.principalKey),
            ).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.NullOr(Schema.Struct({ data: D.Summary }))),
              ),
              Effect.map(
                (summary): typeof M.Count.Type | null =>
                  summary?.data.server.participantCount ?? null,
              ),
              Effect.orElseSucceed(() => null),
            ),
        }),
      ),
      Layer.succeed(
        AccountDeletion.Subscriptions,
        AccountDeletion.Subscriptions.of({
          close: (accountId) =>
            BillingHttp.close(env, accountId).pipe(
              Effect.mapError((error) => {
                Telemetry.failure(error.code, crypto.randomUUID(), error);
                return new Model.Failure({
                  code: "storage_unavailable",
                  message:
                    "Billing has not yet confirmed the cancellation. It is retried automatically.",
                });
              }),
            ),
        }),
      ),
    ]),
  );

const respond = Effect.fn("AccountHttp.respond")(function* <A>(
  operation: (
    actor: Model.Actor,
    evidence: Model.Evidence,
  ) => Effect.Effect<A, Model.Failure | AccountDeletion.Blocked>,
) {
  const { actor, meta, evidence } = yield* PlatformHttp.RequestContext;
  const data = yield* operation(actor, evidence ?? Model.noEvidence).pipe(
    Effect.mapError((error) => failure(error, meta)),
  );
  return { data, meta };
});
const handlers = HttpApiBuilder.group(A.Api, "account", (routes) =>
  Effect.gen(function* () {
    const service = yield* AccountDeletion.Service;
    return routes.handleAll({
      deletionPlan: () => respond(service.plan),
      deleteAccount: ({ payload }) =>
        respond((actor, evidence) => service.delete(actor, evidence, payload)),
      organizationDeletionPlan: ({ params }) =>
        respond((actor, evidence) => service.organizationPlan(actor, evidence, params.accountId)),
      deleteOrganization: ({ params, payload }) =>
        respond((actor, evidence) =>
          service.deleteOrganization(actor, evidence, params.accountId, payload),
        ),
    });
  }),
);

/** Whether a path belongs to this adapter. */
export const isAccountPath = (path: string) =>
  path === "/v1/me/deletion" ||
  path === "/v1/me/delete" ||
  /^\/v1\/accounts\/[^/]+\/(?:deletion|delete)$/.test(path);
/** Deleting the person's own account ends their session; deleting an organization does not. */
export const endsSession = (path: string) => path === "/v1/me/delete";

/** Thin authenticated adapter; the website session is checked by the operation itself. */
export const handle = Effect.fn("AccountHttp.handle")(function* (
  request: Request,
  actor: Model.Actor,
  meta: Envelope.Meta,
  evidence: Model.Evidence,
  env: Env,
  identity: Layer.Layer<Platform.Identity>,
) {
  const web = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(A.Api).pipe(
      Layer.provide(handlers),
      Layer.provide(application(env, identity)),
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

/** Scheduled completion of deletions interrupted after sign-in ended. */
export const resume = (env: Env, identity: Layer.Layer<Platform.Identity>) =>
  AccountDeletion.Service.pipe(
    Effect.flatMap((service) => service.resume()),
    Effect.provide(application(env, identity)),
  );
