import { Clock, Context, DateTime, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi";
import { Api } from "@talkto/api/api";
import * as Access from "./access.js";
import * as Envelope from "@talkto/api/envelope";
import * as Security from "@talkto/api/security";
import * as M from "@talkto/api/models";
import * as T from "@talkto/api/tasks";
import type * as Errors from "@talkto/api/errors";
import type * as Removals from "@talkto/api/removals";
import * as Responses from "./responses.js";
import * as TalkTo from "./talkto.js";
import type { AccessContext } from "./access.js";
import { trace } from "@talkto/telemetry/effect";
import * as Monitoring from "./monitoring.js";
import * as Reads from "./reads.js";
import * as Navigation from "./navigation.js";
import * as Wakes from "./wakes/service.js";
import * as Board from "./board/service.js";
import { memoryMetering, taskOperationParts } from "@talkto/api/pricing";
import { present } from "./present.js";
import * as S from "@talkto/api/signal";
import * as Signals from "./signals.js";

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
    /**
     * The hosted Worker verified one of the person's API keys. A key acts as its person, never as
     * an agent, so it may do the person's dashboard actions here (owner, 25 Nov).
     */
    readonly apiKey: boolean;
    /** The signed-in person's verified profile, used only if a person endpoint creates them. */
    readonly person: TalkTo.PersonProfile;
    /**
     * A Worker reads get_updates again because a watch woke the waiting call it holds; that call
     * was already admitted as one read. Set only from the Worker's header (update-signal.ts).
     */
    readonly reread: boolean;
  }
>()("@talkto/HttpRequestContext") {}

/** A feed page's operation by what it reads; only searches and time windows are deep reads. */
const feedOperations = {
  page: "serverFeed",
  search: "serverFeedSearch",
  window: "serverFeedWindow",
} as const;
const respond = Effect.fn("Http.respond")(function* <A, C, F extends Errors.Failure>(
  reads: Reads.Reads["Service"],
  serverId: M.ServerId,
  operation: (access: AccessContext) => Effect.Effect<M.Outcome<A, C>, F>,
  read?: {
    readonly operation: string;
    readonly participantId?: M.ParticipantId;
    /**
     * `read` (the default) admits a read; `admin` an admin call; `send` counts a refused send;
     * `task` admits a task operation.
     */
    readonly kind?: "read" | "admin" | "send" | "task";
    /** The parts a task operation counts (`taskOperationParts`, a renewal fewer), when not 5. */
    readonly units?: number;
    /** For an admin call, whether a spent month refuses it (`Reads.AdminCall.monthly`). */
    readonly monthly?: boolean;
  },
) {
  const context = yield* RequestContext;
  const access = { ...context.access, serverId };
  const call = {
    operation: read?.operation ?? "",
    // The website's views have their own per-person bound and never wait on the agents' bucket.
    transport: context.website ? ("dashboard" as const) : ("http" as const),
    participantId: read?.participantId ?? null,
    ...present("units", read?.units),
    monthly: read?.monthly !== false,
  };
  const guarded =
    read === undefined
      ? operation(access)
      : read.kind === "admin"
        ? reads.admin(access, call).pipe(Effect.andThen(operation(access)))
        : read.kind === "task"
          ? reads.task(access, call).pipe(Effect.andThen(operation(access)))
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
/**
 * A person's own route: an invited agent is never a person (docs/agent-invites.md), so it is
 * refused before the route can create or act as a person's participant.
 */
const asPerson = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const { access, meta } = yield* RequestContext;
    if (Access.isInvited(access.principalKey))
      return yield* Effect.fail(
        Envelope.makeFailure(
          "forbidden",
          "An invited agent acts only as its own agent, never as a person.",
          meta,
        ),
      );
    return yield* effect;
  });
