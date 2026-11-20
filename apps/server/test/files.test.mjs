import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Predicate, Schema } from "effect";
import { load } from "./sources.mjs";

const Model = await load("../src/files/model.ts");
const Local = await load("../src/files/local.ts");
const Fake = await load("./files-fake.ts");
const Bindings = await load("../src/files/bindings.ts");
const { capabilities } = await load("../src/capabilities.ts");
const { procedure } = await load("../src/files/procedure.ts");
const Models = await load("../../../packages/api/src/models.ts");

const serverId = "0b6f4f3e-2f4a-4d47-9b3e-6a1c2d9e8f70";
const ttl = Model.TtlSeconds.make(3600);
const run = (effect) => Effect.runPromise(effect.pipe(Effect.result));
const failed = (result, tag) => {
  assert.equal(result._tag, "Failure", JSON.stringify(result));
  assert.equal(result.failure._tag, tag);
  return result.failure;
};
const succeeded = (result) => {
  assert.equal(result._tag, "Success", JSON.stringify(result));
  return result.success;
};

test("the local store returns the configured remote and no token", async () => {
  const store = Local.make("file:///tmp/files.git");
  assert.deepEqual(succeeded(await run(store.ensure(serverId, null))), {
    remote: "file:///tmp/files.git",
    defaultBranch: "main",
  });
  assert.deepEqual(succeeded(await run(store.mint(serverId, "write", ttl))), {
    id: "local",
    token: null,
    expiresAt: null,
  });
  succeeded(await run(store.revoke(serverId, "local")));
  succeeded(await run(store.remove(serverId)));
});

test("the unavailable store fails every operation the same way", async () => {
  const store = Model.unavailable;
  for (const operation of [
    store.ensure(serverId, null),
    store.mint(serverId, "read", ttl),
    store.revoke(serverId, "t"),
    store.remove(serverId),
  ])
    failed(await run(operation), "FileStoreUnavailable");
});

test("the fake records repositories, sequential tokens and revocations", async () => {
  const { store, recorded } = Fake.make(() => "2026-09-15T12:00:00.000Z");
  failed(await run(store.mint(serverId, "write", ttl)), "FileStoreFailure");
  assert.deepEqual(succeeded(await run(store.ensure(serverId, null))), {
    remote: `https://fake.artifacts.test/git/test/srv-${serverId}.git`,
    defaultBranch: "main",
  });
  assert.deepEqual(succeeded(await run(store.mint(serverId, "write", ttl))), {
    id: "fake_1",
    token: "fake_1",
    expiresAt: "2026-09-15T13:00:00.000Z",
  });
  assert.equal(succeeded(await run(store.mint(serverId, "read", ttl))).id, "fake_2");
  succeeded(await run(store.revoke(serverId, "fake_1")));
  succeeded(await run(store.remove(serverId)));
  failed(await run(store.mint(serverId, "read", ttl)), "FileStoreFailure");
  assert.deepEqual(recorded(), {
    ensured: [serverId],
    hinted: [null],
    minted: [
      { serverId, id: "fake_1", scope: "write", ttlSeconds: 3600 },
      { serverId, id: "fake_2", scope: "read", ttlSeconds: 3600 },
    ],
    revoked: [{ serverId, tokenId: "fake_1" }],
    removed: [serverId],
  });
});

test("share references reject paths that leave the repository and refs Git would refuse", () => {
  const accepts = (schema, value) => Schema.decodeUnknownResult(schema)(value)._tag === "Success";
  for (const path of ["a.md", "specs/billing-rewrite/api.md", "ünïcode/файл.txt", "x".repeat(1024)])
    assert.ok(accepts(Models.RepositoryPath, path), path);
  for (const path of [
    "",
    "/abs",
    "../x",
    "a/../b",
    "a/./b",
    "a//b",
    "a/",
    "a\\b",
    "a\0b",
    "x".repeat(1025),
  ])
    assert.ok(!accepts(Models.RepositoryPath, path), JSON.stringify(path));
  assert.ok(accepts(Models.CommitHash, "9f3c2ab4d1e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0"));
  assert.ok(!accepts(Models.CommitHash, "9F3C2AB4D1E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0"));
  assert.ok(!accepts(Models.CommitHash, "9f3c2ab"));
  for (const ref of ["main", "share/agent/topic", "v1.2.3", "feature-x"])
    assert.ok(accepts(Models.RefName, ref), ref);
  for (const ref of [
    "",
    "a..b",
    ".hidden",
    "a/",
    "/a",
    "a.lock",
    "a b",
    "a~b",
    "a^b",
    "a:b",
    "a?b",
    "a*b",
    "a[b",
    "a\\b",
    "@",
    "a@{b",
    `a${String.fromCodePoint(1)}b`,
    "x".repeat(257),
  ])
    assert.ok(!accepts(Models.RefName, ref), JSON.stringify(ref));
});

