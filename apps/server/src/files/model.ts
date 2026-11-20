import { Context, Effect, Schema } from "effect";
import * as M from "@talkto/api/models";

/**
 * An absolute `https:` or `file:` URL. Provider handles can carry non-data fields (an RPC stub's
 * `remote` stringifies as `[object JsRpcProperty]`), so a remote is parsed before it is recorded
 * or served, and a recorded row that fails this check is read as missing.
 */
const Remote = Schema.String.check(
  Schema.makeFilter((s) => URL.canParse(s) && ["https:", "file:"].includes(new URL(s).protocol), {
    title: "AbsoluteGitRemote",
  }),
);
/** Git remote agents clone and push; the store keeps no other state. */
export const Repository = Schema.Struct({ remote: Remote, defaultBranch: Schema.NonEmptyString });
export interface Repository extends Schema.Schema.Type<typeof Repository> {}
/** Repository-scoped access level. */
export const Scope = Schema.Literals(["read", "write"]);
export type Scope = typeof Scope.Type;
/** Token lifetime in whole seconds, inside the range every provider accepts. */
export const TtlSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 60, maximum: 31_536_000 }),
).pipe(Schema.brand("TtlSeconds"));
export type TtlSeconds = typeof TtlSeconds.Type;
/** One minted access; `token` is null where the remote itself is the access (local). */
export const Credential = Schema.Struct({
  id: Schema.String,
  token: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(M.Timestamp),
});
export interface Credential extends Schema.Schema.Type<typeof Credential> {}
/** One recorded access grant; `tokenId` is the store's handle for revocation, never the plaintext. */
export const TokenRecord = Schema.Struct({
  id: Schema.String,
  tokenId: Schema.String,
  participantId: M.ParticipantId,
  grantId: M.GrantId,
  scope: Scope,
  issuedAt: M.Timestamp,
  expiresAt: Schema.NullOr(M.Timestamp),
  revokedAt: Schema.NullOr(M.Timestamp),
});
export interface TokenRecord extends Schema.Schema.Type<typeof TokenRecord> {}
/** This deployment has no file store; the capability is absent rather than broken. */
export class FileStoreUnavailable extends Schema.TaggedError<FileStoreUnavailable>()(
  "FileStoreUnavailable",
  { message: Schema.String },
) {}
/** The configured file store rejected or could not complete an operation. Never carries a token. */
export class FileStoreFailure extends Schema.TaggedError<FileStoreFailure>()("FileStoreFailure", {
  message: Schema.String,
  operation: Schema.String,
  provider: Schema.String,
  code: Schema.NullOr(Schema.String),
}) {}
export type Failure = FileStoreUnavailable | FileStoreFailure;
/** What a provider claims about a repository: typed as strings, not yet known to be a remote. */
export interface ReportedRepository {
  readonly remote: string;
  readonly defaultBranch: string;
}
/**
 * Parse what a provider reports as the repository before anything records or serves it. A
 * report that is not a plain absolute remote and a non-empty branch is a store failure, never
 * a row; the failure names the operation and provider and carries no field values.
 */
export const parseRepository =
  (provider: string, operation: string) => (reported: ReportedRepository) =>
    Schema.decodeUnknownEffect(Repository)(reported).pipe(
      Effect.mapError(
        () =>
          new FileStoreFailure({
            message: "The file store reported an unreadable repository.",
            operation,
            provider,
            code: null,
          }),
      ),
    );
/** Application-owned port for per-server Git repositories and their access tokens. */
export class FileStore extends Context.Service<
  FileStore,
  {
    /**
     * The repository for this server, created when absent. `recorded` is the row the ledger
     * holds, or null before any access or view recorded one; a store whose remote is
     * deterministic may answer from a valid row without reaching its provider, while a store
     * whose remote can move must ignore it.
     */
    readonly ensure: (
      serverId: M.ServerId,
      recorded: Repository | null,
    ) => Effect.Effect<Repository, Failure>;
    readonly mint: (
      serverId: M.ServerId,
      scope: Scope,
      ttlSeconds: TtlSeconds,
    ) => Effect.Effect<Credential, Failure>;
    readonly revoke: (serverId: M.ServerId, tokenId: string) => Effect.Effect<void, Failure>;
    readonly remove: (serverId: M.ServerId) => Effect.Effect<void, Failure>;
  }
>()("@talkto/files/FileStore") {}
const absent = () =>
  Effect.fail(
    new FileStoreUnavailable({ message: "File sharing is not available on this deployment." }),
  );
/** Tests and any Worker without a binding or local remote; every operation fails the same way. */
export const unavailable = FileStore.of({
  ensure: absent,
  mint: absent,
  revoke: absent,
  remove: absent,
});
