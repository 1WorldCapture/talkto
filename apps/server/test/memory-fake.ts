import { Effect, Predicate } from "effect";
import * as Model from "../src/memory/model.js";
import * as Git from "../src/memory/git.js";

/**
 * An in-memory Artifacts stand-in for swarm memory: real Git objects (built and hashed as Git does)
 * in a map per repository, refs, and tokens. TalkTo's own pushes arrive as receive-pack bodies and
 * are unpacked here, so the seed and restore paths run their real Git writer. Agents' pushes are
 * simulated through `control`: a commit on main, a force push, a deleted main, another branch.
 *
 * Module state is shared by every server object in the isolate, so one server can fork another's.
 */

interface Stored {
  readonly type: Git.ObjectType;
  readonly body: Uint8Array;
}
interface Repository {
  readonly remote: string;
  readonly objects: Map<string, Stored>;
  readonly refs: Map<string, string>;
}
interface Token {
  readonly id: string;
  readonly repository: string;
  readonly scope: "read" | "write";
  readonly ttl: number;
  revoked: boolean;
}
const repositories = new Map<string, Repository>();
const tokens: Token[] = [];
const pushes: Array<{
  readonly repository: string;
  readonly body: string;
  readonly report: string;
}> = [];
const removed: string[] = [];
let sequence = 0;
const levers = { failPushes: 0, failHeads: 0, failRemovals: 0 };

const decoder = new TextDecoder();
const failure = (operation: string, code: string) =>
  new Model.MemoryStoreFailure({ message: "The fake memory store refused.", operation, code });
const missing = (operation: string) => Effect.fail(failure(operation, "NOT_FOUND"));
const repositoryOf = (name: string) => repositories.get(name);

const parseCommit = (hash: string, body: Uint8Array): Model.Commit => {
  const text = decoder.decode(body);
  const [head = "", ...rest] = text.split("\n\n");
  const lines = head.split("\n");
  return {
    hash,
    tree: (lines.find((line) => line.startsWith("tree ")) ?? "").slice(5),
    parents: lines.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7)),
    message: rest.join("\n\n"),
  };
};
const parseTree = (body: Uint8Array): ReadonlyArray<Model.TreeEntry> => {
  const entries: Model.TreeEntry[] = [];
  let offset = 0;
  while (offset < body.byteLength) {
    const space = body.indexOf(0x20, offset);
    const nul = body.indexOf(0, space);
    const mode = decoder.decode(body.subarray(offset, space));
    const name = decoder.decode(body.subarray(space + 1, nul));
    const hash = [...body.subarray(nul + 1, nul + 21)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    entries.push({ name, hash, kind: mode === "40000" ? "tree" : "blob" });
    offset = nul + 21;
  }
  return entries;
};
/** Read a zlib stream of stored blocks (what TalkTo's writer sends); returns the data and its length. */
const unstore = (bytes: Uint8Array, start: number) => {
  let offset = start + 2;
  const parts: Uint8Array[] = [];
  for (;;) {
    const final = (bytes[offset] ?? 0) & 1;
    const length = (bytes[offset + 1] ?? 0) | ((bytes[offset + 2] ?? 0) << 8);
    offset += 5;
    parts.push(bytes.subarray(offset, offset + length));
    offset += length;
    if (final === 1) break;
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const data = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.byteLength;
  }
  return { data, end: offset + 4 };
};
/** A pack entry's type code (TalkTo's writer sends only these three). */
const typeOf = (code: number): Git.ObjectType =>
  code === 1 ? "commit" : code === 2 ? "tree" : "blob";
/** Unpack one receive-pack request: its ref update and its objects. */
const unpack = Effect.fn("MemoryFake.unpack")(function* (body: Uint8Array) {
  const length = Number.parseInt(decoder.decode(body.subarray(0, 4)), 16);
  const command = decoder.decode(body.subarray(4, length)).split("\0")[0] ?? "";
  const [old = "", next = "", ref = ""] = command.trim().split(" ");
  let offset = length + 4; // the flush packet "0000"
  const count =
    ((body[offset + 8] ?? 0) << 24) |
    ((body[offset + 9] ?? 0) << 16) |
    ((body[offset + 10] ?? 0) << 8) |
    (body[offset + 11] ?? 0);
  offset += 12;
  const objects: Git.GitObject[] = [];
  for (let index = 0; index < count; index++) {
    let byte = body[offset] ?? 0;
    const type = typeOf((byte >> 4) & 7);
    offset += 1;
    while ((byte & 128) !== 0) {
      byte = body[offset] ?? 0;
      offset += 1;
    }
    const { data, end } = unstore(body, offset);
    offset = end;
    objects.push(yield* Git.object(type, data));
  }
  return { old, next, ref, objects };
});

/** The files of a commit, by path. */
const filesOf = (repository: Repository, commit: string | undefined) => {
  const files = new Map<string, string>();
  if (commit === undefined) return files;
  const stored = repository.objects.get(commit);
  if (stored === undefined) return files;
  const walk = (tree: string, prefix: string) => {
    const object = repository.objects.get(tree);
    if (object === undefined) return;
    for (const entry of parseTree(object.body)) {
      if (entry.kind === "tree") walk(entry.hash, `${prefix}${entry.name}/`);
      else
        files.set(
          `${prefix}${entry.name}`,
          decoder.decode(repository.objects.get(entry.hash)?.body),
        );
    }
  };
  walk(parseCommit(commit, stored.body).tree, "");
  return files;
};
const keep = (repository: Repository, objects: ReadonlyArray<Git.GitObject>) => {
  for (const object of objects)
    repository.objects.set(object.id, { type: object.type, body: object.body });
};
const encoder = new TextEncoder();
const join = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};
const pkt = (payload: Uint8Array) =>
  join([encoder.encode((payload.byteLength + 4).toString(16).padStart(4, "0")), payload]);
