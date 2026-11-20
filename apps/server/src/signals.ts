import { Context, Effect, Encoding, Result, Schema } from "effect";
import { run } from "@talkto/telemetry/effect";
import * as M from "@talkto/api/models";
import * as S from "@talkto/api/signal";
import * as P from "@talkto/api/plugins";
import type * as E from "@talkto/api/errors";
import * as Envelope from "@talkto/api/envelope";
import * as Responses from "./responses.js";
import type * as U from "@talkto/api/updates";
import type { AccessContext } from "./access.js";
import type { SignalRecord } from "./persistence.js";
import * as WakeCrypto from "./wakes/crypto.js";

/** A link is unknown, its secret is wrong, or it expired or lost its grant, participant or history. */
export class SignalUnavailable extends Schema.TaggedError<SignalUnavailable>()(
  "SignalUnavailable",
  {},
) {}

/** Runtime port for link secrets: cryptographic randomness and hashing belong to the runtime. */
export class SignalSecrets extends Context.Service<
  SignalSecrets,
  {
    readonly mint: (serverId: M.ServerId, signalId: S.SignalId) => Effect.Effect<S.Secret>;
    readonly hash: (secret: S.Secret) => Effect.Effect<string>;
  }
>()("@talkto/SignalSecrets") {}

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const secretBytes = 32;
const tagBytes = 16;
/** The HMAC key in `TALKTO_SIGNAL_KEY`, imported once per isolate the first time it is used. */
export type SignalKey = () => Promise<CryptoKey>;
let loaded: { readonly raw: string; readonly key: SignalKey } | null = null;
/**
 * The deployment's signal key: `TALKTO_SIGNAL_KEY`, 32 random bytes in base64 or base64url. Null
 * when it is unset or malformed; links are then fully random and every check is admitted by the
 * Worker's server existence check instead of the tag.
 */
export const signalKey = (raw: string | undefined): SignalKey | null => {
  if (raw === undefined) return null;
  if (loaded?.raw === raw) return loaded.key;
  const bytes = WakeCrypto.parseKey(raw);
  if (bytes === null) return null;
  let imported: Promise<CryptoKey> | null = null;
  const key: SignalKey = () =>
    (imported ??= crypto.subtle.importKey(
      "raw",
      new Uint8Array(bytes),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ));
  loaded = { raw, key };
  return key;
};
/** The first 16 bytes of HMAC-SHA-256 over the link's server, ID and random half; versioned. */
const tag = (key: SignalKey, serverId: M.ServerId, signalId: S.SignalId, nonce: Uint8Array) =>
  Effect.promise(async () => {
    const message = `talkto-signal-v1:${serverId}:${signalId}:${Encoding.encodeBase64Url(nonce)}`;
    const mac = await crypto.subtle.sign("HMAC", await key(), new TextEncoder().encode(message));
    return new Uint8Array(mac).slice(0, tagBytes);
  });
/**
 * Link secrets, 32 bytes in base64url; only the SHA-256 of a secret is ever stored. Without a key
 * all 32 bytes are random. With one, 16 random bytes are followed by their 16-byte tag, so the
 * Worker can tell a link this deployment minted from a guess before it wakes any server object.
 * The format is unchanged, so hooks treat both alike.
 */
export const secrets = (key: SignalKey | null) =>
  SignalSecrets.of({
    mint: Effect.fn("SignalSecrets.mint")(function* (serverId, signalId) {
      if (key === null)
        return S.Secret.make(
          Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(secretBytes))),
        );
      const nonce = crypto.getRandomValues(new Uint8Array(secretBytes - tagBytes));
      const bytes = new Uint8Array(secretBytes);
      bytes.set(nonce);
      bytes.set(yield* tag(key, serverId, signalId, nonce), nonce.byteLength);
      return S.Secret.make(Encoding.encodeBase64Url(bytes));
    }),
    hash: (secret) =>
      Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))).pipe(
        Effect.map(hex),
      ),
  });
/**
 * Whether a link's secret carries this key's tag for its server and link ID. A tag proves only
 * that this deployment minted the link; the server object still checks the whole secret.
 */
export const tagged = Effect.fn("Signals.tagged")(function* (key: SignalKey, link: Request) {
  const decoded = Encoding.decodeBase64Url(link.secret);
  if (Result.isFailure(decoded) || decoded.success.byteLength !== secretBytes) return false;
  const nonce = decoded.success.slice(0, secretBytes - tagBytes);
  const given = decoded.success.slice(secretBytes - tagBytes);
  const expected = yield* tag(key, link.serverId, link.signalId, nonce);
  let difference = 0;
  for (let index = 0; index < tagBytes; index++)
    difference |= (expected[index] ?? 0) ^ (given[index] ?? 0);
  return difference === 0;
});
/** Compare two stored-length hex digests without an early exit. */
export const sameDigest = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};

