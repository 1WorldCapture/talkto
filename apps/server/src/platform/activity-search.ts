import { DateTime, Schema } from "effect";
import * as M from "@talkto/api/models";
import * as I from "@talkto/api/inputs";

/**
 * Cross-server search asks each server's own database, never a shared index. These shapes cross
 * Durable Object RPC between the platform and one server, and each side decodes them again.
 */

/** Most servers one account search asks; more are named as not searched in the response. */
export const serverLimit = 20;
/** Servers asked at once. */
export const concurrency = 5;
/** Message-body UTF-8 one server may return for one page, matching the feed page budget. */
export const bodyBudget = 65536;

/**
 * Where one server's part of a page starts. A sequence bound is exclusive. A time bound compares
 * message creation time, which never decreases with sequence inside one server.
 */
export const Bound = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("sequence"), sequence: M.Count }),
  Schema.Struct({ kind: Schema.Literal("time"), time: M.Timestamp, inclusive: Schema.Boolean }),
]);
/** Parsed per-server bound. */
export type Bound = typeof Bound.Type;
/** One server's part of an account search page. */
export const Request = Schema.Struct({
  query: I.SearchQuery,
  direction: Schema.Literals(["older", "newer"]),
  bound: Schema.NullOr(Bound),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
});
/** Parsed per-server search request. */
export interface Request extends Schema.Schema.Type<typeof Request> {}
/**
 * One server's answer. `more` says matches remain past the returned ones; `head` is the server's
 * newest message sequence when it answered, so a live continuation can count from it.
 */
export const Answer = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("results"),
    items: Schema.Array(M.Message),
    included: M.Included,
    more: Schema.Boolean,
    head: M.Count,
  }),
  Schema.Struct({ kind: Schema.Literal("denied") }),
  Schema.Struct({ kind: Schema.Literal("unavailable") }),
]);
/** Parsed per-server search answer. */
export type Answer = typeof Answer.Type;

/** One server's returned matches, ready to merge with the others. */
export interface Part {
  readonly serverId: M.ServerId;
  readonly serverName: typeof M.ServerName.Type;
  readonly items: ReadonlyArray<M.Message>;
  readonly more: boolean;
}
/** One merged match and the server it came from. */
export interface Match {
  readonly serverId: M.ServerId;
  readonly serverName: typeof M.ServerName.Type;
  readonly message: M.Message;
}
/** Where an older-direction page stopped: the last match it returned, in merge order. */
export const Position = Schema.Struct({
  time: M.Timestamp,
  serverId: M.ServerId,
  sequence: M.Count,
});
/** Parsed merge position. */
export interface Position extends Schema.Schema.Type<typeof Position> {}

const millis = (time: M.Timestamp) => DateTime.toEpochMillis(DateTime.makeUnsafe(time));
/** Ascending merge order: creation time, then server ID, then the server's own sequence. */
export const compare = (left: Position, right: Position) =>
  millis(left.time) - millis(right.time) ||
  (left.serverId < right.serverId ? -1 : left.serverId > right.serverId ? 1 : 0) ||
  left.sequence - right.sequence;
/** The merge position of one match. */
export const positionOf = (match: Match): Position => ({
  time: match.message.createdAt,
  serverId: match.serverId,
  sequence: match.message.sequence,
});

/**
 * Where one server's part of an older-direction page starts, after `position`. Inside one server
 * creation time never decreases with sequence, so the merge order reduces to one comparison.
 */
export const olderBound = (serverId: M.ServerId, position: Position | null): Bound | null =>
  position === null
    ? null
    : serverId === position.serverId
      ? { kind: "sequence", sequence: position.sequence }
      : { kind: "time", time: position.time, inclusive: serverId < position.serverId };

/** One merged page: its matches in order, and whether matches remain past them. */
export interface Merged {
  readonly matches: ReadonlyArray<Match>;
  readonly more: boolean;
}

/**
 * Merge each server's sorted matches into one page. A server that has more matches than it
 * returned stops the page at its last returned match, because its next match could sort before
 * any other server's remaining ones. Pages hold at most `limit` matches and `bodyBudget` bytes.
 */
export const merge = (
  parts: ReadonlyArray<Part>,
  direction: "older" | "newer",
  limit: number,
): Merged => {
  const sign = direction === "older" ? -1 : 1;
  const candidates = parts
    .flatMap((part) =>
      part.items.map((message) => ({
        serverId: part.serverId,
        serverName: part.serverName,
        message,
      })),
    )
    .toSorted((left, right) => sign * compare(positionOf(left), positionOf(right)));
  const remaining = new Map(parts.map((part) => [part.serverId, part.items.length]));
  const unfinished = new Set(parts.filter((part) => part.more).map((part) => part.serverId));
  const matches: Match[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    const size = new TextEncoder().encode(candidate.message.body).length;
    if (matches.length >= limit || bytes + size > bodyBudget) break;
    matches.push(candidate);
    bytes += size;
    const left = (remaining.get(candidate.serverId) ?? 1) - 1;
    remaining.set(candidate.serverId, left);
    if (left === 0 && unfinished.has(candidate.serverId)) break;
  }
  return { matches, more: unfinished.size > 0 || matches.length < candidates.length };
};
