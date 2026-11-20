import { Effect, Layer, Schema } from "effect";
import * as M from "@talkto/api/models";
import * as D from "@talkto/api/dashboard";
import * as P from "@talkto/api/platform";
import * as Activity from "./activity.js";
import * as Search from "./activity-search.js";
import * as Model from "./model.js";

const unavailable = () =>
  new Model.Failure({
    code: "storage_unavailable",
    message: "The organization activity index is temporarily unavailable.",
  });
const membership = `JOIN server_access g ON g.server_id=s.id AND g.user_id=?
  JOIN memberships m ON m.id=g.membership_id`;
const eligible = `s.account_id=? AND s.status='ready' AND s.deletion_requested_at IS NULL AND g.revoked_at IS NULL
  AND g.applied_revision=g.revision AND m.status='active'`;
const RankedServer = Schema.Struct({
  serverId: M.ServerId,
  createdBy: P.UserId,
  count: M.Count,
  lastMessageAt: Schema.NullOr(M.Timestamp),
});

/**
 * D1 index adapter; bounded pages use indexed account/delivery and account/time keys. References
 * older than the retention window (`retentionDays` in activity-projection.ts) are pruned, so feed
 * pages end there.
 */
export const layer = (database: D1Database) =>
  Layer.sync(Activity.Index, () => {
    const db = database.withSession("first-primary");
    const read = Effect.fn("ActivityIndex.read")(function* <A>(
      schema: Schema.Decoder<A>,
      statement: D1PreparedStatement,
    ) {
      const result = yield* Effect.tryPromise({ try: () => statement.all(), catch: unavailable });
      return yield* Schema.decodeUnknownEffect(Schema.Array(schema))(result.results).pipe(
        Effect.mapError(unavailable),
      );
    });
    return Activity.Index.of({
      head: (actor, accountId) =>
        read(
          Schema.Struct({ head: M.Count }),
          db
            .prepare(
              `SELECT COALESCE(MAX(e.id),0) AS head FROM activity_events e JOIN servers s ON s.id=e.server_id ${membership} WHERE e.account_id=? AND ${eligible}`,
            )
            .bind(actor.userId, accountId, accountId),
        ).pipe(Effect.map((rows) => rows[0]?.head ?? 0)),
      select: (state, limit) => {
        const direction = state.direction === "older" ? "DESC" : "ASC";
        const comparison = state.direction === "older" ? "<" : ">";
        return read(
          Activity.Reference,
          db
            .prepare(`SELECT e.id,e.server_id AS serverId,s.name AS serverName,e.message_id AS messageId
        FROM activity_events e JOIN servers s ON s.id=e.server_id ${membership}
        WHERE e.account_id=? AND ${eligible} AND e.id<=? AND e.id${comparison}?
        ORDER BY e.id ${direction} LIMIT ?`)
            .bind(
              state.userId,
              state.accountId,
              state.accountId,
              state.ceiling,
              state.boundary,
              limit,
            ),
        );
      },
      searchServers: Effect.fn("ActivityIndex.searchServers")(function* (actor, accountId, limit) {
        // Newest indexed message first, from each server's export progress, which outlives the
        // retained references; servers never indexed come last. Never message text.
        const servers = yield* read(
          Schema.Struct({ serverId: M.ServerId, serverName: M.ServerName, total: M.Count }),
          db
            .prepare(`SELECT s.id AS serverId,s.name AS serverName,COUNT(*) OVER () AS total
        FROM servers s ${membership} LEFT JOIN activity_progress p ON p.server_id=s.id WHERE ${eligible}
        ORDER BY p.last_message_at IS NULL,p.last_message_at DESC,s.id LIMIT ?`)
            .bind(actor.userId, accountId, limit),
        );
        return {
          total: servers[0]?.total ?? 0,
          servers: servers.map(({ serverId, serverName }) => ({ serverId, serverName })),
        };
      }),
      freshness: (actor, accountId) =>
        read(
          Schema.Struct({ indexedThrough: Schema.NullOr(M.Timestamp), pendingServers: M.Count }),
          db
            .prepare(`SELECT
        CASE WHEN COUNT(*)=COUNT(p.server_id) THEN MIN(p.checked_at) ELSE NULL END AS indexedThrough,
        COALESCE(SUM(CASE WHEN p.server_id IS NULL OR p.caught_up=0 THEN 1 ELSE 0 END),0) AS pendingServers
        FROM servers s ${membership} LEFT JOIN activity_progress p ON p.server_id=s.id WHERE ${eligible}`)
            .bind(actor.userId, accountId),
        ).pipe(Effect.map((rows) => rows[0] ?? { indexedThrough: null, pendingServers: 0 })),
      rank: Effect.fn("ActivityIndex.rank")(function* (actor, accountId, start, end) {
        // Both selections are read at once. The first ranks the first four visible servers by ID;
        // fewer than four rows means it covers every server, otherwise the busiest six are shown.
        const [first, active] = yield* Effect.all(
          [
            read(
              RankedServer,
              db
                .prepare(`SELECT s.id AS serverId,s.created_by AS createdBy,COUNT(e.id) AS count,MAX(e.created_at) AS lastMessageAt
        FROM servers s ${membership} LEFT JOIN activity_events e ON e.server_id=s.id
          AND e.account_id=? AND e.created_at>? AND e.created_at<=?
        WHERE ${eligible} AND s.id IN (SELECT s.id FROM servers s ${membership}
          WHERE ${eligible} ORDER BY s.id LIMIT 4)
        GROUP BY s.id ORDER BY count DESC,lastMessageAt DESC,s.id`)
                .bind(actor.userId, accountId, start, end, accountId, actor.userId, accountId),
            ),
            read(
              RankedServer,
              db
                .prepare(`SELECT e.server_id AS serverId,s.created_by AS createdBy,COUNT(*) AS count,MAX(e.created_at) AS lastMessageAt
        FROM activity_events e JOIN servers s ON s.id=e.server_id ${membership}
        WHERE e.account_id=? AND ${eligible} AND e.created_at>? AND e.created_at<=?
        GROUP BY e.server_id ORDER BY count DESC,lastMessageAt DESC,e.server_id LIMIT 6`)
                .bind(actor.userId, accountId, accountId, start, end),
            ),
          ],
          { concurrency: 2 },
        );
        return first.length <= 3
          ? { selection: "all" as const, servers: first }
          : { selection: "active" as const, servers: active };
      }),
    });
  });

