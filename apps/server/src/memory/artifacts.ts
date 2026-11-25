import { Effect, Predicate, Schema } from "effect";
import * as Git from "./git.js";
import * as Model from "./model.js";
import { present } from "../present.js";

/**
 * Memory repositories over the Cloudflare Artifacts binding (`MEMORY_ARTIFACTS`). Provider types
 * and shapes stay inside this file: every reply is decoded before TalkTo uses it, because the read
 * methods are not in the generated types yet and an RPC stub's info fields are not data. Every
 * repository handle is an RPC stub and is disposed when its call ends.
 */

const bindingCode = (cause: unknown) =>
  Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code) ? cause.code : null;
const bindingMessage = (cause: unknown) =>
  Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
    ? cause.message
    : null;
/** A method this Artifacts runtime does not have: every name on an RPC stub is a function. */
const notImplemented = (cause: unknown) =>
  /does not implement the method/.test(bindingMessage(cause) ?? "");
/**
 * The code of a binding error. Real Artifacts sets no `code` at 2026-09-08 and says what happened
 * only in its message ("ArtifactsError: repo already exists: …", "Repository not found: …").
 */
const codeOf = (cause: unknown) => {
  const message = bindingMessage(cause) ?? "";
  if (notImplemented(cause)) return "UNSUPPORTED";
  const code = bindingCode(cause);
  if (code !== null) return code;
  if (/already exists/i.test(message)) return "ALREADY_EXISTS";
  if (/repository not found/i.test(message)) return "REPOSITORY_NOT_FOUND";
  return null;
};
const failure =
  (operation: string, code: string | null = null) =>
  (cause: unknown) => {
    const message = bindingMessage(cause);
    const detail = message === null ? "" : Model.safeDetail(message);
    return new Model.MemoryStoreFailure({
      message: notImplemented(cause)
        ? "This Artifacts runtime does not offer a method memory needs."
        : "The memory store could not complete the operation.",
      operation,
      code: code ?? codeOf(cause),
      ...present("detail", detail.length > 0 ? detail : null),
    });
  };
const unreadable = (operation: string) =>
  new Model.MemoryStoreFailure({
    message: "The memory store returned an unreadable reply.",
    operation,
    code: "UNREADABLE",
  });

/** A commit as the binding reports it: the simulator and staging name the tree differently. */
const ReportedCommit = Schema.Struct({
  hash: Schema.optionalKey(Schema.String),
  oid: Schema.optionalKey(Schema.String),
  tree: Schema.optionalKey(Schema.String),
  treeHash: Schema.optionalKey(Schema.String),
  parents: Schema.optionalKey(Schema.Array(Schema.String)),
  message: Schema.String,
});
const ReportedEntry = Schema.Struct({
  name: Schema.String,
  mode: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  type: Schema.optionalKey(Schema.String),
  hash: Schema.optionalKey(Schema.String),
  oid: Schema.optionalKey(Schema.String),
});
const Remote = Schema.String.check(
  Schema.makeFilter((value) => URL.canParse(value) && new URL(value).protocol === "https:", {
    title: "HttpsGitRemote",
  }),
);
const toCommit =
  (operation: string, fallbackHash: string | null) => (reported: typeof ReportedCommit.Type) =>
    Schema.decodeUnknownEffect(Model.Commit)({
      hash: reported.hash ?? reported.oid ?? fallbackHash,
      tree: reported.tree ?? reported.treeHash,
      parents: reported.parents ?? [],
      message: reported.message,
    }).pipe(Effect.mapError(() => unreadable(operation)));
const kindOf = (entry: typeof ReportedEntry.Type): Model.TreeEntry["kind"] => {
  const mode = entry.mode === undefined ? "" : String(entry.mode).replace(/^0+/, "");
  if (entry.type === "tree" || mode === "40000") return "tree";
  if (entry.type === "blob" || mode === "100644" || mode === "100755") return "blob";
  return "other";
};
/**
 * Dispose an RPC result: the runtime gives every object it returns over RPC a disposer, and warns
 * ("An RPC result was not disposed properly") when one is left. Its plain fields stay readable.
 * A string, boolean or null has nothing to dispose.
 */
