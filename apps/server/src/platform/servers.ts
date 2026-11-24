import { Effect, Layer } from "effect";
import type { Capability } from "../capabilities.js";
import * as Platform from "./service.js";
import * as Model from "./model.js";

const unavailable = () =>
  new Model.Failure({
    code: "storage_unavailable",
    message: "The server has not yet confirmed the change. Retrying is safe.",
  });
/**
 * Translate application management operations into private Durable Object RPCs.
 *
 * @param namespace - The binding that reaches each server.
 * @param capabilities - What this deployment offers; the server shares the environment, so the
 * capability is answered here without a call.
 */
export const layer = (namespace: Env["SERVERS"], capabilities: ReadonlySet<Capability>) =>
  Layer.succeed(
    Platform.Servers,
    Platform.Servers.of({
      provision: Effect.fn("Servers.provision")(function* (server) {
        const result = yield* Effect.tryPromise({
          try: () => namespace.getByName(server.id).provision(server),
          catch: unavailable,
        });
        if (!result.ok) return yield* unavailable();
      }),
      erase: Effect.fn("Servers.erase")(function* (deletion) {
        yield* Effect.tryPromise({
          try: () => namespace.getByName(deletion.serverId).erase(deletion),
          catch: () =>
            new Model.Failure({
              code: "storage_unavailable",
              message:
                "Deletion is in progress. Retrying is safe; billing and message usage are preserved.",
            }),
        });
      }),
      apply: Effect.fn("Servers.apply")(function* (command) {
        const result = yield* Effect.tryPromise({
          try: () => namespace.getByName(command.serverId).applyAccess(command),
          catch: unavailable,
        });
        if (!result.ok) return yield* unavailable();
      }),
      rename: Effect.fn("Servers.rename")(function* (name) {
        const result = yield* Effect.tryPromise({
          try: () => namespace.getByName(name.serverId).renameServer(name),
          catch: unavailable,
        });
        if (!result.ok) return yield* unavailable();
      }),
      forgetPerson: Effect.fn("Servers.forgetPerson")(function* (command) {
        const result = yield* Effect.tryPromise({
          try: () => namespace.getByName(command.serverId).forgetPerson(command),
          catch: unavailable,
        });
        if (!result.ok) return yield* unavailable();
      }),
      files: Effect.fn("Servers.files")(function* (serverId) {
        if (!capabilities.has("files")) return null;
        // An unreachable server degrades to the capability alone; the management view never fails on it.
        const repository = yield* Effect.tryPromise({
          try: () => namespace.getByName(serverId).fileRepository(),
          catch: unavailable,
        }).pipe(Effect.catch(() => Effect.succeed(null)));
        return { repository };
      }),
    }),
  );
