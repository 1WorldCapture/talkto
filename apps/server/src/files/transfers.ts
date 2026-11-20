import { Context, Effect, Schema } from "effect";
import * as M from "@talkto/api/models";
import * as Model from "./model.js";

/** How long an offer stays fetchable. The bucket's `r30/` lifecycle rule deletes the bytes after it. */
export const retentionSeconds = 30 * 24 * 60 * 60;
/** How long one upload or download link stays usable. A transfer already running may finish. */
export const linkSeconds = 60 * 60;
/** How long a person's dashboard download link stays usable; the browser starts it at once. */
export const personLinkSeconds = 5 * 60;

/** How one download link is signed; agents' links keep the defaults. */
export interface DownloadOptions {
  /** Link lifetime; `linkSeconds` when absent. */
  readonly seconds?: number;
  /** The name the browser saves the attachment under; the object key's name when absent. */
  readonly fileName?: string;
}
/** The name a person's download is saved under: a folder is the tar.gz archive its sender packed. */
export const downloadName = (record: Pick<TransferRecord, "name" | "kind">) =>
  record.kind === "folder" && !/\.(?:tgz|tar\.gz)$/i.test(record.name)
    ? `${record.name}.tar.gz`
    : record.name;
/**
 * `Content-Disposition` for a download saved as `fileName`. The sender's name is untrusted, so
 * it is sent only percent-encoded (RFC 6266 and RFC 8187): nothing in it can end the header
 * value or add a parameter, and the value has no spaces for any query-string encoding to change.
 */
export const attachment = (fileName: string) =>
  `attachment;filename*=UTF-8''${encodeURIComponent(fileName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )}`;

/** The object holding the file or the packed folder. */
export const payloadKey = (serverId: M.ServerId, id: M.TransferId) =>
  `${serverPrefix(serverId)}${id}/payload`;
/** The object holding a folder's plain-text file list. */
export const manifestKey = (serverId: M.ServerId, id: M.TransferId) =>
  `${serverPrefix(serverId)}${id}/manifest`;
/** Every object a server owns, so deleting the server can remove them all. */
export const serverPrefix = (serverId: M.ServerId) => `r30/${serverId}/`;

/** One reservation or offer, as the ledger records it. */
export const TransferRecord = Schema.Struct({
  id: M.TransferId,
  senderId: M.ParticipantId,
  grantId: M.GrantId,
  requestKey: M.RequestKey,
  name: M.TransferName,
  kind: M.TransferKind,
  bytes: M.TransferBytes,
  sha256: M.Sha256,
  fileCount: Schema.NullOr(M.Count),
  manifestBytes: Schema.NullOr(Schema.Int),
  createdAt: M.Timestamp,
  uploadExpiresAt: M.Timestamp,
  expiresAt: M.Timestamp,
  messageId: Schema.NullOr(M.MessageId),
  /** `pending` until the organization's storage pool confirms the space; no link is signed before. */
  poolState: Schema.Literals(["pending", "reserved"]),
});
export interface TransferRecord extends Schema.Schema.Type<typeof TransferRecord> {}
/** One ledger row as a listing reads it, with the conversation of its offer message if kept. */
export const TransferEntry = Schema.Struct({
  id: M.TransferId,
  name: M.TransferName,
  kind: M.TransferKind,
  bytes: M.TransferBytes,
  fileCount: Schema.NullOr(M.Count),
  senderId: M.ParticipantId,
  messageId: Schema.NullOr(M.MessageId),
  conversationId: Schema.NullOr(M.ConversationId),
  messageSequence: Schema.NullOr(M.Count),
  createdAt: M.Timestamp,
  expiresAt: M.Timestamp,
});
export interface TransferEntry extends Schema.Schema.Type<typeof TransferEntry> {}
/**
 * Where a listing page ends. Listings run newest first by expiry, which is creation plus the
 * fixed retention, so the existing expiry index orders them without a new one.
 */
export const TransferPosition = Schema.Struct({ expiresAt: M.Timestamp, id: M.TransferId });
export interface TransferPosition extends Schema.Schema.Type<typeof TransferPosition> {}

/** Application-owned port for transfer objects. Nothing here carries file bytes through TalkTo. */
export class TransferStore extends Context.Service<
  TransferStore,
  {
    /** A link that writes exactly `bytes` to `key`, once. */
    readonly uploadUrl: (key: string, bytes: number) => Effect.Effect<string, Model.Failure>;
    /** A link that reads `key` as an attachment. */
    readonly downloadUrl: (
      key: string,
      options?: DownloadOptions,
    ) => Effect.Effect<string, Model.Failure>;
    /** The stored size of `key`, or null when nothing was uploaded. */
    readonly size: (key: string) => Effect.Effect<number | null, Model.Failure>;
    readonly remove: (keys: ReadonlyArray<string>) => Effect.Effect<void, Model.Failure>;
    readonly removePrefix: (prefix: string) => Effect.Effect<void, Model.Failure>;
  }
>()("@talkto/files/TransferStore") {}
const absent = () =>
  Effect.fail(
    new Model.FileStoreUnavailable({
      message: "File transfer is not available on this deployment.",
    }),
  );
/** Any Worker without a configured bucket; every operation fails the same way. */
export const unavailable = TransferStore.of({
  uploadUrl: absent,
  downloadUrl: absent,
  size: absent,
  remove: absent,
  removePrefix: absent,
});
