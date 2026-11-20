import { DateTime, Effect, Option, Predicate, Result } from "effect";
import * as M from "@talkto/api/models";
import type * as Configuration from "../configuration.js";
import * as Model from "./model.js";

const provider = "artifacts";
const repositoryName = (serverId: M.ServerId) => `srv-${serverId}`;
/**
 * The binding rejects with an `ArtifactsError` carrying a string `code`. The code is read
 * wherever the runtime keeps it (own property, prototype, or getter); anything else is unclassified.
 */
const bindingCode = (cause: unknown) =>
  Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code) ? cause.code : null;
/** A remote as a log may show it: no user information, query or fragment, which could hold a credential. */
const loggable = (remote: string) => {
  const url = new URL(remote);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
};
const failure = (operation: string) => (cause: unknown) =>
  new Model.FileStoreFailure({
    message: "The file store could not complete the operation.",
    operation,
    provider,
    code: bindingCode(cause),
  });
const timestamp = (operation: string, iso: string) =>
  Option.match(DateTime.make(iso), {
    onNone: () =>
      Effect.fail(
        new Model.FileStoreFailure({
          message: "The file store returned an unreadable expiry.",
          operation,
          provider,
          code: null,
        }),
      ),
    onSome: (instant) => Effect.succeed(M.Timestamp.make(DateTime.formatIso(instant))),
  });

/**
 * Hosted store over the Cloudflare Artifacts binding. Provider types stay inside this file.
 *
 * `create` returns plain data, but `get` returns an RPC stub whose info fields (`remote`,
 * `defaultBranch`, ...) are `RpcProperty` objects rather than values: awaiting one fails and
 * recording one stringifies to `[object JsRpcProperty]`. Only the handle's methods are used;
 * the remote of an existing repository is derived from `remoteBase`, which every repository
 * follows because TalkTo names them `srv-<serverId>` and always creates them on `main`.
 */
export const make = (binding: Artifacts, remoteBase: Configuration.ArtifactsRemoteBase) => {
  const derived = (serverId: M.ServerId) => ({
    remote: `${remoteBase}/${repositoryName(serverId)}.git`,
    defaultBranch: "main",
  });
  const repository = (serverId: M.ServerId, operation: string) =>
    Effect.tryPromise({
      try: () => binding.get(repositoryName(serverId)),
      catch: failure(operation),
    });
  const ensure = Effect.fn("ArtifactsStore.ensure")(function* (
    serverId: M.ServerId,
    recorded: Model.Repository | null,
  ) {
    // A valid row already names the remote every repository in this namespace follows; reaching
    // the provider again would only confirm it. A repository deleted at the provider surfaces at
    // `mint` instead.
    if (recorded !== null) return recorded;
    const expected = yield* Model.parseRepository(provider, "derive")(derived(serverId));
    const created = yield* Effect.tryPromise({
      try: () => binding.create(repositoryName(serverId), { setDefaultBranch: "main" }),
      catch: failure("create"),
    }).pipe(Effect.result);
    if (Result.isFailure(created)) {
      // An existing repository settles any creation failure, however the rejection was shaped;
      // the creation failure stands only when no repository can be read either. The handle only
      // confirms existence: none of its info fields are data, so nothing is read from it.
      const existing = yield* repository(serverId, "get").pipe(Effect.result);
      if (Result.isFailure(existing)) return yield* created.failure;
      return expected;
    }
    const minted = yield* Model.parseRepository(
      provider,
      "create",
    )({ remote: created.success.remote, defaultBranch: created.success.defaultBranch });
    if (minted.remote !== expected.remote || minted.defaultBranch !== expected.defaultBranch)
      yield* Effect.logWarning("Artifacts created a repository off the configured remote base", {
        serverId,
        expected: loggable(expected.remote),
        reported: loggable(minted.remote),
        defaultBranch: minted.defaultBranch,
      });
    // Creation mints an initial token TalkTo never records; revoke it so every live token follows a grant.
    const handle = yield* repository(serverId, "get");
    yield* Effect.tryPromise({
      try: () => handle.revokeToken(created.success.token),
      catch: failure("revokeInitialToken"),
    });
    return minted;
  });
  const mint = Effect.fn("ArtifactsStore.mint")(function* (
    serverId: M.ServerId,
    scope: Model.Scope,
    ttlSeconds: Model.TtlSeconds,
  ) {
    const handle = yield* repository(serverId, "get");
    const token = yield* Effect.tryPromise({
      try: () => handle.createToken(scope, ttlSeconds),
      catch: failure("createToken"),
    });
    const expiresAt = yield* timestamp("createToken", token.expiresAt);
    return { id: token.id, token: token.plaintext, expiresAt };
  });
  const revoke = Effect.fn("ArtifactsStore.revoke")(function* (
    serverId: M.ServerId,
    tokenId: string,
  ) {
    const handle = yield* repository(serverId, "get");
    // A missing token is already revoked; the binding reports false rather than throwing.
    yield* Effect.tryPromise({
      try: () => handle.revokeToken(tokenId),
      catch: failure("revokeToken"),
    });
  });
  const remove = Effect.fn("ArtifactsStore.remove")(function* (serverId: M.ServerId) {
    // Deleting an absent repository reports false; erase retries stay idempotent.
    yield* Effect.tryPromise({
      try: () => binding.delete(repositoryName(serverId)),
      catch: failure("delete"),
    });
  });
  return Model.FileStore.of({ ensure, mint, revoke, remove });
};