test("the procedure interpolates the remote and token and drops the header without one", () => {
  const repository = {
    remote: "https://acct.artifacts.cloudflare.net/git/ns/srv-1.git",
    defaultBranch: "main",
  };
  const write = procedure(repository, "write", "art_v1_secret");
  assert.equal(write.split("\n").length, 4);
  assert.match(
    write,
    /^git -c http\.extraHeader="Authorization: Bearer art_v1_secret" clone https:\/\/acct\.artifacts\.cloudflare\.net\/git\/ns\/srv-1\.git talkto-files\n/,
  );
  assert.match(write, /push origin main$/);
  assert.match(write, /commit -m "<why this file exists>"/);
  const read = procedure(repository, "read", "art_v1_secret");
  assert.equal(read.split("\n").length, 2);
  assert.match(read, /show <commit>:<path>$/);
  const local = procedure(
    { remote: "file:///tmp/files.git", defaultBranch: "main" },
    "write",
    null,
  );
  assert.doesNotMatch(local, /Authorization/);
  assert.match(local, /^git clone file:\/\/\/tmp\/files\.git talkto-files\n/);
});

test("capabilities follow the bound environment", () => {
  assert.deepEqual([...capabilities({})], []);
  assert.deepEqual([...capabilities({ TALKTO_FILES_REMOTE: "file:///tmp/files.git" })], ["files"]);
  assert.deepEqual([...capabilities({ ARTIFACTS: {} })], ["files"]);
  // An empty remote is unset: the capability and the store agree that files are absent.
  assert.deepEqual([...capabilities({ TALKTO_FILES_REMOTE: "" })], []);
});

test("composition selects the store from the environment", async () => {
  const none = succeeded(await run(Bindings.configure({})));
  failed(await run(none.ensure(serverId, null)), "FileStoreUnavailable");
  const empty = succeeded(await run(Bindings.configure({ TALKTO_FILES_REMOTE: "" })));
  failed(await run(empty.ensure(serverId, null)), "FileStoreUnavailable");
  const local = succeeded(
    await run(Bindings.configure({ TALKTO_FILES_REMOTE: "file:///tmp/files.git" })),
  );
  assert.equal(succeeded(await run(local.ensure(serverId, null))).remote, "file:///tmp/files.git");
  failed(
    await run(Bindings.configure({ TALKTO_FILES_REMOTE: "https://example.com/repo.git" })),
    "ConfigurationUnavailable",
  );
});

/** An `ArtifactsError` whose `name` and `code` are prototype getters rather than own properties. */
class PrototypeArtifactsError extends Error {
  get name() {
    return "ArtifactsError";
  }
  get code() {
    return this.message;
  }
}
const remoteBase = "https://acct.artifacts.cloudflare.net/git/talkto-test";
const artifactsEnv = (artifacts) => ({
  ARTIFACTS: artifacts,
  TALKTO_ARTIFACTS_REMOTE_BASE: remoteBase,
});
/**
 * What the real `get` handle exposes for an info field: an RPC property stub, not data. Awaiting
 * it fails, structured clone rejects it, and SQLite stringifies it to "[object JsRpcProperty]".
 */