const release = <A>(value: A) => {
  if (!Predicate.hasProperty(value, Symbol.dispose)) return;
  const dispose = value[Symbol.dispose];
  if (Predicate.isFunction(dispose)) dispose.call(value);
};

export const make = (binding: Artifacts) => {
  /**
   * Run `use` on the repository's handle, then dispose its result (`log`, `readCommit`,
   * `readTree`, `createToken`…) and the handle, whatever happened.
   */
  const withRepository = <A>(
    name: string,
    operation: string,
    use: (repo: ArtifactsRepo) => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const repo = await binding.get(name);
        try {
          const result = await use(repo);
          release(result);
          return result;
        } finally {
          repo[Symbol.dispose]();
        }
      },
      catch: failure(operation),
    });
  const created = (operation: string, value: { readonly remote: unknown }) =>
    Schema.decodeUnknownEffect(Remote)(value.remote).pipe(
      Effect.map((remote) => ({ remote })),
      Effect.mapError(() => unreadable(operation)),
    );
  const create = Effect.fn("MemoryArtifacts.create")(function* (name: string) {
    const result = yield* Effect.tryPromise({
      try: async () => {
        const reply = await binding.create(name, {
          setDefaultBranch: "main",
          description: "TalkTo swarm memory",
        });
        release(reply);
        return { remote: reply.remote, token: reply.token };
      },
      catch: failure("create"),
    });
    const repository = yield* created("create", result);
    // Creation mints a token TalkTo never records; revoke it so every live token follows a grant.
    yield* withRepository(name, "revokeInitialToken", (repo) => repo.revokeToken(result.token));
    return repository;
  });
  const fork = Effect.fn("MemoryArtifacts.fork")(function* (source: string, name: string) {
    const result = yield* withRepository(source, "fork", async (repo) => {
      const reply = await repo.fork(name, {
        defaultBranchOnly: true,
        description: "TalkTo swarm memory (fork)",
      });
      release(reply);
      return { remote: reply.remote, token: reply.token };
    });
    const repository = yield* created("fork", result);
    yield* withRepository(name, "revokeInitialToken", (repo) => repo.revokeToken(result.token));
    return repository;
  });
  const remove = Effect.fn("MemoryArtifacts.remove")(function* (name: string) {
    // Deleting an absent repository reports false; erase retries stay idempotent.
    yield* Effect.tryPromise({ try: () => binding.delete(name), catch: failure("delete") });
  });
  const head = Effect.fn("MemoryArtifacts.head")(function* (name: string) {
    // An empty repository's log is empty; some runtimes answer NOT_FOUND for a missing main.
    const entries = yield* withRepository(name, "log", (repo) =>
      repo.log({ ref: "main", limit: 1 }),
    ).pipe(
      Effect.catchIf(
        (error) => error.code === "NOT_FOUND",
        () => Effect.succeed([]),
      ),
    );
    const commits = yield* Schema.decodeUnknownEffect(Schema.Array(ReportedCommit))(entries).pipe(
      Effect.mapError(() => unreadable("log")),
    );
    const first = commits[0];
    if (first === undefined) return null;
    return yield* toCommit("log", null)(first);
  });
  const commit = Effect.fn("MemoryArtifacts.commit")(function* (name: string, hash: string) {
    const value = yield* withRepository(name, "readCommit", (repo) => repo.readCommit(hash));
    if (value === null || value === undefined) return null;
    const reported = yield* Schema.decodeUnknownEffect(ReportedCommit)(value).pipe(
      Effect.mapError(() => unreadable("readCommit")),
    );
    return yield* toCommit("readCommit", hash)(reported);
  });
  const tree = Effect.fn("MemoryArtifacts.tree")(function* (name: string, hash: string) {
    const value = yield* withRepository(name, "readTree", (repo) => repo.readTree(hash));
    if (value === null || value === undefined) return null;
    const entries = yield* Schema.decodeUnknownEffect(Schema.Array(ReportedEntry))(value).pipe(
      Effect.mapError(() => unreadable("readTree")),
    );
    return entries.map((entry): Model.TreeEntry => ({
      name: entry.name,
      hash: entry.hash ?? entry.oid ?? "",
      kind: kindOf(entry),
    }));
  });
  /** A repository's own Git endpoint with a token that lives for this one request. */
  const send = Effect.fn("MemoryArtifacts.send")(function* (
    name: string,
    scope: "read" | "write",
    operation: string,
    url: string,
    headers: Readonly<Record<string, string>>,
    body: Uint8Array,
  ) {
    const credential = yield* mint(name, scope, Model.TtlSeconds.make(60));
    return yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          method: "POST",
          headers: { ...headers, authorization: `Bearer ${credential.token}` },
          body,
        });
        return {
          ok: response.ok,
          status: response.status,
          bytes: new Uint8Array(await response.arrayBuffer()),
        };
      },
      catch: failure(operation),
    }).pipe(Effect.ensuring(revoke(name, credential.id).pipe(Effect.ignore)));
  });
  const refused = (operation: string, status: number, bytes: Uint8Array) => {
    const detail = Model.safeDetail(new TextDecoder().decode(bytes));
    return new Model.MemoryStoreFailure({
      message: "The memory store refused TalkTo's Git request.",
      operation,
      code: `HTTP_${status}`,
      status,
      ...present("detail", detail.length > 0 ? detail : null),
    });
  };
  const blob = Effect.fn("MemoryArtifacts.blob")(function* (
    name: string,
    remote: string,
    hash: string,
  ) {
    const sent = yield* send(
      name,
      "read",
      "uploadPack",
      `${remote}/git-upload-pack`,
      {
        "git-protocol": "version=2",
        "content-type": "application/x-git-upload-pack-request",
        accept: "application/x-git-upload-pack-result",
      },
      Git.wantRequest(hash),
    );
    if (!sent.ok) return yield* refused("uploadPack", sent.status, sent.bytes);
    // Git answers a want it does not have with an error line, not a pack.
    if (
      /not our ref|not found|no such/i.test(new TextDecoder().decode(sent.bytes.subarray(0, 200)))
    )
      return null;
    return yield* Git.readWanted(sent.bytes, hash).pipe(
      Effect.mapError(
        (error) =>
          new Model.MemoryStoreFailure({
            message: "The memory store returned an unreadable reply.",
            operation: "uploadPack",
            code: "UNREADABLE",
            detail: Model.safeDetail(error.message),
          }),
      ),
    );
  });
  const mint = Effect.fn("MemoryArtifacts.mint")(function* (
    name: string,
    scope: "read" | "write",
    ttl: Model.TtlSeconds,
  ) {
    const token = yield* withRepository(name, "createToken", (repo) =>
      repo.createToken(scope, ttl),
    );
    const expiresAt = Date.parse(token.expiresAt);
    if (!Number.isFinite(expiresAt)) return yield* unreadable("createToken");
    return { id: token.id, token: token.plaintext, expiresAt };
  });
  const revoke = Effect.fn("MemoryArtifacts.revoke")(function* (name: string, tokenId: string) {
    yield* withRepository(name, "revokeToken", (repo) => repo.revokeToken(tokenId));
  });
  const push = Effect.fn("MemoryArtifacts.push")(function* (
    name: string,
    remote: string,
    body: Uint8Array,
  ) {
    // TalkTo's own write: a token that lives for this one request, revoked right after.
    const sent = yield* send(
      name,
      "write",
      "receivePack",
      `${remote}/git-receive-pack`,
      {
        "content-type": "application/x-git-receive-pack-request",
        accept: "application/x-git-receive-pack-result",
      },
      body,
    );
    if (!sent.ok) return yield* refused("receivePack", sent.status, sent.bytes);
    return new TextDecoder().decode(sent.bytes);
  });
  return Model.Repositories.of({
    available: true,
    create,
    fork,
    remove,
    head,
    commit,
    tree,
    blob,
    mint,
    revoke,
    push,
  });
};
