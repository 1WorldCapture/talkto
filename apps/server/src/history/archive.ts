import { Context, Effect, Schema } from "effect";
import * as M from "@talkto/api/models";

/**
 * Factory history archive layout. Each server's archived messages live in the transfer bucket
 * under `archive/<serverId>/`, outside the `r30/` prefix whose lifecycle rule expires transfers,
 * so they stay until the server is deleted or the organization leaves Factory. One object holds
 * one prune batch as JSON Lines (one message per line, oldest first); its name is the batch's
 * first and last sequence, zero-padded, so listing returns objects in history order.
 */
export const serverPrefix = (serverId: M.ServerId) => `archive/${serverId}/`;
const pad = (n: number) => String(n).padStart(16, "0");
/** The object holding messages `from` through `through`. */
export const chunkKey = (serverId: M.ServerId, from: number, through: number) =>
  `${serverPrefix(serverId)}${pad(from)}-${pad(through)}.jsonl`;
/** A listing position after every object whose first sequence is at or below `after`. */
export const startAfter = (serverId: M.ServerId, after: number) =>
  `${serverPrefix(serverId)}${pad(after)}-9999999999999999.jsonl`;
const KeyName = Schema.String.check(Schema.isPattern(/^(\d{16})-(\d{16})\.jsonl$/));
/** The sequences an archive object covers, from its name; null for anything else. */
export const chunkRange = (serverId: M.ServerId, key: string) => {
  const name = key.slice(serverPrefix(serverId).length);
  if (!key.startsWith(serverPrefix(serverId)) || !Schema.is(KeyName)(name)) return null;
  const [from, through] = name.slice(0, -".jsonl".length).split("-").map(Number);
  return from === undefined || through === undefined ? null : { from, through };
};

/** The archive could not be read or written; nothing was deleted, and the next pass retries. */
export class ArchiveUnavailable extends Schema.TaggedError<ArchiveUnavailable>()(
  "ArchiveUnavailable",
  { operation: Schema.String },
) {}

/** One stored archive object. */
export interface Chunk {
  readonly key: string;
  readonly from: number;
  readonly through: number;
}
/** Application-owned port for the archive objects of one deployment's bucket. */
export class ArchiveStore extends Context.Service<
  ArchiveStore,
  {
    /** Write one batch; replaces an object of the same name, so a retried batch never doubles. */
    readonly put: (key: string, body: string) => Effect.Effect<void, ArchiveUnavailable>;
    /** Up to `limit` objects under `prefix` after `startAfter`, in name order. */
    readonly list: (
      prefix: string,
      startAfter: string | null,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<string>, ArchiveUnavailable>;
    /** One object's text, or null when it is gone. */
    readonly read: (key: string) => Effect.Effect<string | null, ArchiveUnavailable>;
    readonly remove: (keys: ReadonlyArray<string>) => Effect.Effect<void, ArchiveUnavailable>;
  }
>()("@talkto/history/ArchiveStore") {}
const fail = (operation: string) => () => new ArchiveUnavailable({ operation });
/** The archive on the transfer bucket's Worker binding. */
export const fromBucket = (bucket: R2Bucket) =>
  ArchiveStore.of({
    put: (key, body) =>
      Effect.tryPromise({
        try: () => bucket.put(key, body, { httpMetadata: { contentType: "application/x-ndjson" } }),
        catch: fail("put"),
      }).pipe(Effect.asVoid),
    list: (prefix, after, limit) =>
      Effect.tryPromise({
        try: () =>
          bucket.list(after === null ? { prefix, limit } : { prefix, limit, startAfter: after }),
        catch: fail("list"),
      }).pipe(Effect.map((page) => page.objects.map((object) => object.key))),
    read: (key) =>
      Effect.tryPromise({
        try: () => bucket.get(key).then((object) => object?.text() ?? null),
        catch: fail("read"),
      }),
    remove: (keys) =>
      keys.length === 0
        ? Effect.void
        : Effect.tryPromise({ try: () => bucket.delete([...keys]), catch: fail("remove") }),
  });
const absent = () => Effect.fail(new ArchiveUnavailable({ operation: "absent" }));
/** A deployment without a bucket: nothing is archived, so nothing on Factory is deleted. */
export const unavailable = ArchiveStore.of({
  put: absent,
  list: absent,
  read: absent,
  remove: absent,
});
