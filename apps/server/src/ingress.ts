import { Effect, Redacted, Result, Schema } from "effect";
import * as A from "@talkto/api/agent";
import * as Mcp from "./mcp.js";
import * as BoardSettings from "./board/settings.js";
import * as McpEvents from "./wakes/mcp-events.js";
import * as Signals from "./signals.js";
import { OpenApi } from "effect/unstable/httpapi";
import { Api } from "@talkto/api/api";
import * as Configuration from "./configuration.js";
import { capabilities } from "./capabilities.js";
import * as Responses from "./responses.js";
import * as Access from "./access.js";
import * as Persons from "./people.js";
import * as UpdateSignal from "./update-signal.js";
import * as UpdateWait from "./update-wait.js";
import { run } from "@talkto/telemetry/effect";
import { installGuide } from "@talkto/api/agent-guides";
import { agentGuide } from "./guide.js";
import skill from "./skill.md";
import { renderDocumentation } from "@talkto/api/documentation";

const maximumRequestBytes = 131072;
/** Verify the explicitly configured development credential before any server access. */
export const localAccess = Effect.fn("Ingress.localAccess")(function* (request: Request, env: Env) {
  const hostname = new URL(request.url).hostname;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return false;
  const configured = yield* Configuration.readLocalToken(env);
  const expected = Redacted.value(configured);
  if (!/^[a-f0-9]{64}$/.test(expected))
    return yield* new Configuration.ConfigurationUnavailable({
      message:
        "The local credential must be 64 lowercase hexadecimal characters. Run pnpm setup:local.",
    });
  const header = request.headers.get("authorization") ?? "";
  const credential = /^Bearer +([a-f0-9]{64})$/i.exec(header)?.[1];
  if (credential === undefined) return false;
  return crypto.subtle.timingSafeEqual(
    new TextEncoder().encode(expected),
    new TextEncoder().encode(credential),
  );
});
/** Authentication port for the Worker boundary. WorkOS will implement the hosted path. */
export type Authenticate = (
  request: Request,
  env: Env,
) => Effect.Effect<boolean, Configuration.ConfigurationUnavailable>;
/** Compose public documentation, credential verification, and forwarding to the selected server. */
export function makeWorker(authenticate: Authenticate): ExportedHandler<Env> {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const meta = Responses.metadata(url.origin);
      if (request.method === "GET" && url.pathname === "/health")
        return Response.json({ status: "ok", meta });
      if (request.method === "GET" && url.pathname === "/instructions")
        return new Response(
          renderDocumentation(agentGuide(BoardSettings.memoryFromEnv(env)), url.origin),
          {
            headers: { "content-type": "text/plain; charset=utf-8" },
          },
        );
      if (request.method === "GET" && url.pathname === "/skill.md")
        return new Response(renderDocumentation(skill, url.origin), {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      const guide = request.method === "GET" ? installGuide(url.pathname, url.origin) : null;
      if (guide !== null)
        return new Response(guide, { headers: { "content-type": "text/markdown; charset=utf-8" } });
      if (request.method === "GET" && url.pathname === "/openapi.json")
        return Response.json(OpenApi.fromApi(Api));
      // Signal links carry their own capability and reach only the configured local server.
      if (Signals.isSignalPath(url.pathname)) {
        const local = await Effect.runPromise(Configuration.read(env).pipe(Effect.result));
        if (Result.isFailure(local))
          return Responses.failure(503, "configuration_unavailable", local.failure.message, meta);
        return Signals.ingress(request, Responses.metadata(local.success.origin), (serverId) =>
          serverId === local.success.serverId
            ? env.SERVERS.getByName(serverId)
            : { checkSignal: async () => ({ kind: "unavailable" }) },
        );
      }
      const authenticated = await Effect.runPromise(authenticate(request, env).pipe(Effect.result));
      if (Result.isFailure(authenticated))
        return Responses.failure(
          503,
          "configuration_unavailable",
          authenticated.failure.message,
          meta,
        );
      if (!authenticated.success)
        return Responses.failure(
          401,
          "unauthenticated",
          "A valid client credential is required.",
          meta,
        );
      const parsedConfig = await Effect.runPromise(Configuration.read(env).pipe(Effect.result));
      if (Result.isFailure(parsedConfig))
        return Responses.failure(
          503,
          "configuration_unavailable",
          parsedConfig.failure.message,
          meta,
        );
      const config = parsedConfig.success;
      const responseMeta = Responses.metadata(config.origin, meta.requestId);
      const discovery = request.method === "GET" && url.pathname === "/v1/servers";
      const serverId = url.pathname.split("/")[3];
      if (
        !discovery &&
        url.pathname !== "/mcp" &&
        (!url.pathname.startsWith("/v1/servers/") || serverId !== config.serverId)
      ) {
        return Responses.failure(
          404,
          "server_unavailable",
          "The server is unavailable.",
          responseMeta,
        );
      }
      const headers = new Headers(request.headers);
      headers.delete("x-talkto-principal");
      headers.delete(Access.websiteHeader);
      headers.delete(Persons.nameHeader);
      headers.delete(UpdateSignal.rereadHeader);
      // Overwrite all authority received from the network. A participant cannot supply it.
      headers.set(
        "x-talkto-access",
        JSON.stringify({
          serverId: config.serverId,
          grantId: config.grantId,
          principalKey: config.principalKey,
        }),
      );
      headers.set("x-talkto-request-id", meta.requestId);
      headers.delete("authorization");
      let body: Uint8Array | null = null;
      if (request.body !== null) {
        const reader = request.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > maximumRequestBytes) {
              await reader.cancel();
              return Responses.failure(
                413,
                "request_too_large",
                "The HTTP request body exceeds 131,072 bytes.",
                responseMeta,
              );
            }
            chunks.push(chunk.value);
          }
        } catch {
          return Responses.failure(
            400,
            "invalid_input",
            "The request body could not be read.",
            responseMeta,
          );
        } finally {
          reader.releaseLock();
        }
        body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
      }
      if (url.pathname === "/mcp") {
        if (request.headers.has("origin") && request.headers.get("origin") !== config.origin)
          return Responses.failure(
            403,
            "forbidden",
            "This browser origin is not allowed.",
            responseMeta,
          );
        return Mcp.fetch(
          new Request(url, { method: request.method, headers, body }),
          {
            events: async (command) =>
              command.arguments.serverId === config.serverId
                ? env.SERVERS.getByName(config.serverId).invokeEvents(
                    config.principalKey,
                    null,
                    command,
                  )
                : {
                    error: {
                      code: McpEvents.codes.forbidden,
                      message: "The server is unavailable.",
                    },
                  },
            invoke: async (command, meta) => {
              const target = command.input.serverId;
              if (target !== undefined && target !== config.serverId)
                return {
                  error: { code: "server_unavailable", message: "The server is unavailable." },
                  meta,
                };
              if (command.tool === "get_context" && target === undefined) {
                if (
                  command.input.page !== undefined ||
                  command.input.participant !== undefined ||
                  command.input.directChats !== undefined
                )
                  return {
                    error: {
                      code: "invalid_input",
                      message:
                        "Select the local serverId for detailed context. The local server directory has no continuation.",
                    },
                    meta,
                  };
                const result = Schema.decodeUnknownSync(A.Reply)(
                  await env.SERVERS.getByName(config.serverId).invokeAgent(
                    config.principalKey,
                    null,
                    { tool: "get_context", input: { ...command.input, serverId: config.serverId } },
                    meta,
                  ),
                );
                if ("error" in result) return result;
                if (!("kind" in result.data) || result.data.kind !== "context")
                  throw new Error("Expected local server context");
                return {
                  data: { kind: "servers", items: [result.data.server], nextCursor: null },
                  included: { participants: [], conversations: [] },
                  meta: {
                    ...result.meta,
                    nextActions: [
                      {
                        reason: "Inspect this server.",
                        tool: "get_context",
                        arguments: { serverId: config.serverId },
                      },
                    ],
                  },
                };
              }
              // A waiting get_updates is held here, on a watch, not in the server object.
              return run(
                UpdateWait.invokeAgent(
                  () => env.SERVERS.getByName(config.serverId),
                  { principalKey: config.principalKey, organizationId: null },
                  command,
                  meta,
                ),
              );
            },
          },
          config.origin,
          capabilities(env),
          BoardSettings.fromEnv(env),
          BoardSettings.memoryFromEnv(env),
        );
      }
      const forwarded = new Request(url, { method: request.method, headers, body });
      // Default placement follows this request. No centralized object pre-creation or region pinning.
      try {
        // A waiting POST …/updates is held here, on a watch, not in the server object.
        return await run(
          UpdateWait.forward(
            () => env.SERVERS.getByName(config.serverId),
            { principalKey: config.principalKey, organizationId: null },
            forwarded,
            body,
          ),
        );
      } catch {
        console.error("TalkTo server unavailable", {
          requestId: meta.requestId,
          serverId: config.serverId,
        });
        return Responses.failure(
          503,
          "storage_unavailable",
          "The server is temporarily unavailable.",
          responseMeta,
        );
      }
    },
  };
}
