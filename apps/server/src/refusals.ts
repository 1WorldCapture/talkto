import { Clock, DateTime, Effect, Encoding, Option, Schema } from "effect";
import type * as A from "@talkto/api/agent";
import * as Envelope from "@talkto/api/envelope";
import * as M from "@talkto/api/models";
import type * as P from "@talkto/api/platform";
import type * as Access from "./access.js";
import * as Reads from "./reads.js";

/**
 * Read refusals remembered in the Worker (docs/storage-pool-and-read-limits.md, "Limit"). A server
 * object that refuses a read answers `rate_limited` with `retryAfterSeconds`. The Worker that
 * carried the call keeps that answer until the retry time and gives it again, with the seconds
 * left, when the same caller repeats the read early. The repeat costs a Worker request and never
 * reaches the server object. Callers that wait as told never meet this memory.
 *
 * - Keyed by server, the verified caller (principal and organization) and what the server's limit
 *   counted. For agent tools that is the read's subject: the participant it names, or the caller's
 *   grant when it names none (`Reads.classify`, as the server object uses it). For HTTP it is the
 *   identical request. A refusal never answers another caller, another participant, a write, or
 *   another transport.
 * - It never outlasts the server's: the retry time is counted on this isolate's clock from before
 *   the request left, so it ends no later than the time the server announced, whatever the two
 *   machines' clocks say. A clock that moved backwards forgets the refusal.
 * - It is forgotten after `longestSeconds` even when the server announced longer, so a plan
 *   upgrade or a revoked grant shows within a minute. The next retry then reaches the server
 *   object, which answers with its own time left.
 * - The organization backstop's refusal is never remembered: its window is the rate-limit
 *   binding's own, and the server may admit a retry before the 60 seconds it announces.
 * - Memory only, at most `capacity` refusals per isolate. Forgetting one only sends the next read
 *   to the server object, which decides as before.
 */

/** The most refusals one isolate remembers for each transport. */
const capacity = 1024;
/** No refusal is remembered longer than this, whatever the server announced. */
const longestSeconds = 60;
/** HTTP bodies above this size are never remembered; their reads go to the server object. */
const maxBody = 2048;
/** `POST …/updates`, the only HTTP read with a body. */
const updatesPath = /^\/v1\/servers\/[^/]+\/updates$/;

/** The verified caller a Worker forwards a read for. */
export interface Caller {
  readonly serverId: M.ServerId;
  readonly principalKey: Access.PrincipalKey;
  readonly organizationId: P.OrganizationId | null;
}
/** A refusal's message around its single "Wait N seconds", so it reads right with fewer left. */
interface Wording {
  readonly before: string;
  readonly after: string;
}
type RateLimited = typeof Envelope.RateLimited.Type;
interface AgentRefusal {
  readonly error: RateLimited["error"];
  readonly wording: Wording;
}
interface HttpRefusal {
  readonly body: RateLimited;
  readonly wording: Wording;
  readonly headers: Array<[string, string]>;
  readonly statusText: string;
}

/**
 * Remembered refusals by key, oldest first, at most `limit`. Each is kept until the server's retry
 * time or `longestSeconds`, whichever comes first. A full memory drops forgotten entries, then the
 * oldest.
 */
export const memory = <V>(limit: number) => {
  const entries = new Map<
    string,
    {
      readonly from: number;
      /** When the server said the caller may retry. */
      readonly until: number;
      /** When this memory stops answering, at most `longestSeconds` after `from`. */
      readonly forget: number;
      readonly value: V;
    }
  >();
  return {
    /** The refusal still remembered for `key` at `now`, with the server's whole seconds left. */
    recall: (key: string, now: number): { readonly value: V; readonly seconds: number } | null => {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      if (now < entry.from || now >= entry.forget) {
        entries.delete(key);
        return null;
      }
      // Rounded as the server rounds its own: whole seconds up, at least one.
      return { value: entry.value, seconds: Math.max(1, Math.ceil((entry.until - now) / 1000)) };
    },
    /** Remember a refusal of `seconds` for a request that left at `sentAt`. */
    remember: (key: string, sentAt: number, seconds: number, value: V, now: number) => {
      const forget = sentAt + Math.min(seconds, longestSeconds) * 1000;
      entries.delete(key);
      if (now >= forget) return;
      if (entries.size >= limit)
        for (const [name, entry] of entries) if (now >= entry.forget) entries.delete(name);
      if (entries.size >= limit) {
        const oldest = entries.keys().next();
        if (oldest.done !== true) entries.delete(oldest.value);
      }
      entries.set(key, { from: sentAt, until: sentAt + seconds * 1000, forget, value });
    },
  };
};
const agents = memory<AgentRefusal>(capacity);
const requests = memory<HttpRefusal>(capacity);

/**
 * Split a refusal's message at its one "Wait N seconds"; null when it has none or several, or for
 * the organization backstop, which is never remembered.
 */