/** Private RPC adapter performs current grant checks before releasing any full message or card. */
export const serversLayer = (namespace: Env["SERVERS"]) =>
  Layer.succeed(
    Activity.Servers,
    Activity.Servers.of({
      read: (actor, id, ids) =>
        Effect.tryPromise({
          try: () => namespace.getByName(id).readActivity(actor.principalKey, ids),
          catch: unavailable,
        }).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.NullOr(Schema.Struct({ data: Schema.Array(M.Message), included: M.Included })),
            ),
          ),
          Effect.mapError(unavailable),
        ),
      summary: (actor, id) =>
        Effect.tryPromise({
          try: () => namespace.getByName(id).readSummary(actor.principalKey),
          catch: unavailable,
        }).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.NullOr(Schema.Struct({ data: D.Summary, included: M.Included })),
            ),
          ),
          Effect.mapError(unavailable),
        ),
      // One server's failure is reported per server, so the other servers' matches still return.
      search: (actor, id, request) =>
        Effect.tryPromise({
          // Awaiting settles the RPC stub's per-variant promise types into one answer to decode.
          try: async () =>
            await namespace.getByName(id).searchActivity(actor.principalKey, request),
          catch: unavailable,
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Search.Answer)),
          Effect.orElseSucceed((): Search.Answer => ({ kind: "unavailable" })),
        ),
    }),
  );