/** A freshly minted link; the secret is returned once and never stored. */
export interface Minted {
  readonly signalId: S.SignalId;
  readonly secret: S.Secret;
  readonly expiresAt: M.Timestamp;
  readonly selection: U.Selection;
}
/** A link whose secret matched: its stored grant becomes the access the count runs under. */
export interface Opened {
  readonly access: AccessContext;
  readonly signal: SignalRecord;
}
/**
 * The link a participant's hook saves. The secret appears only here and in the agent's reply; a
 * hook sends it back in the Authorization header, not in the URL (see `parse`).
 */
export const url = (origin: string, serverId: M.ServerId, id: S.SignalId, secret: S.Secret) =>
  `${origin}${S.pathPrefix}${serverId}/${id}.${secret}`;

/** What the agent is told to do with a new link. */
export const procedure =
  "Your TalkTo hook saves this link by itself when it sees this result. Muse saves it in its Secure Credentials Store for its own hook, as the agent guide's Muse section describes. If your host has no TalkTo hook, ignore it. The hook checks the link with a GET that carries its secret in the Authorization header, not the URL; the answer is only counts (pending, urgent, waking) for this participant and selection, never message text or names. Never paste the link into a message or a tracked file. The hook starts or continues a turn only for your direct messages, @mentions of you and TalkTo's notices; it mentions other channel messages when you next have a turn. When a hook says TalkTo messages are waiting, call get_updates as usual. Calling create_signal again rotates the link; call revoke_signal when your task ends.";
/** A request for a signal link, parsed from its path, header and `since` query; null when malformed. */
export interface Request {
  readonly serverId: M.ServerId;
  readonly signalId: S.SignalId;
  readonly secret: S.Secret;
  readonly since: M.MessageId | null;
  /** The `TalkTo-Plugin` header, as in `hooks/0.3.0`, when it is one; hooks before 0.3.0 omit it. */
  readonly plugin?: P.PluginRelease | null;
}
const LinkPath = Schema.Struct({ serverId: M.ServerId, signalId: S.SignalId, secret: S.Secret });
/** The same request as it crosses Durable Object RPC; the object decodes it again. */
export const RequestSchema = Schema.Struct({
  ...LinkPath.fields,
  since: Schema.NullOr(M.MessageId),
  plugin: Schema.optionalKey(Schema.NullOr(P.PluginRelease)),
});
/** Whether a path belongs to signal links at all, so ingress can route it before authentication. */
export const isSignalPath = (path: string) => path.startsWith(S.pathPrefix);
/**
 * Parse a check in one of two forms:
 * - `/v1/signals/<serverId>/<signalId>?since=<cursor>` with `Authorization: Bearer <secret>`,
 *   which keeps the secret out of the URL that request logs record;
 * - `/v1/signals/<serverId>/<signalId>.<secret>?since=<cursor>`, the link itself, which hooks
 *   installed before the header form still send.
 * A request that carries a secret in both places, or in neither, is refused.
 */
export const parse = (
  url: URL,
  authorization: string | null,
  plugin: string | null = null,
): Request | null => {
  const parts = url.pathname.slice(S.pathPrefix.length).split("/");
  if (parts.length !== 2) return null;
  const segment = parts[1] ?? "";
  const inPath = S.tokenPattern.exec(segment);
  const inHeader = S.idPattern.exec(segment);
  const header = authorization === null ? null : S.authorizationPattern.exec(authorization);
  if (inPath !== null && authorization !== null) return null;
  const secret = inPath?.[2] ?? header?.[1];
  const signalId = inPath?.[1] ?? (header === null ? undefined : inHeader?.[1]);
  const link = Schema.decodeUnknownOption(LinkPath)({ serverId: parts[0], signalId, secret });
  if (link._tag === "None") return null;
  // An unreadable header is ignored, never a refusal: the counts matter more than the report.
  const report = Schema.decodeUnknownOption(P.PluginRelease)(plugin);
  const reported = report._tag === "None" ? {} : { plugin: report.value };
  const supplied = url.searchParams.get("since");
  if (supplied === null || supplied === "") return { ...link.value, since: null, ...reported };
  const since = Schema.decodeUnknownOption(M.MessageId)(supplied);
  return since._tag === "None" ? null : { ...link.value, since: since.value, ...reported };
};

/** One answer the server object returns to the Worker; serializable over Durable Object RPC. */
export type Answer =
  | { readonly kind: "counts"; readonly counts: S.Counts }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "rate_limited";
      readonly message: string;
      readonly retryAfterSeconds: number;
      readonly scope: "participant" | "organization" | "network";
    }
  | { readonly kind: "storage_unavailable" };

