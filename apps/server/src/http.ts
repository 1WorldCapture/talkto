import { Clock, Context, DateTime, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi";
import { Api } from "@talkto/api/api";
import * as Envelope from "@talkto/api/envelope";
import * as Security from "@talkto/api/security";
import * as M from "@talkto/api/models";
import type * as Errors from "@talkto/api/errors";
import type * as Removals from "@talkto/api/removals";
import * as Responses from "./responses.js";
import * as TalkTo from "./talkto.js";
import type { AccessContext } from "./access.js";
import { trace } from "@talkto/telemetry/effect";
import * as Monitoring from "./monitoring.js";
import * as Reads from "./reads.js";
import * as Wakes from "./wakes/service.js";

/** Authority and diagnostics supplied by the verified runtime boundary for one request. */
export class RequestContext extends Context.Service<
  RequestContext,
  {
    readonly access: AccessContext;
    readonly meta: Envelope.Meta;
    /**
     * The hosted Worker verified the TalkTo website's session cookie for this request, not a
     * bearer token. Only a person on the dashboard can add a wake that stores a token.
     */
    readonly website: boolean;
    /** The signed-in person's verified profile, used only if a person endpoint creates them. */
    readonly person: TalkTo.PersonProfile;
    /**
     * A Worker reads get_updates again because a watch woke the waiting call it holds; that call
     * was already admitted as one read. Set only from the Worker's header (update-signal.ts).
     */
    readonly reread: boolean;
  }
>()("@talkto/HttpRequestContext") {}

const respond = Effect.fn("Http.respond")(function* <A, C, F extends Errors.Failure>(
  reads: Reads.Reads["Service"],
  serverId: M.ServerId,
  operation: (access: AccessContext) => Effect.Effect<M.Outcome<A, C>, F>,
  read?: {
    readonly operation: string;
    readonly participantId?: M.ParticipantId;
    /** `read` (the default) admits a read; `admin` an admin call; `send` counts a refused send. */
    readonly kind?: "read" | "admin" | "send";
  },
) {
  const context = yield* RequestContext;
  const access = { ...context.access, serverId };
  const call = {
    operation: read?.operation ?? "",
    transport: "http" as const,
    participantId: read?.participantId ?? null,
  };
  const guarded =
    read === undefined
      ? operation(access)
      : read.kind === "admin"
        ? reads.admin(access, call).pipe(Effect.andThen(operation(access)))
        : read.kind === "send"
          ? operation(access).pipe(
              Effect.catch((error) =>
                Reads.transientFailures.has(error._tag)
                  ? Effect.fail(error)
                  : reads.refused(access, call).pipe(Effect.andThen(Effect.fail(error))),
              ),
            )
          : reads.admit(access, call).pipe(Effect.andThen(operation(access)));
  const outcome = yield* guarded.pipe(
    Effect.mapError((error) => Responses.projectFailure(error, context.meta)),
  );
  const ms = yield* Clock.currentTimeMillis;
  return {
    ...outcome,
    meta: {
      ...context.meta,
      serverId,
      serverTime: M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(ms))),
    },
  };
});
const handlers = HttpApiBuilder.group(Api, "server", (routes) =>
  Effect.gen(function* () {
    const service = yield* TalkTo.Service;
    const reads = yield* Reads.Reads;
    const wakes = yield* Wakes.Wakes;
    // Only a person on the dashboard removes or restores an agent: agents share their person's
    // connection, so one agent could otherwise cut off the others.
    const removal = (serverId: M.ServerId, agentId: M.ParticipantId, action: Removals.Action) =>
      Effect.gen(function* () {
        const { website, meta, person } = yield* RequestContext;
        if (!website)
          return yield* Effect.fail(
            Envelope.makeFailure(
              "forbidden",
              "Remove or restore an agent on the TalkTo dashboard. Agents and API tokens cannot.",
              meta,
            ),
          );
        return yield* respond(reads, serverId, (access) =>
          service.setAgentRemoved(access, person, agentId, action),
        );
      });
    return routes.handleAll({
      listServers: () =>
        Effect.gen(function* () {
          const context = yield* RequestContext;
          return yield* respond(
            reads,
            context.access.serverId,
            (access) =>
              service.getServer(access).pipe(
                Effect.map((result) => ({
                  ...result,
                  data: { items: [result.data], nextCursor: null },
                })),
              ),
            { operation: "listServers" },
          );
        }),
      serverTimeline: ({ params, query }) =>
        respond(reads, params.serverId, (access) => service.serverTimeline(access, query), {
          operation: "serverTimeline",
        }),
      serverTimelineSenders: ({ params, query }) =>
        respond(reads, params.serverId, (access) => service.serverTimelineSenders(access, query), {
          operation: "serverTimelineSenders",
        }),
      serverSummary: ({ params }) =>
        respond(reads, params.serverId, (access) => service.serverSummary(access), {
          operation: "serverSummary",
        }),
      serverFeed: ({ params, query }) =>
        respond(reads, params.serverId, (access) => service.serverFeed(access, query), {
          operation: "serverFeed",
        }),
      getServer: ({ params }) =>
        respond(reads, params.serverId, (access) => service.getServer(access), {
          operation: "getServer",
        }),
      getUpdates: ({ params, payload }) =>
        RequestContext.use(({ reread }) =>
          respond(
            reads,
            params.serverId,
            (access) => service.getUpdates(access, payload),
            reread ? undefined : { operation: "getUpdates", participantId: payload.participantId },
          ),
        ).pipe(
          Effect.map((response) => ({
            ...response,
            meta: {
              ...response.meta,
              instructions: { ...response.meta.instructions, text: Monitoring.updatesInstructions },
            },
          })),
        ),
      registerParticipant: ({ params, payload }) =>
        respond(reads, params.serverId, (access) => service.registerParticipant(access, payload), {
          operation: "registerParticipant",
          kind: "admin",
        }).pipe(
          Effect.map((response) => {
            const root = new URL(`/v1/servers/${params.serverId}`, response.meta.instructions.url);
            return {
              ...response,
              meta: {
                ...response.meta,
                instructions: {
                  ...response.meta.instructions,
                  text: `Save data.item.id (${response.data.item.id}) as your participantId for this server. Read General: GET ${root}/conversations/${response.data.generalConversationId}/messages. If you lose your ID, recover it by your own exact name: GET ${root}/participants?name=${encodeURIComponent(response.data.item.name)}. Reuse that identity deliberately; do not take over another agent's name. Updates: POST ${root}/updates with participantId, mode, and selection or checkpoint. ${Monitoring.onboardingInstructions}`,
                },
              },
            };
          }),
        ),
      listParticipants: ({ params, query }) =>
        Effect.gen(function* () {
          // Only the website's own reads name who registered each agent (`registeredBy`).
          const { website } = yield* RequestContext;
          return yield* respond(
            reads,
            params.serverId,
            (access) => service.listParticipants(access, query, website),
            { operation: "listParticipants" },
          );
        }),
      getParticipant: ({ params }) =>
        respond(
          reads,
          params.serverId,
          (access) => service.getParticipant(access, params.participantId),
          {
            operation: "getParticipant",
          },
        ),
      listWakes: ({ params }) =>
        respond(reads, params.serverId, (access) =>
          wakes.list(access, { serverId: params.serverId, participantId: params.participantId }),
        ).pipe(
          Effect.map((response) => ({
            ...response,
            data: { ...response.data, tokensEnabled: wakes.tokensEnabled },
          })),
        ),
      getWakeCadence: ({ params }) =>
        respond(reads, params.serverId, (access) => wakes.cadence(access, params.participantId), {
          operation: "getWakeCadence",
        }),
      setWakeCadence: ({ params, payload }) =>
        respond(
          reads,
          params.serverId,
          (access) => wakes.setCadence(access, params.participantId, payload),
          { operation: "setWakeCadence", participantId: params.participantId, kind: "admin" },
        ),
      createWake: ({ params, payload }) =>
        Effect.gen(function* () {
          const { website, meta } = yield* RequestContext;
          // A third-party token must never pass through an agent: bearer callers cannot add one.
          if (!website)
            return yield* Effect.fail(
              Envelope.makeFailure(
                "forbidden",
                "Add this wake on the TalkTo dashboard. Agents and API tokens cannot store a routine token.",
                meta,
              ),
            );
          return yield* respond(reads, params.serverId, (access) =>
            wakes.create(access, params.participantId, payload),
          );
        }),
      testWake: ({ params }) =>
        Effect.gen(function* () {
          const { website, meta } = yield* RequestContext;
          // Each test starts a run on the person's account: only their click on the dashboard.
          if (!website)
            return yield* Effect.fail(
              Envelope.makeFailure(
                "forbidden",
                "Send a test from the TalkTo dashboard. Agents and API tokens cannot start one.",
                meta,
              ),
            );
          return yield* respond(
            reads,
            params.serverId,
            (access) => wakes.test(access, params.participantId, params.wakeId),
            { operation: "testWake", participantId: params.participantId, kind: "admin" },
          );
        }),
      revokeWake: ({ params }) =>
        respond(
          reads,
          params.serverId,
          (access) =>
            wakes.revoke(access, {
              serverId: params.serverId,
              participantId: params.participantId,
              wakeId: params.wakeId,
            }),
          { operation: "revokeWake", participantId: params.participantId, kind: "admin" },
        ),
      renameParticipant: ({ params, payload }) =>
        respond(
          reads,
          params.serverId,
          (access) => service.renameSelf(access, params.participantId, payload),
          { operation: "renameParticipant", participantId: params.participantId, kind: "admin" },
        ),
      renameAgent: ({ params, payload }) =>
        RequestContext.use(({ person }) =>
          respond(reads, params.serverId, (access) => service.renameAgent(access, person, payload)),
        ),
      removeAgent: ({ params }) => removal(params.serverId, params.participantId, "removed"),
      restoreAgent: ({ params }) => removal(params.serverId, params.participantId, "restored"),
      listRemovals: ({ params, query }) =>
        respond(reads, params.serverId, (access) => service.listRemovals(access, query), {
          operation: "listRemovals",
        }),
      listRenames: ({ params, query }) =>
        respond(reads, params.serverId, (access) => service.listRenames(access, query), {
          operation: "listRenames",
        }),
      createChannel: ({ params, payload }) =>
        respond(reads, params.serverId, (access) => service.createChannel(access, payload), {
          operation: "createChannel",
          kind: "admin",
        }),
      listChannels: ({ params, query }) =>
        respond(reads, params.serverId, (access) => service.listChannels(access, query), {
          operation: "listChannels",
        }),
      getConversation: ({ params }) =>
        respond(
          reads,
          params.serverId,
          (access) => service.getConversation(access, params.conversationId),
          {
            operation: "getConversation",
          },
        ),
      setChannelArchived: ({ params, payload }) =>
        respond(
          reads,
          params.serverId,
          (access) => service.setChannelArchived(access, params.conversationId, payload),
          { operation: "setChannelArchived", kind: "admin" },
        ),
      openDirectConversation: ({ params, payload }) =>
        respond(
          reads,
          params.serverId,
          (access) => service.openDirectConversation(access, payload),
          {
            operation: "openDirectConversation",
            kind: "admin",
          },
        ),
      getPersonSelf: ({ params }) =>
        respond(reads, params.serverId, (access) => service.getPersonSelf(access)),
      joinAsPerson: ({ params }) =>
        RequestContext.use(({ person }) =>
          respond(reads, params.serverId, (access) => service.joinAsPerson(access, person)),
        ),
      openPersonDirectChat: ({ params, payload }) =>
        RequestContext.use(({ person }) =>
          respond(reads, params.serverId, (access) =>
            service.openPersonDirectChat(access, person, payload),
          ),
        ),
      sendPersonMessage: ({ params, payload }) =>
        respond(reads, params.serverId, (access) => service.sendPersonMessage(access, payload)),
      listDirectConversations: ({ params, query }) =>
        respond(
          reads,
          params.serverId,
          (access) => service.listDirectConversations(access, query),
          {
            operation: "listDirectConversations",
          },
        ),
      sendMessage: ({ params, payload }) =>
        respond(
          reads,
          params.serverId,
          (access) => service.sendMessage(access, params.conversationId, payload),
          { operation: "sendMessage", kind: "send" },
        ),
      readMessages: ({ params, query }) =>
        respond(
          reads,
          params.serverId,
          (access) => service.readMessages(access, params.conversationId, query),
          { operation: "readMessages" },
        ),
      searchMessages: ({ params, query }) =>
        respond(reads, params.serverId, (access) => service.searchMessages(access, query), {
          operation: "searchMessages",
        }),
      getMessageContext: ({ params, query }) =>
        respond(
          reads,
          params.serverId,
          (access) => service.getMessageContext(access, params.messageId, query),
          { operation: "getMessageContext" },
        ),
      readArchive: ({ params, query }) =>
        respond(reads, params.serverId, (access) => service.readArchive(access, query), {
          operation: "readArchive",
        }),
      listFileShares: ({ params, query }) =>
        respond(reads, params.serverId, (access) => service.listShares(access, query), {
          operation: "listFileShares",
        }),
      listTransfers: ({ params, query }) =>
        respond(reads, params.serverId, (access) => service.listTransfers(access, query), {
          operation: "listTransfers",
        }),
      downloadTransfer: ({ params }) =>
        respond(
          reads,
          params.serverId,
          (access) => service.downloadTransfer(access, params.transferId),
          { operation: "downloadTransfer" },
        ),
    });
  }),
);
const system = HttpApiBuilder.group(Api, "system", (routes) =>
  routes.handle("health", () =>
    RequestContext.pipe(Effect.map(({ meta }) => ({ status: "ok" as const, meta }))),
  ),
);
// Authentication occurs before reaching this private Durable Object. The middleware
// publishes the bearer contract; the service still enforces the verified grant.
const authorization = Layer.succeed(
  Security.Authorization,
  Security.Authorization.of({
    bearer: (httpEffect) => httpEffect,
    webSession: (httpEffect) => httpEffect,
  }),
);
// HttpApiBuilder surfaces schema failures as defects; translate only known input errors.
const inputErrors = HttpRouter.middleware(
  (httpEffect) =>
    httpEffect.pipe(
      Effect.catchDefect((defect) => {
        if (!HttpApiError.HttpApiSchemaError.is(defect) || defect.kind !== "Query")
          return Effect.die(defect);
        const message = Responses.timestampError(defect.cause.issue);
        if (message === undefined) return Effect.die(defect);
        return Effect.gen(function* () {
          const { meta } = yield* RequestContext;
          return HttpServerResponse.fromWeb(Responses.failure(400, "invalid_input", message, meta));
        });
      }),
    ),
  { global: true },
);
/** HTTP adapter with injectable application implementation and request-scoped authority. */
export const routes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide([handlers, system]),
  Layer.provide(authorization),
  Layer.provide(HttpServer.layerServices),
  Layer.merge(inputErrors),
);
/** Create one reusable HTTP handler for a server object's lifetime. */
export const makeHandler = (application: Layer.Layer<TalkTo.Service | Reads.Reads | Wakes.Wakes>) =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(application)), {
    disableLogger: true,
    middleware: trace,
  });
