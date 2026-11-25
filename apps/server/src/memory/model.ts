import { Context, Effect, Schema } from "effect";
import * as M from "@talkto/api/models";

/**
 * Swarm memory's Git store (docs/swarm-server-spec.md, 14): one repository per swarm server,
 * `mem-<serverId>`, in the deployment's Artifacts namespace. This port is all TalkTo knows of it;
 * the Artifacts binding stays in `artifacts.ts`, and tests bind a fake.
 */

/** A Git object ID: 40 lowercase hex digits. */
export const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
/** The ID every Git client sends as the old value of a ref it creates. */
export const zeroHash = "0".repeat(40);
/** One commit as the store reports it: what head detection and the channel need. */
export const Commit = Schema.Struct({
  hash: Hash,
  tree: Hash,
  parents: Schema.Array(Hash),
  message: Schema.String,
});
export interface Commit extends Schema.Schema.Type<typeof Commit> {}
/** One entry of a tree: a file (`blob`), a folder (`tree`), or something TalkTo skips. */
export interface TreeEntry {
  readonly name: string;
  readonly hash: string;
  readonly kind: "blob" | "tree" | "other";
}
/** A repository as create or fork returned it: its remote, never a token. */
export interface Created {
  readonly remote: string;
}
/** One Git token the store minted; `token` is shown once to the agent and never stored. */
export interface Credential {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: number;
}
/** Token lifetime in whole seconds, inside the range Artifacts accepts. */
export const TtlSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 60, maximum: 31_536_000 }),
).pipe(Schema.brand("MemoryTtlSeconds"));
export type TtlSeconds = typeof TtlSeconds.Type;

/** This deployment binds no Git store for memory: memory is absent, not broken. */
export class MemoryStoreUnavailable extends Schema.TaggedError<MemoryStoreUnavailable>()(
  "MemoryStoreUnavailable",
  { message: Schema.String },
) {}
/**
 * The store rejected or could not complete an operation. `code` is the provider's fixed word, such
 * as `ALREADY_EXISTS`, `NOT_FOUND` or `UNSUPPORTED`; `status` an HTTP status from the Git remote;
 * `detail` the provider's own message, cut to safe characters with anything token-like removed
 * (`safeDetail`). Never a token or a URL with credentials. Reported, never shown to callers.
 */
export class MemoryStoreFailure extends Schema.TaggedError<MemoryStoreFailure>()(
  "MemoryStoreFailure",
  {
    message: Schema.String,
    operation: Schema.String,
    code: Schema.NullOr(Schema.String),
    status: Schema.optionalKey(Schema.Int),
    detail: Schema.optionalKey(Schema.String),
  },
) {}
/**
 * A provider message made safe to report: bearer values and every run of 20 or more letters,
 * digits or token punctuation (tokens, hashes, IDs) become `<redacted>`, other characters outside
 * letters, digits and `_.: -` become spaces, and it is cut to 120 characters.
 */
export const safeDetail = (text: string) =>
  text
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/[A-Za-z0-9_~+/=-]{20,}/g, "<redacted>")
    .replace(/[^A-Za-z0-9_.: <>-]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
export type Failure = MemoryStoreUnavailable | MemoryStoreFailure;

/** The repository name for a server's memory. */
export const repositoryName = (serverId: M.ServerId) => `mem-${serverId}`;

/** Application-owned port for memory repositories. */
export class Repositories extends Context.Service<
  Repositories,
  {
    /** False where no store is bound: every operation then fails with `MemoryStoreUnavailable`. */
    readonly available: boolean;
    /** Create an empty repository on `main`; its initial token is revoked before this returns. */
    readonly create: (name: string) => Effect.Effect<Created, Failure>;
    /** Fork `source` into `name`, main only, with its history. */
    readonly fork: (source: string, name: string) => Effect.Effect<Created, Failure>;
    /** Delete a repository; an absent one is already deleted. */
    readonly remove: (name: string) => Effect.Effect<void, Failure>;
    /** The commit main points at, or null when main is missing (empty or deleted). */
    readonly head: (name: string) => Effect.Effect<Commit | null, Failure>;
    readonly commit: (name: string, hash: string) => Effect.Effect<Commit | null, Failure>;
    readonly tree: (
      name: string,
      hash: string,
    ) => Effect.Effect<ReadonlyArray<TreeEntry> | null, Failure>;
    /**
     * One blob's bytes by its ID, read over Git from `remote`, or null when it is not there. The
     * binding's `readBlob` and `readFile` return a Blob, which cannot cross RPC at compatibility
     * date 2026-09-08, so TalkTo fetches the object itself.
     */
    readonly blob: (
      name: string,
      remote: string,
      hash: string,
    ) => Effect.Effect<Uint8Array | null, Failure>;
    readonly mint: (
      name: string,
      scope: "read" | "write",
      ttl: TtlSeconds,
    ) => Effect.Effect<Credential, Failure>;
    /** Revoke a token by its ID; an unknown one is already revoked. */
    readonly revoke: (name: string, tokenId: string) => Effect.Effect<void, Failure>;
    /**
     * Send one receive-pack request (a ref update and its pack) as TalkTo itself, with a token
     * that lives only for this call, and return the server's report-status text.
     */
    readonly push: (
      name: string,
      remote: string,
      body: Uint8Array,
    ) => Effect.Effect<string, Failure>;
  }
>()("@talkto/memory/Repositories") {}

const absent = () =>
  Effect.fail(
    new MemoryStoreUnavailable({ message: "Swarm memory is not available on this deployment." }),
  );
/** Any Worker without a memory binding: memory is cleanly unavailable. */
export const unavailable = Repositories.of({
  available: false,
  create: absent,
  fork: absent,
  remove: absent,
  head: absent,
  commit: absent,
  tree: absent,
  blob: absent,
  mint: absent,
  revoke: absent,
  push: absent,
});