/** A protocol-v2 fetch reply carrying `object` alone, its pack on side band 1, as Artifacts sends it. */
const wantReply = Effect.fn("MemoryFake.wantReply")(function* (object: Git.GitObject) {
  const packed = yield* Git.pack([object]);
  const lines = [pkt(encoder.encode("packfile\n"))];
  for (let offset = 0; offset < packed.byteLength; offset += 65_515)
    lines.push(pkt(join([Uint8Array.of(1), packed.subarray(offset, offset + 65_515)])));
  return join([...lines, encoder.encode("0000")]);
});
const base64 = (bytes: Uint8Array) => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

export const store = Model.Repositories.of({
  available: true,
  create: (name) =>
    Effect.suspend(() => {
      if (repositories.has(name)) return Effect.fail(failure("create", "ALREADY_EXISTS"));
      const remote = `https://memory.fake.test/git/talkto-test/${name}.git`;
      repositories.set(name, { remote, objects: new Map(), refs: new Map() });
      return Effect.succeed({ remote });
    }),
  fork: (source, name) =>
    Effect.suspend(() => {
      const from = repositoryOf(source);
      if (from === undefined) return missing("fork");
      if (repositories.has(name)) return Effect.fail(failure("fork", "ALREADY_EXISTS"));
      const remote = `https://memory.fake.test/git/talkto-test/${name}.git`;
      const main = from.refs.get(Git.mainRef);
      repositories.set(name, {
        remote,
        objects: new Map(from.objects),
        refs: new Map(main === undefined ? [] : [[Git.mainRef, main]]),
      });
      return Effect.succeed({ remote });
    }),
  remove: (name) =>
    Effect.suspend(() => {
      if (levers.failRemovals > 0) {
        levers.failRemovals -= 1;
        return Effect.fail(failure("delete", "INTERNAL_ERROR"));
      }
      repositories.delete(name);
      removed.push(name);
      return Effect.void;
    }),
  head: (name) =>
    Effect.suspend(() => {
      if (levers.failHeads > 0) {
        levers.failHeads -= 1;
        return Effect.fail(failure("log", "INTERNAL_ERROR"));
      }
      const repository = repositoryOf(name);
      if (repository === undefined) return missing("log");
      const main = repository.refs.get(Git.mainRef);
      const stored = main === undefined ? undefined : repository.objects.get(main);
      return Effect.succeed(
        main === undefined || stored === undefined ? null : parseCommit(main, stored.body),
      );
    }),
  commit: (name, hash) =>
    Effect.suspend(() => {
      const stored = repositoryOf(name)?.objects.get(hash);
      return Effect.succeed(stored?.type === "commit" ? parseCommit(hash, stored.body) : null);
    }),
  tree: (name, hash) =>
    Effect.suspend(() => {
      const stored = repositoryOf(name)?.objects.get(hash);
      return Effect.succeed(stored?.type === "tree" ? parseTree(stored.body) : null);
    }),
  // Read as the adapter reads it: a v2 fetch reply carrying the one blob, unpacked by Git.readWanted.
  blob: (name, remote, hash) =>
    Effect.gen(function* () {
      const repository = repositoryOf(name);
      if (repository === undefined || repository.remote !== remote)
        return yield* missing("uploadPack");
      const stored = repository.objects.get(hash);
      if (stored?.type !== "blob") return null;
      const reply = yield* wantReply({ type: "blob", body: stored.body, id: hash });
      return yield* Git.readWanted(reply, hash).pipe(
        Effect.mapError(() => failure("uploadPack", "UNREADABLE")),
      );
    }),
  mint: (name, scope, ttl) =>
    Effect.suspend(() => {
      if (!repositories.has(name)) return missing("createToken");
      sequence += 1;
      const token: Token = {
        id: `fake-token-${sequence}`,
        repository: name,
        scope,
        ttl,
        revoked: false,
      };
      tokens.push(token);
      return Effect.succeed({
        id: token.id,
        token: `fake-secret-${sequence}`,
        expiresAt: Date.now() + ttl * 1000,
      });
    }),
  revoke: (_name, tokenId) =>
    Effect.sync(() => {
      const token = tokens.find((item) => item.id === tokenId);
      if (token !== undefined) token.revoked = true;
    }),
  push: (name, remote, body) =>
    Effect.gen(function* () {
      const repository = repositoryOf(name);
      if (repository === undefined || repository.remote !== remote) return yield* missing("push");
      if (levers.failPushes > 0) {
        levers.failPushes -= 1;
        return yield* Effect.fail(failure("receivePack", "HTTP_500"));
      }
      const update = yield* unpack(body);
      const current = repository.refs.get(update.ref) ?? Model.zeroHash;
      keep(repository, update.objects);
      const missingTarget = !repository.objects.has(update.next);
      const report =
        current !== update.old
          ? `unpack ok\nng ${update.ref} fetch first\n`
          : missingTarget
            ? `unpack ok\nng ${update.ref} missing necessary objects\n`
            : `unpack ok\nok ${update.ref}\n`;
      if (report.includes(`ok ${update.ref}`)) repository.refs.set(update.ref, update.next);
      pushes.push({ repository: name, body: base64(body), report });
      return report;
    }),
});