/** Map an application outcome to the serializable answer. */
export const answer = (
  effect: Effect.Effect<S.Counts, SignalUnavailable | E.RateLimited | E.StorageUnavailable>,
): Effect.Effect<Answer> =>
  effect.pipe(
    Effect.map((counts): Answer => ({ kind: "counts", counts })),
    Effect.catchTags({
      SignalUnavailable: () => Effect.succeed<Answer>({ kind: "unavailable" }),
      RateLimited: (error) =>
        Effect.succeed<Answer>({
          kind: "rate_limited",
          message: error.message,
          retryAfterSeconds: error.retryAfterSeconds,
          scope: error.scope,
        }),
      StorageUnavailable: () => Effect.succeed<Answer>({ kind: "storage_unavailable" }),
    }),
  );

const unavailableMessage =
  "This signal link is unknown, expired or revoked. If you are still collaborating, call create_signal again through your TalkTo MCP connection.";
/** Render an answer for a hook. Success is a flat, content-free object; failures use the envelope. */
export const respond = (result: Answer, meta: Envelope.Meta): Response => {
  switch (result.kind) {
    case "counts":
      return Response.json(Schema.encodeSync(S.Counts)(result.counts), {
        headers: { "cache-control": "no-store", "x-request-id": meta.requestId },
      });
    case "unavailable":
      return Responses.failure(404, "not_found", unavailableMessage, meta);
    case "storage_unavailable":
      return Responses.failure(
        503,
        "storage_unavailable",
        "The server is temporarily unavailable. Check again later.",
        meta,
      );
    case "rate_limited":
      return Response.json(
        {
          error: {
            code: "rate_limited",
            message: result.message,
            retryable: true,
            action: "retry_after",
            retryAfterSeconds: result.retryAfterSeconds,
            scope: result.scope,
          },
          meta,
        },
        {
          status: 429,
          headers: {
            "cache-control": "no-store",
            "retry-after": String(result.retryAfterSeconds),
            "x-request-id": meta.requestId,
          },
        },
      );
  }
};
/** How long a network over its failed-check limit is refused. */
export const networkRetrySeconds = 60;
const networkLimited: Answer = {
  kind: "rate_limited",
  message: `Too many failed signal checks from this network. Wait ${networkRetrySeconds} seconds, then check again. A link that keeps answering 404 has ended: call create_signal through your TalkTo MCP connection for a new one.`,
  retryAfterSeconds: networkRetrySeconds,
  scope: "network",
};
/**
 * What the Worker checks before a signal check may wake a server object. Hosted TalkTo guards
 * every check (`signal-guard.ts`); local mode reaches only its one configured server.
 */
export interface Guard {
  /** The caller's network exceeded its failed-check limit recently. */
  readonly blocked: Effect.Effect<boolean>;
  /** Whether this check may wake the server object it names. */
  readonly admit: (link: Request) => Effect.Effect<boolean>;
  /** Count one failed check; true when the caller's network is now over its limit. */
  readonly failed: Effect.Effect<boolean>;
}
/** No guard: every well-formed check reaches its server object. */
export const unguarded: Guard = {
  blocked: Effect.succeed(false),
  admit: () => Effect.succeed(true),
  failed: Effect.succeed(false),
};
/** Signal links answer GET only. */
export const methodNotAllowed = (meta: Envelope.Meta) =>
  Responses.failure(405, "invalid_input", "Signal links answer GET only.", meta);
/**
 * Route one signal link request without any credential. The guard decides first whether the
 * check may wake the server object named in the link; that object checks the secret. Nothing
 * here reads or forwards authority headers. Every refusal is the same 404, and a network over
 * the guard's failed-check limit gets 429 until its period ends.
 */
export const ingress = async (
  request: globalThis.Request,
  meta: Envelope.Meta,
  server: (serverId: M.ServerId) => { readonly checkSignal: (input: Request) => Promise<Answer> },
  guard: Guard = unguarded,
): Promise<Response> => {
  if (request.method !== "GET") return methodNotAllowed(meta);
  if (await run(guard.blocked)) return respond(networkLimited, meta);
  const refuse = async () =>
    respond((await run(guard.failed)) ? networkLimited : { kind: "unavailable" }, meta);
  const parsed = parse(
    new URL(request.url),
    request.headers.get("authorization"),
    request.headers.get(P.pluginHeader),
  );
  if (parsed === null || !(await run(guard.admit(parsed)))) return refuse();
  let result: Answer;
  try {
    result = await server(parsed.serverId).checkSignal(parsed);
  } catch {
    return respond({ kind: "storage_unavailable" }, meta);
  }
  return result.kind === "unavailable" ? refuse() : respond(result, meta);
};
