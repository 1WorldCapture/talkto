import { Context, Effect, Layer, Schema } from "effect";
import * as F from "@talkto/api/feedback";
import * as M from "@talkto/api/models";
import * as Model from "../platform/model.js";
import * as Telemetry from "../telemetry.js";

/*
  Feedback in D1 (platform migration 0022). One row per message. The insert, the daily count and
  the read-back run in one batch, so two racing sends cannot both pass the limit, and a retried
  request key always finds the first row.
*/

const storage = (cause?: unknown) =>
  Telemetry.withCause(
    new Model.Failure({
      code: "storage_unavailable",
      message: "Feedback is temporarily unavailable. Nothing was sent. Try again.",
    }),
    cause,
  );

/** A message as the sender wrote it, with the facts the Worker attached. */
export interface Entry {
  readonly id: F.FeedbackId;
  readonly userId: string;
  readonly requestKey: M.RequestKey;
  readonly source: F.FeedbackSource;
  readonly kind: F.FeedbackKind;
  readonly message: string;
  /** Checked: an account the sender can open. With a server and no account, the server's account. */
  readonly accountId: string | null;
  /** Checked: a server the sender can open. */
  readonly serverId: string | null;
  /** Checked: an agent on `serverId` registered through the sender's access. */
  readonly participantId: string | null;
  readonly page: string | null;
  readonly appVersion: string | null;
  readonly userAgent: string | null;
  readonly at: M.Timestamp;
}

/** The row stored under the entry's request key. */
export const Row = Schema.Struct({
  id: F.FeedbackId,
  source: F.FeedbackSource,
  kind: F.FeedbackKind,
  message: Schema.String,
  page: Schema.NullOr(Schema.String),
  createdAt: M.Timestamp,
});
/** Parsed stored row. */
export interface Row extends Schema.Schema.Type<typeof Row> {}

/** Storage for feedback. */
export class Store extends Context.Service<
  Store,
  {
    /**
     * Store the entry unless its sender already has `limit` messages since `since`, then return
     * the row under its request key: the new one, an earlier one, or null when the limit refused it.
     */
    readonly record: (
      entry: Entry,
      since: M.Timestamp,
      limit: number,
    ) => Effect.Effect<Row | null, Model.Failure>;
  }
>()("@talkto/feedback/Store") {}

/** The D1 store; the session is made inside the attempt, so a broken binding is a storage failure. */
export const layer = (database: D1Database) =>
  Layer.sync(Store, () =>
    Store.of({
      record: Effect.fn("FeedbackStore.record")(function* (entry, since, limit) {
        const results = yield* Effect.tryPromise({
          try: () => {
            const db = database.withSession("first-primary");
            return db.batch([
              db
                .prepare(
                  `INSERT INTO feedback(id,created_at,kind,message,user_id,account_id,page,app_version,user_agent,request_key,source,server_id,participant_id)
                   SELECT ?1,?2,?3,?4,?5,COALESCE(?6,(SELECT account_id FROM servers WHERE id=?14)),?7,?8,?9,?10,?13,?14,?15
                   WHERE (SELECT COUNT(*) FROM feedback WHERE user_id=?5 AND created_at>=?11)<?12
                   ON CONFLICT(user_id,request_key) DO NOTHING`,
                )
                .bind(
                  entry.id,
                  entry.at,
                  entry.kind,
                  entry.message,
                  entry.userId,
                  entry.accountId,
                  entry.page,
                  entry.appVersion,
                  entry.userAgent,
                  entry.requestKey,
                  since,
                  limit,
                  entry.source,
                  entry.serverId,
                  entry.participantId,
                ),
              db
                .prepare(
                  "SELECT id,source,kind,message,page,created_at AS createdAt FROM feedback WHERE user_id=? AND request_key=?",
                )
                .bind(entry.userId, entry.requestKey),
            ]);
          },
          catch: storage,
        });
        return yield* Schema.decodeUnknownEffect(Schema.UndefinedOr(Row))(
          results[1]?.results[0],
        ).pipe(
          Effect.map((row) => row ?? null),
          Effect.mapError(() => storage()),
        );
      }),
    }),
  );