const refuse = () =>
  Promise.reject(new Error("The test Worker reaches memory only through its server object."));
/**
 * A stand-in for the `MEMORY_ARTIFACTS` binding on the test Worker, so the deployment offers
 * memory and lists its tools; every call goes through the server object's fake store instead.
 */
export const binding: Artifacts = {
  create: refuse,
  get: refuse,
  import: refuse,
  list: refuse,
  delete: refuse,
};

/**
 * A stand-in for the real `MEMORY_ARTIFACTS` binding, for memory/artifacts.ts itself, that answers
 * as real Artifacts answered at compatibility date 2026-09-08 where it differs from the generated
 * types: its errors carry no `code`, only a message ("ArtifactsError: repo already exists: …",
 * "Repository not found: …"); an empty repository's log is empty; `readBlob` and `readFile` fail
 * because their Blob cannot cross RPC; a method the runtime lacks is still a function and rejects
 * with "The RPC receiver does not implement the method"; every handle should be disposed. Its
 * `fetch` is the repositories' Git endpoint: receive-pack and a v2 fetch of one wanted object,
 * each needing a live token of the right scope.
 */
export const realistic = (options: { readonly lacking?: ReadonlyArray<string> } = {}) => {
  const repos = new Map<string, Repository>();
  const live = new Map<string, { readonly repository: string; readonly scope: "read" | "write" }>();
  const counts = { gets: 0, disposed: 0, blobReads: 0, results: 0, resultsDisposed: 0 };
  let serial = 0;
  const providerError = (message: string) => new Error(`ArtifactsError: ${message}`);
  const rpcMissing = (method: string) =>
    new TypeError(`The RPC receiver does not implement the method "${method}".`);
  const blobError = () => new TypeError("Cannot serialize value: [object Blob]");
  const lacking = new Set(options.lacking ?? []);
  /** Every object an RPC call returns carries a disposer, as on the real runtime. */
  const disposable = <A>(value: A) => {
    if (!Predicate.isObject(value) || Symbol.dispose in value) return value;
    counts.results += 1;
    Object.defineProperty(value, Symbol.dispose, {
      enumerable: false,
      value: () => {
        counts.resultsDisposed += 1;
      },
    });
    return value;
  };
  const call = <A>(method: string, run: () => A) =>
    lacking.has(method)
      ? Promise.reject(rpcMissing(method))
      : Promise.resolve().then(run).then(disposable);
  const issue = (repository: string, scope: "read" | "write") => {
    serial += 1;
    const plaintext = `art_v1_${"x".repeat(32)}${serial}`;
    live.set(plaintext, { repository, scope });
    return {
      id: `tok-${serial}`,
      plaintext,
      scope,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  };
  const ids = new Map<string, string>();
  const created = (name: string, remote: string): ArtifactsCreateRepoResult => {
    const token = issue(name, "write");
    ids.set(token.id, token.plaintext);
    return {
      id: `repo-${name}`,
      name,
      description: "TalkTo swarm memory",
      defaultBranch: "main",
      remote,
      token: token.plaintext,
      tokenExpiresAt: token.expiresAt,
    };
  };
  const remoteOf = (name: string) =>
    `https://acct.artifacts.cloudflare.net/git/talkto-test/${name}.git`;
  class Handle implements ArtifactsRepo {
    readonly id: string;
    readonly description = "TalkTo swarm memory";
    readonly defaultBranch = "main";
    readonly createdAt = "2026-11-25T00:00:00.000Z";
    readonly updatedAt = "2026-11-25T00:00:00.000Z";
    readonly lastPushAt = null;
    readonly source = null;
    readonly readOnly = false;
    readonly remote: string;
    readonly name: string;
    readonly repository: Repository;
    constructor(name: string, repository: Repository) {
      this.name = name;
      this.repository = repository;
      this.id = `repo-${name}`;
      this.remote = repository.remote;
    }
    createToken(scope: "read" | "write" = "write", _ttl = 3600) {
      return call("createToken", () => {
        const token = issue(this.name, scope);
        ids.set(token.id, token.plaintext);
        return token;
      });
    }
    listTokens() {
      return call("listTokens", () => ({ tokens: [], total: 0 }));
    }
    revokeToken(tokenOrId: string) {
      return call("revokeToken", () => live.delete(ids.get(tokenOrId) ?? tokenOrId));
    }
    fork(name: string) {
      return call("fork", () => {
        if (repos.has(name)) throw providerError(`repo already exists: ${name}`);
        const main = this.repository.refs.get(Git.mainRef);
        const remote = remoteOf(name);
        repos.set(name, {
          remote,
          objects: new Map(this.repository.objects),
          refs: new Map(main === undefined ? [] : [[Git.mainRef, main]]),
        });
        return created(name, remote);
      });
    }
    log(_options: { ref: string; limit?: number }) {
      return call("log", () => {
        const main = this.repository.refs.get(Git.mainRef);
        const stored = main === undefined ? undefined : this.repository.objects.get(main);
        if (main === undefined || stored === undefined) return [];
        const commit = parseCommit(main, stored.body);
        return [
          {
            hash: commit.hash,
            tree: commit.tree,
            parents: commit.parents,
            message: commit.message,
          },
        ];
      });
    }
    readCommit(hash: string) {
      return call("readCommit", () => {
        const stored = this.repository.objects.get(hash);
        if (stored?.type !== "commit") return null;
        const commit = parseCommit(hash, stored.body);
        return { hash, tree: commit.tree, parents: commit.parents, message: commit.message };
      });
    }
    readTree(hash: string) {
      return call("readTree", () => {
        const stored = this.repository.objects.get(hash);
        if (stored?.type !== "tree") return null;
        return parseTree(stored.body).map((entry) => ({
          name: entry.name,
          mode: entry.kind === "tree" ? "040000" : "100644",
          hash: entry.hash,
          type: entry.kind,
        }));
      });
    }
    readBlob(_hash: string) {
      return Promise.reject(blobError());
    }
    readFile(_options: { ref: string; path: string }) {
      return Promise.reject(blobError());
    }
    [Symbol.dispose]() {
      counts.disposed += 1;
    }
  }
  const binding: Artifacts = {
    create: (name) =>
      call("create", () => {
        if (repos.has(name)) throw providerError(`repo already exists: ${name}`);
        const remote = remoteOf(name);
        repos.set(name, { remote, objects: new Map(), refs: new Map() });
        return created(name, remote);
      }),
    get: (name) =>
      call("get", () => {
        const repository = repos.get(name);
        if (repository === undefined) throw providerError(`Repository not found: ${name}.`);
        counts.gets += 1;
        return new Handle(name, repository);
      }),
    import: () => Promise.reject(rpcMissing("import")),
    list: () => call("list", () => ({ repos: [], total: repos.size })),
    delete: (name) => call("delete", () => repos.delete(name) || true),
  };
  /** The Git endpoint of every repository, as `fetch`. */
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const match = /^\/git\/talkto-test\/([^/]+)\.git\/(git-receive-pack|git-upload-pack)$/.exec(
      url.pathname,
    );
    const repository = match?.[1] === undefined ? undefined : repos.get(match[1]);
    if (match === null || repository === undefined)
      return new Response("Not found", { status: 404 });
    const token = live.get((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
    const writing = match[2] === "git-receive-pack";
    if (
      token === undefined ||
      token.repository !== match[1] ||
      (writing && token.scope !== "write")
    )
      return new Response("Unauthorized", { status: 401 });
    const body = new Uint8Array(await request.arrayBuffer());
    if (writing) {
      const update = await Effect.runPromise(unpack(body));
      const current = repository.refs.get(update.ref) ?? Model.zeroHash;
      keep(repository, update.objects);
      const ok = current === update.old && repository.objects.has(update.next);
      if (ok) repository.refs.set(update.ref, update.next);
      const status = ok ? `ok ${update.ref}\n` : `ng ${update.ref} stale ref\n`;
      return new Response(
        join([
          pkt(encoder.encode("unpack ok\n")),
          pkt(encoder.encode(status)),
          encoder.encode("0000"),
        ]),
      );
    }
    if (request.headers.get("git-protocol") !== "version=2")
      return new Response("v2 only", { status: 400 });
    const want = /want ([0-9a-f]{40})/.exec(decoder.decode(body))?.[1] ?? "";
    const stored = repository.objects.get(want);
    if (stored === undefined) return new Response("Internal Server Error", { status: 500 });
    counts.blobReads += 1;
    return new Response(
      await Effect.runPromise(wantReply({ type: stored.type, body: stored.body, id: want })),
    );
  };
  return { binding, fetch, counts, live, repositories: repos };
};

/** What an agent does with real Git, applied to the fake repository of `name`. */
export const control = Effect.fn("MemoryFake.control")(function* (
  name: string,
  input: {
    readonly action: "commit" | "force" | "delete-main" | "branch" | "inspect" | "levers" | "drop";
    readonly files?: Readonly<Record<string, string | null>>;
    readonly message?: string;
    readonly branch?: string;
    /** Commit on top of this commit instead of main (a stale clone). */
    readonly parent?: string;
    readonly failPushes?: number;
    readonly failHeads?: number;
    readonly failRemovals?: number;
    /** `drop`: forget this object, as a store's garbage collection would. */
    readonly hash?: string;
  },
) {
  const repository = repositoryOf(name);
  if (input.action === "levers") {
    levers.failPushes = input.failPushes ?? levers.failPushes;
    levers.failHeads = input.failHeads ?? levers.failHeads;
    levers.failRemovals = input.failRemovals ?? levers.failRemovals;
    return { ok: true };
  }
  if (input.action === "inspect")
    return {
      exists: repository !== undefined,
      remote: repository?.remote ?? null,
      refs: repository === undefined ? {} : Object.fromEntries(repository.refs),
      files:
        repository === undefined
          ? {}
          : Object.fromEntries(filesOf(repository, repository.refs.get(Git.mainRef))),
      tokens: tokens.filter((token) => token.repository === name),
      pushes: pushes.filter((push) => push.repository === name),
      removed: removed.includes(name),
    };
  if (repository === undefined) return { error: "no repository" };
  if (input.action === "drop") {
    if (input.hash !== undefined) repository.objects.delete(input.hash);
    return { ok: true };
  }
  if (input.action === "delete-main") {
    repository.refs.delete(Git.mainRef);
    return { ok: true };
  }
  const ref = input.action === "branch" ? `refs/heads/${input.branch ?? "side"}` : Git.mainRef;
  // A plain push from a stale clone is refused as Git refuses it: pull, rebase and push again.
  if (
    input.action === "commit" &&
    input.parent !== undefined &&
    input.parent !== repository.refs.get(Git.mainRef)
  )
    return { rejected: "non-fast-forward" };
  const parent =
    input.action === "force" ? undefined : (input.parent ?? repository.refs.get(Git.mainRef));
  const files = input.action === "force" ? new Map<string, string>() : filesOf(repository, parent);
  for (const [path, text] of Object.entries(input.files ?? {}))
    if (text === null) files.delete(path);
    else files.set(path, text);
  const built = yield* Git.tree([...files].map(([path, text]) => ({ path, text })));
  if (built.root === null) return { error: "empty tree" };
  const made = yield* Git.commit({
    tree: built.root,
    parents: parent === undefined ? [] : [parent],
    message: input.message ?? "Update memory",
    at: Date.now(),
  });
  keep(repository, [...built.objects, made]);
  repository.refs.set(ref, made.id);
  return { hash: made.id };
});