const rpcProperty = () => ({ toString: () => "[object JsRpcProperty]" });
/** Minimal stand-in for the Artifacts binding, exercising the store's translation only. */
const binding = (options = {}) => {
  const repositories = new Map();
  const calls = [];
  const reject = (code) =>
    options.prototypeErrors
      ? new PrototypeArtifactsError(code)
      : Object.assign(new Error(code), { name: "ArtifactsError", code, numericCode: 0 });
  const handle = (name) => {
    const repository = repositories.get(name);
    if (repository === undefined) throw reject("NOT_FOUND");
    return {
      id: rpcProperty(),
      name: rpcProperty(),
      remote: rpcProperty(),
      defaultBranch: rpcProperty(),
      createToken: async (scope, ttl) => {
        calls.push(["createToken", name, scope, ttl]);
        const id = `tok_${repository.tokens.size + 1}`;
        repository.tokens.set(id, `plain_${id}`);
        return { id, plaintext: `plain_${id}`, scope, expiresAt: "2026-09-15T13:00:00Z" };
      },
      revokeToken: async (tokenOrId) => {
        calls.push(["revokeToken", name, tokenOrId]);
        for (const [id, plaintext] of repository.tokens)
          if (id === tokenOrId || plaintext === tokenOrId) return repository.tokens.delete(id);
        return false;
      },
    };
  };
  return {
    calls,
    repositories,
    create: async (name, opts) => {
      calls.push(["create", name, opts]);
      if (options.createFailure !== undefined) throw reject(options.createFailure);
      if (repositories.has(name)) throw reject("ALREADY_EXISTS");
      const tokens = new Map([["tok_initial", "plain_initial"]]);
      const remote = options.createdRemote ?? `${remoteBase}/${name}.git`;
      repositories.set(name, { name, remote, defaultBranch: opts.setDefaultBranch, tokens });
      // Creation alone answers with plain data.
      return {
        id: `repo_${repositories.size}`,
        name,
        description: null,
        defaultBranch: opts.setDefaultBranch,
        remote,
        token: "plain_initial",
        tokenExpiresAt: "2026-09-16T12:00:00Z",
      };
    },
    get: async (name) => {
      calls.push(["get", name]);
      return handle(name);
    },
    delete: async (name) => {
      calls.push(["delete", name]);
      return repositories.delete(name);
    },
  };
};

test("the artifacts store creates once, revokes the initial token and tolerates absence", async () => {
  const artifacts = binding();
  const store = succeeded(await run(Bindings.configure(artifactsEnv(artifacts))));
  const repository = succeeded(await run(store.ensure(serverId, null)));
  assert.deepEqual(repository, {
    remote: `https://acct.artifacts.cloudflare.net/git/talkto-test/srv-${serverId}.git`,
    defaultBranch: "main",
  });
  assert.deepEqual([...artifacts.repositories.get(`srv-${serverId}`).tokens.keys()], []);
  assert.deepEqual(succeeded(await run(store.ensure(serverId, null))), repository);
  const credential = succeeded(await run(store.mint(serverId, "read", ttl)));
  assert.deepEqual(credential, {
    id: "tok_1",
    token: "plain_tok_1",
    expiresAt: "2026-09-15T13:00:00.000Z",
  });
  succeeded(await run(store.revoke(serverId, "tok_1")));
  succeeded(await run(store.revoke(serverId, "tok_missing")));
  succeeded(await run(store.remove(serverId)));
  succeeded(await run(store.remove(serverId)));
  const missing = failed(await run(store.mint(serverId, "write", ttl)), "FileStoreFailure");
  assert.equal(missing.code, "NOT_FOUND");
  assert.equal(missing.operation, "get");
  assert.deepEqual(
    artifacts.calls.map((call) => call[0]),
    [
      "create",
      "get",
      "revokeToken",
      "create",
      "get",
      "get",
      "createToken",
      "get",
      "revokeToken",
      "get",
      "revokeToken",
      "delete",
      "delete",
      "get",
    ],
  );
});

test("the artifacts store settles a creation failure by reading the existing repository, whatever shape the rejection has", async () => {
  // The repository exists (created by an earlier request whose row was never recorded) and the
  // runtime reports ALREADY_EXISTS through prototype getters that own-property decoding misses.
  const artifacts = binding({ prototypeErrors: true });
  await artifacts.create(`srv-${serverId}`, { setDefaultBranch: "main" });
  const store = succeeded(await run(Bindings.configure(artifactsEnv(artifacts))));
  assert.deepEqual(succeeded(await run(store.ensure(serverId, null))), {
    remote: `https://acct.artifacts.cloudflare.net/git/talkto-test/srv-${serverId}.git`,
    defaultBranch: "main",
  });
  assert.deepEqual(
    artifacts.calls.map((call) => call[0]),
    ["create", "create", "get"],
  );
  // The code is still read for telemetry from wherever the runtime keeps it.
  const bare = succeeded(
    await run(Bindings.configure(artifactsEnv(binding({ prototypeErrors: true })))),
  );
  const missing = failed(await run(bare.mint(serverId, "read", ttl)), "FileStoreFailure");
  assert.equal(missing.code, "NOT_FOUND");
  // Without a repository, the creation failure itself is what surfaces.
  const failing = succeeded(
    await run(Bindings.configure(artifactsEnv(binding({ createFailure: "QUOTA_EXCEEDED" })))),
  );
  const creation = failed(await run(failing.ensure(serverId, null)), "FileStoreFailure");
  assert.equal(creation.operation, "create");
  assert.equal(creation.code, "QUOTA_EXCEEDED");
});