const wordingOf = (message: string, seconds: number): Wording | null => {
  if (message === Reads.backstopMessage) return null;
  const marker = `Wait ${seconds} seconds`;
  const at = message.indexOf(marker);
  if (at === -1 || message.includes(marker, at + 1)) return null;
  return { before: message.slice(0, at), after: message.slice(at + marker.length) };
};
const worded = (wording: Wording, seconds: number) =>
  `${wording.before}Wait ${seconds} seconds${wording.after}`;

/** The subject a server object's read limit counts for this tool call, or null for other tools. */
const agentKey = (caller: Caller, command: A.Command) => {
  const read = Reads.classify(command);
  return read === null
    ? null
    : JSON.stringify([
        caller.serverId,
        caller.principalKey,
        caller.organizationId,
        read.participantId,
      ]);
};

/**
 * Invoke an agent tool on its server object, unless the same caller's read of the same subject
 * was refused and its retry time has not passed: then answer with that refusal and the seconds
 * left, as the server object would, without a request.
 */
export const invokeAgent = Effect.fn("Refusals.invokeAgent")(function* (
  caller: Caller,
  command: A.Command,
  meta: A.Meta,
  invoke: Effect.Effect<A.UncheckedReply>,
) {
  const key = agentKey(caller, command);
  if (key === null) return yield* invoke;
  const sentAt = yield* Clock.currentTimeMillis;
  const remembered = agents.recall(key, sentAt);
  if (remembered !== null) {
    const { error, wording } = remembered.value;
    const { seconds } = remembered;
    const reply: A.UncheckedReply = {
      error: { ...error, retryAfterSeconds: seconds, message: worded(wording, seconds) },
      meta,
    };
    return reply;
  }
  const reply = yield* invoke;
  const refusal = decodeAgentRefusal(reply);
  if (Option.isSome(refusal)) {
    const { error } = refusal.value;
    const wording = wordingOf(error.message, error.retryAfterSeconds);
    if (wording !== null)
      agents.remember(
        key,
        sentAt,
        error.retryAfterSeconds,
        { error, wording },
        yield* Clock.currentTimeMillis,
      );
  }
  return reply;
});

const decodeRefusal = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope.RateLimited));
/** A tool reply's `rate_limited` error, if it is one; the MCP boundary checks the rest. */
const decodeAgentRefusal = Schema.decodeUnknownOption(
  Schema.Struct({ error: Envelope.RateLimited.fields.error }),
);
/** The identical HTTP read from the same caller, or null for writes and large bodies. */
const requestKey = (
  caller: Caller,
  website: boolean,
  request: Request,
  payload: Uint8Array | null,
) => {
  const url = new URL(request.url);
  const read =
    request.method === "GET" || (request.method === "POST" && updatesPath.test(url.pathname));
  if (!read || (payload !== null && payload.byteLength > maxBody)) return null;
  return JSON.stringify([
    caller.serverId,
    caller.principalKey,
    caller.organizationId,
    website,
    request.method,
    `${url.pathname}${url.search}`,
    request.headers.get("content-type"),
    payload === null ? null : Encoding.encodeBase64(payload),
  ]);
};

/**
 * Forward an authenticated HTTP read to its server object, unless the same caller's identical
 * read was refused and its retry time has not passed: then answer 429 as the server object did,
 * with the seconds left in the body and in Retry-After. Writes always go through.
 */
export const forward = Effect.fn("Refusals.forward")(function* (
  caller: Caller,
  website: boolean,
  request: Request,
  payload: Uint8Array | null,
  requestId: Envelope.Meta["requestId"],
  send: Effect.Effect<Response>,
) {
  const key = requestKey(caller, website, request, payload);
  if (key === null) return yield* send;
  const sentAt = yield* Clock.currentTimeMillis;
  const remembered = requests.recall(key, sentAt);
  if (remembered !== null) {
    const { body, wording, headers, statusText } = remembered.value;
    const { seconds } = remembered;
    const answer = new Headers(headers);
    answer.delete("content-length");
    answer.set("retry-after", String(seconds));
    answer.set("x-request-id", requestId);
    const serverTime = M.Timestamp.make(DateTime.formatIso(yield* DateTime.now));
    return Response.json(
      {
        ...body,
        error: { ...body.error, retryAfterSeconds: seconds, message: worded(wording, seconds) },
        meta: { ...body.meta, requestId, serverTime },
      },
      { status: 429, statusText, headers: answer },
    );
  }
  const response = yield* send;
  if (response.status !== 429) return response;
  const text = yield* Effect.promise(() => response.text());
  const refusal = decodeRefusal(text);
  if (Option.isSome(refusal)) {
    const error = refusal.value.error;
    const wording = wordingOf(error.message, error.retryAfterSeconds);
    if (wording !== null)
      requests.remember(
        key,
        sentAt,
        error.retryAfterSeconds,
        {
          body: refusal.value,
          wording,
          headers: [...response.headers],
          statusText: response.statusText,
        },
        yield* Clock.currentTimeMillis,
      );
  }
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
});
