import { AwsClient } from "aws4fetch";
import { Effect, Schedule, Schema } from "effect";
import type { R2Settings } from "../configuration.js";
import * as Telemetry from "../telemetry.js";
import * as Model from "./model.js";
import * as Transfers from "./transfers.js";

const provider = "r2";
/** R2's numbered error codes, like 10001 (internal error) or 10043 (temporarily unavailable). */
const R2Code = Schema.Int.check(Schema.isBetween({ minimum: 10000, maximum: 99999 }));
const CodedRejection = Schema.Struct({ code: R2Code });
const NumberedRejection = Schema.Struct({
  message: Schema.String.check(Schema.isPattern(/\(\d{5}\)\s*$/)),
});
/**
 * The binding's rejection as a fixed word: the runtime's failure class (a lost connection, an
 * overload), else R2's numbered code (`r2_10001`), else `unclassified`. The message itself, which
 * can name the key, never leaves this function.
 */
const rejectionKind = (cause: unknown) => {
  const runtime = Telemetry.rejectionKind(cause);
  if (runtime !== undefined) return runtime;
  const coded = Schema.decodeUnknownOption(CodedRejection)(cause);
  if (coded._tag === "Some") return `r2_${coded.value.code}`;
  const numbered = Schema.decodeUnknownOption(NumberedRejection)(cause);
  if (numbered._tag === "Some") return `r2_${numbered.value.message.trimEnd().slice(-6, -1)}`;
  return "unclassified";
};
const failure = (operation: string) => (cause: unknown) =>
  Telemetry.withCause(
    new Model.FileStoreFailure({
      message: "The transfer store could not complete the operation.",
      operation,
      provider,
      code: null,
      failureKind: rejectionKind(cause),
    }),
    cause,
  );
/**
 * Try a read once more after a short pause: a single R2 hiccup should not fail a transfer.
 * Only `head` and `list` take this; deletes and signing never repeat.
 */
const retryRead = <A, E, R>(read: Effect.Effect<A, E, R>) =>
  read.pipe(Effect.retry({ times: 1, schedule: Schedule.spaced("200 millis") }));

/**
 * Cloudflare R2: a Worker binding reads and deletes, and signed links move the bytes directly
 * between the agents and the bucket. The binding cannot sign, so the S3 keys are Worker secrets
 * limited to this bucket. An upload link signs the size and `If-None-Match: *`, so it writes
 * only the declared size, and only once.
 */
export const make = (settings: R2Settings) => {
  const { bucket, objectBase, accessKeyId, secretAccessKey } = settings;
  const client = new AwsClient({ service: "s3", region: "auto", accessKeyId, secretAccessKey });
  const link = (key: string, query: string, seconds: number = Transfers.linkSeconds) =>
    `${objectBase}/${key}?X-Amz-Expires=${seconds}${query}`;
  const sign = (operation: string, url: string, init: RequestInit) =>
    Effect.tryPromise({
      try: () =>
        client
          .sign(url, { ...init, aws: { signQuery: true, allHeaders: true } })
          .then((signed) => signed.url),
      catch: failure(operation),
    });
  const removeKeys = (operation: string, keys: ReadonlyArray<string>) =>
    Effect.tryPromise({ try: () => bucket.delete([...keys]), catch: failure(operation) });
  return Transfers.TransferStore.of({
    uploadUrl: (key, bytes) =>
      sign("uploadUrl", link(key, ""), {
        method: "PUT",
        headers: { "content-length": String(bytes), "if-none-match": "*" },
      }),
    // `attachment` keeps a leaked link from ever rendering as a hosted page.
    downloadUrl: (key, options = {}) =>
      sign(
        "downloadUrl",
        link(
          key,
          `&response-content-disposition=${encodeURIComponent(
            options.fileName === undefined ? "attachment" : Transfers.attachment(options.fileName),
          )}`,
          options.seconds,
        ),
        { method: "GET" },
      ),
    size: (key) =>
      Effect.tryPromise({
        try: () => bucket.head(key).then((object) => object?.size ?? null),
        catch: failure("size"),
      }).pipe(retryRead),
    remove: (keys) => removeKeys("remove", keys),
    removePrefix: Effect.fn("R2.removePrefix")(function* (prefix) {
      let cursor: string | undefined;
      do {
        const page: R2Objects = yield* Effect.tryPromise({
          try: () => bucket.list(cursor === undefined ? { prefix } : { prefix, cursor }),
          catch: failure("list"),
        }).pipe(retryRead);
        if (page.objects.length > 0)
          yield* removeKeys(
            "removePrefix",
            page.objects.map((object) => object.key),
          );
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
    }),
  });
};