test("the artifacts store never serves a handle's info fields: the remote is derived from configuration", async () => {
  const derived = `${remoteBase}/srv-${serverId}.git`;
  const isData = (repository) => {
    assert.ok(Predicate.isString(repository.remote));
    assert.ok(Predicate.isString(repository.defaultBranch));
    assert.doesNotMatch(String(repository.remote), /JsRpcProperty/);
    assert.equal(JSON.stringify(repository), JSON.stringify({ ...repository }));
  };
  // ALREADY_EXISTS: the handle only confirms existence; nothing is read from it.
  const artifacts = binding();
  await artifacts.create(`srv-${serverId}`, { setDefaultBranch: "main" });
  const store = succeeded(await run(Bindings.configure(artifactsEnv(artifacts))));
  const existing = succeeded(await run(store.ensure(serverId, null)));
  isData(existing);
  assert.deepEqual(existing, { remote: derived, defaultBranch: "main" });
  assert.deepEqual(
    artifacts.calls.map((call) => call[0]),
    ["create", "create", "get"],
  );
  // A valid recorded row answers without any provider call.
  const recorded = { remote: derived, defaultBranch: "main" };
  assert.deepEqual(succeeded(await run(store.ensure(serverId, recorded))), recorded);
  assert.equal(artifacts.calls.length, 3);
  // Creation answers with the provider's plain data; a drift from the derived remote is logged, not failed.
  const drifted = binding({ createdRemote: `${remoteBase}-other/srv-${serverId}.git` });
  const other = succeeded(await run(Bindings.configure(artifactsEnv(drifted))));
  const created = succeeded(await run(other.ensure(serverId, null)));
  isData(created);
  assert.equal(created.remote, `${remoteBase}-other/srv-${serverId}.git`);
  // Creation data that is not a plain absolute remote is a store failure, never a row.
  const broken = binding({ createdRemote: "[object JsRpcProperty]" });
  const unreadable = succeeded(await run(Bindings.configure(artifactsEnv(broken))));
  const failure = failed(await run(unreadable.ensure(serverId, null)), "FileStoreFailure");
  assert.equal(failure.operation, "create");
  assert.equal(failure.code, null);
  assert.doesNotMatch(failure.message, /JsRpcProperty/);
});

test("the artifacts store requires the remote base beside the binding", async () => {
  failed(await run(Bindings.configure({ ARTIFACTS: binding() })), "ConfigurationUnavailable");
  for (const value of ["", `${remoteBase}/`, "http://acct.artifacts.cloudflare.net/git/ns", "acct"])
    failed(
      await run(Bindings.configure({ ARTIFACTS: binding(), TALKTO_ARTIFACTS_REMOTE_BASE: value })),
      "ConfigurationUnavailable",
    );
});

test("a recorded repository must be an absolute https or file remote with a branch", () => {
  const accepts = (value) => Schema.decodeUnknownResult(Model.Repository)(value)._tag === "Success";
  assert.ok(accepts({ remote: `${remoteBase}/srv-1.git`, defaultBranch: "main" }));
  assert.ok(accepts({ remote: "file:///tmp/files.git", defaultBranch: "main" }));
  for (const remote of [
    "[object JsRpcProperty]",
    "",
    "srv-1.git",
    "http://x/srv-1.git",
    rpcProperty(),
  ])
    assert.ok(!accepts({ remote, defaultBranch: "main" }), String(remote));
  assert.ok(!accepts({ remote: `${remoteBase}/srv-1.git`, defaultBranch: "" }));
});

test("the fake relocates its remote and fails the revocations it is told to", async () => {
  const { store, recorded, control } = Fake.make(() => "2026-09-15T12:00:00.000Z");
  succeeded(await run(store.ensure(serverId, null)));
  control({ remote: "https://fake.artifacts.test/git/test/moved.git" });
  assert.equal(
    succeeded(await run(store.ensure(serverId, null))).remote,
    "https://fake.artifacts.test/git/test/moved.git",
  );
  control({ remote: null });
  assert.equal(
    succeeded(await run(store.ensure(serverId, null))).remote,
    `https://fake.artifacts.test/git/test/srv-${serverId}.git`,
  );
  control({ failRevocations: 1 });
  const outage = failed(await run(store.revoke(serverId, "fake_1")), "FileStoreFailure");
  assert.equal(outage.code, "INTERNAL_ERROR");
  succeeded(await run(store.revoke(serverId, "fake_1")));
  assert.deepEqual(recorded().revoked, [{ serverId, tokenId: "fake_1" }]);
});