const handlers = HttpApiBuilder.group(Api, "server", (routes) =>
  Effect.gen(function* () {
    const service = yield* TalkTo.Service;
    const reads = yield* Reads.Reads;
    const wakes = yield* Wakes.Wakes;
    const board = yield* Board.Board;
    /** The dashboard's origin, where each task's page lives. */
    const origin = RequestContext.pipe(
      Effect.map(({ meta }) => new URL(meta.instructions.url).origin),
    );
    /**
     * People's board actions run only for the person: a signed-in website session (spec 4.7) or
     * one of their API keys, never an agent's token.
     */
    const website = <A, F, R>(effect: Effect.Effect<A, F, R>) =>
      Effect.gen(function* () {
        const context = yield* RequestContext;
        if (!context.website && !context.apiKey)
          return yield* Effect.fail(
            Envelope.makeFailure(
              "forbidden",
              "Do this on the TalkTo dashboard or with an API key. Agents cannot.",
              context.meta,
            ),
          );
        return yield* effect;
      });
    // Only a person on the dashboard removes or restores an agent: agents share their person's
    // connection, so one agent could otherwise cut off the others.
    const removal = (serverId: M.ServerId, agentId: M.ParticipantId, action: Removals.Action) =>
      Effect.gen(function* () {
        const { website, apiKey, meta, person } = yield* RequestContext;
        if (!website && !apiKey)
          return yield* Effect.fail(
            Envelope.makeFailure(
              "forbidden",
              "Remove or restore an agent on the TalkTo dashboard or with an API key. Agents cannot.",
              meta,
            ),
          );
        // The website is not metered here, as before keys. A key's call is the person's admin call,
        // never the agent's, and waits only on the minute: a spent month never stops a removal.
        return yield* respond(
          reads,
          serverId,
          (access) => service.setAgentRemoved(access, person, agentId, action),
          apiKey
            ? {
                operation: action === "removed" ? "removeAgent" : "restoreAgent",
                kind: "admin",
                monthly: false,
              }
            : undefined,
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
          operation: feedOperations[Navigation.feedReach(query)],
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
          const { website, apiKey, meta } = yield* RequestContext;
          // A third-party token must never pass through an agent: only the person adds one, on the
          // dashboard or with their API key.
          if (!website && !apiKey)
            return yield* Effect.fail(
              Envelope.makeFailure(
                "forbidden",
                "Add this wake on the TalkTo dashboard or with an API key. Agents cannot store a routine token.",
                meta,
              ),
            );
          // The website is not metered here, as before keys. A key's call is the person's admin
          // call, not the agent's: a key's loop never spends the agent's minute.
          return yield* respond(
            reads,
            params.serverId,
            (access) => wakes.create(access, params.participantId, payload),
            apiKey ? { operation: "createWake", kind: "admin" } : undefined,
          );
        }),
      testWake: ({ params }) =>
        Effect.gen(function* () {
          const { website, apiKey, meta } = yield* RequestContext;
          // Each test starts a run on the person's account: only the person, on the dashboard or
          // with their API key.
          if (!website && !apiKey)
            return yield* Effect.fail(
              Envelope.makeFailure(
                "forbidden",
                "Send a test from the TalkTo dashboard or with an API key. Agents cannot start one.",
                meta,
              ),
            );
          return yield* respond(
            reads,
            params.serverId,
            (access) => wakes.test(access, params.participantId, params.wakeId),
            // The person's admin call: only a person sends a test, so it never spends the agent's.
            { operation: "testWake", kind: "admin" },
          );
        }),
      revokeWake: ({ params }) =>
        respond(
          reads,
          params.serverId,
          (access) =>
            wakes.revoke(
              access,
              {
                serverId: params.serverId,
                participantId: params.participantId,
                wakeId: params.wakeId,
              },
              "person",
            ),
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
        asPerson(
          RequestContext.use(({ person }) =>
            respond(reads, params.serverId, (access) =>
              service.renameAgent(access, person, payload),
            ),
          ),
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
        asPerson(respond(reads, params.serverId, (access) => service.getPersonSelf(access))),
      joinAsPerson: ({ params }) =>
        asPerson(
          RequestContext.use(({ person }) =>
            respond(reads, params.serverId, (access) => service.joinAsPerson(access, person)),
          ),
        ),
      openPersonDirectChat: ({ params, payload }) =>
        asPerson(
          RequestContext.use(({ person }) =>
            respond(reads, params.serverId, (access) =>
              service.openPersonDirectChat(access, person, payload),
            ),
          ),
        ),
      sendPersonMessage: ({ params, payload }) =>
        asPerson(
          respond(reads, params.serverId, (access) => service.sendPersonMessage(access, payload)),
        ),
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
      createTasks: ({ params, payload }) =>
        Effect.gen(function* () {
          const at = yield* origin;
          return yield* respond(
            reads,
            params.serverId,
            (access) =>
              board.createTasks(
                access,
                { ...payload, serverId: params.serverId, participantId: params.participantId },
                at,
              ),
            { operation: "createTasks", participantId: params.participantId, kind: "task" },
          );
        }),
      claimTask: ({ params, payload }) =>
        Effect.gen(function* () {
          const at = yield* origin;
          // A Worker holding a claim for next claims again on each wake; the call was admitted once.
          const { reread } = yield* RequestContext;
          return yield* respond(
            reads,
            params.serverId,
            (access) =>
              board.claimTask(
                access,
                { ...payload, serverId: params.serverId, participantId: params.participantId },
                at,
              ),
            reread
              ? undefined
              : { operation: "claimTask", participantId: params.participantId, kind: "task" },
          );
        }),
      updateTask: ({ params, payload }) =>
        Effect.gen(function* () {
          const at = yield* origin;
          return yield* respond(
            reads,
            params.serverId,
            (access) =>
              board.updateTask(
                access,
                {
                  ...payload,
                  serverId: params.serverId,
                  participantId: params.participantId,
                  taskId: params.taskId,
                },
                at,
              ),
            {
              operation: "updateTask",
              participantId: params.participantId,
              kind: "task",
              units: Reads.taskParts(payload.action),
            },
          );
        }),
      listTasks: ({ params, query }) =>
        Effect.gen(function* () {
          const at = yield* origin;
          return yield* respond(
            reads,
            params.serverId,
            (access) => board.listTasks(access, { ...query, serverId: params.serverId }, at),
            { operation: "listTasks", participantId: query.participantId },
          );
        }),
      readTask: ({ params, query }) =>
        Effect.gen(function* () {
          const at = yield* origin;
          return yield* respond(
            reads,
            params.serverId,
            (access) =>
              board.readTask(
                access,
                {
                  ...query,
                  serverId: params.serverId,
                  task: isTaskNumber(params.task) ? { number: params.task } : { id: params.task },
                },
                at,
              ),
            { operation: "readTask", participantId: query.participantId },
          );
        }),
      readMemory: ({ params, query }) =>
        respond(reads, params.serverId, (access) => board.readMemory(access, query), {
          operation: "readMemory",
          participantId: query.participantId,
        }),
      getMemoryAccess: ({ params, payload }) =>
        respond(
          reads,
          params.serverId,
          (access) =>
            board.memoryAccess(access, { ...payload, participantId: params.participantId }),
          {
            operation: "getMemoryAccess",
            participantId: params.participantId,
            kind: "task",
            units: memoryMetering.grantTaskOperations * taskOperationParts,
          },
        ),
      getBoard: ({ params, query }) =>
        website(
          respond(reads, params.serverId, (access) => board.board(access, query), {
            operation: "board",
          }),
        ),
      listBoardLabels: ({ params }) =>
        website(
          respond(reads, params.serverId, (access) => board.boardLabels(access), {
            operation: "boardLabels",
          }),
        ),
      listBoardTasks: ({ params, query }) =>
        website(
          respond(reads, params.serverId, (access) => board.boardTasks(access, query), {
            operation: "boardTasks",
          }),
        ),
      getBoardTask: ({ params, query }) =>
        website(
          Effect.gen(function* () {
            const at = yield* origin;
            return yield* respond(
              reads,
              params.serverId,
              (access) =>
                board.boardTask(
                  access,
                  {
                    ...query,
                    task: isTaskNumber(params.task) ? { number: params.task } : { id: params.task },
                  },
                  at,
                ),
              { operation: "boardTask" },
            );
          }),
        ),
      // The server's creator switches it on the website or with their own token (owner, Nov 25).
      setBoard: ({ params, payload }) =>
        RequestContext.use(({ person }) =>
          respond(reads, params.serverId, (access) => board.setBoard(access, person, payload), {
            operation: "setBoard",
            kind: "admin",
          }),
        ),
      cancelTask: ({ params, payload }) =>
        website(
          Effect.gen(function* () {
            const { person } = yield* RequestContext;
            const at = yield* origin;
            return yield* respond(
              reads,
              params.serverId,
              (access) => board.cancel(access, person, params.taskId, payload, at),
              { operation: "cancelTask", kind: "admin" },
            );
          }),
        ),
      reopenTask: ({ params, payload }) =>
        website(
          Effect.gen(function* () {
            const { person } = yield* RequestContext;
            const at = yield* origin;
            return yield* respond(
              reads,
              params.serverId,
              (access) => board.reopen(access, person, params.taskId, payload, at),
              { operation: "reopenTask", kind: "admin" },
            );
          }),
        ),
      downloadTransfer: ({ params }) =>
        respond(
          reads,
          params.serverId,
          (access) => service.downloadTransfer(access, params.transferId),
          { operation: "downloadTransfer" },
        ),
      // The transfer and signal routes run the same operations as their MCP tools.
      getPackCommand: ({ params }) =>
        respond(reads, params.serverId, (access) => service.getPackCommand(access), {
          operation: "getPackCommand",
          kind: "admin",
        }),
      prepareTransfer: ({ params, payload }) =>
        respond(
          reads,
          params.serverId,
          (access) => service.prepareTransfer(access, { ...payload, serverId: params.serverId }),
          { operation: "prepareTransfer", participantId: payload.participantId, kind: "admin" },
        ),
      completeTransfer: ({ params, payload }) =>
        respond(
          reads,
          params.serverId,
          (access) =>
            service.completeTransfer(access, {
              ...payload,
              serverId: params.serverId,
              transferId: params.transferId,
            }),
          { operation: "completeTransfer", participantId: payload.participantId, kind: "send" },
        ),
      fetchTransfer: ({ params, payload }) =>
        respond(
          reads,
          params.serverId,
          (access) =>
            service.fetchTransfer(access, {
              serverId: params.serverId,
              participantId: payload.participantId,
              transferId: params.transferId,
            }),
          { operation: "fetchTransfer", participantId: payload.participantId },
        ),
      readTransfer: ({ params }) =>
        respond(
          reads,
          params.serverId,
          (access) =>
            service.readTransfer(access, {
              serverId: params.serverId,
              transferId: params.transferId,
            }),
          { operation: "readTransfer" },
        ),
      createSignal: ({ params, payload }) =>
        Effect.gen(function* () {
          const { meta } = yield* RequestContext;
          const minted = yield* respond(
            reads,
            params.serverId,
            (access) =>
              service.createSignal(access, {
                ...payload,
                serverId: params.serverId,
                participantId: params.participantId,
              }),
            { operation: "createSignal", participantId: params.participantId, kind: "admin" },
          );
          const origin = new URL(meta.instructions.url).origin;
          return {
            ...minted,
            data: {
              signalId: minted.data.signalId,
              url: Signals.url(origin, params.serverId, minted.data.signalId, minted.data.secret),
              expiresAt: minted.data.expiresAt,
              selection: minted.data.selection,
              minIntervalSeconds: S.minIntervalSeconds,
              procedure: Signals.procedure,
            },
          };
        }),
      revokeSignals: ({ params }) =>
        respond(
          reads,
          params.serverId,
          (access) =>
            service.revokeSignal(access, {
              serverId: params.serverId,
              participantId: params.participantId,
            }),
          { operation: "revokeSignals", participantId: params.participantId, kind: "admin" },
        ),
      revokeSignal: ({ params }) =>
        respond(
          reads,
          params.serverId,
          (access) =>
            service.revokeSignal(access, {
              serverId: params.serverId,
              participantId: params.participantId,
              signalId: params.signalId,
            }),
          { operation: "revokeSignal", participantId: params.participantId, kind: "admin" },
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
        if (!HttpApiError.HttpApiSchemaError.is(defect)) return Effect.die(defect);
        const message =
          defect.kind === "Query" ? Responses.timestampError(defect.cause.issue) : undefined;
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
/** The task route's path names a task by number or by ID (T.TaskIdOrNumber). */
const isTaskNumber = Schema.is(T.TaskNumber);
/** Create one reusable HTTP handler for a server object's lifetime. */
export const makeHandler = (
  application: Layer.Layer<TalkTo.Service | Reads.Reads | Wakes.Wakes | Board.Board>,
) =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(application)), {
    disableLogger: true,
    middleware: trace,
  });
