import { Context, Effect, Layer, Schema } from "effect";
import * as Model from "../platform/model.js";
import * as Telemetry from "../telemetry.js";

/*
  Personal API keys in D1 (platform migration 0028). Only the secret's SHA-256 is stored. Times are
  epoch milliseconds.
*/

type Value = string | number | null;
const storage = (cause?: unknown) =>
  Telemetry.withCause(
    new Model.Failure({
      code: "storage_unavailable",
      message: "API keys are temporarily unavailable. Try again.",
    }),
    cause,
  );

/** A stored key, without its hash. */
export const Row = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  name: Schema.String,
  prefix: Schema.String,
  access: Schema.Literals(["read", "full"]),
  accountId: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  lastUsedAt: Schema.NullOr(Schema.Number),
  expiresAt: Schema.NullOr(Schema.Number),
  revokedAt: Schema.NullOr(Schema.Number),
});
/** Parsed key row. */
export interface Row extends Schema.Schema.Type<typeof Row> {}

/** A new key's row. */
export interface NewKey {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly prefix: string;
  readonly secretHash: string;
  readonly access: "read" | "full";
  readonly accountId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
}

type Operation<A> = Effect.Effect<A, Model.Failure>;
/** Storage for API keys. */
export class Store extends Context.Service<
  Store,
  {
    /** Insert a key if the person has fewer than `cap` unrevoked keys. False when at the cap. */
    readonly insert: (key: NewKey, cap: number) => Operation<boolean>;
    /** The person's unrevoked keys, newest first. */
    readonly active: (userId: string) => Operation<ReadonlyArray<Row>>;
    /** The unrevoked key with this secret hash, whoever it belongs to. */
    readonly bySecret: (secretHash: string) => Operation<Row | null>;
    /** Revoke one of the person's unrevoked keys. Null when there is none with this ID. */
    readonly revoke: (userId: string, id: string, at: number) => Operation<number | null>;
    /** Record a use, at most once per `throttle` ms. */
    readonly used: (id: string, at: number, throttle: number) => Operation<void>;
    /** Whether the person is an active member of an organization that is not being deleted. */
    readonly member: (userId: string, accountId: string) => Operation<boolean>;
    /** The organization a server belongs to; null for an unknown or deleted server. */
    readonly serverAccount: (serverId: string) => Operation<string | null>;
  }
>()("@talkto/api-keys/Store") {}

const columns =
  "id,user_id AS userId,name,prefix,access,account_id AS accountId,created_at AS createdAt,last_used_at AS lastUsedAt,expires_at AS expiresAt,revoked_at AS revokedAt";

/** The D1 store. Statements are made inside the attempted operation, so a broken binding fails. */
export const layer = (database: D1Database) =>
  Layer.sync(Store, () => {
    let session: D1DatabaseSession | undefined;
    const db = () => (session ??= database.withSession("first-primary"));
    const sql =
      (query: string, values: ReadonlyArray<Value> = []) =>
      () =>
        db()
          .prepare(query)
          .bind(...values);
    const run = (statement: () => D1PreparedStatement) =>
      Effect.tryPromise({ try: () => statement().run(), catch: storage });
    const all = <A>(schema: Schema.Decoder<A>, statement: () => D1PreparedStatement) =>
      Effect.tryPromise({ try: () => statement().all(), catch: storage }).pipe(
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(Schema.Array(schema))(result.results).pipe(
            Effect.mapError(() => storage()),
          ),
        ),
      );
    const Id = Schema.Struct({ id: Schema.String });
    return Store.of({
      insert: (key, cap) =>
        run(
          sql(
            `INSERT INTO api_keys(id,user_id,name,prefix,secret_hash,access,account_id,created_at,expires_at)
             SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9
             WHERE (SELECT COUNT(*) FROM api_keys WHERE user_id=?2 AND revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at>?8))<?10`,
            [
              key.id,
              key.userId,
              key.name,
              key.prefix,
              key.secretHash,
              key.access,
              key.accountId,
              key.createdAt,
              key.expiresAt,
              cap,
            ],
          ),
        ).pipe(Effect.map((result) => result.meta.changes === 1)),
      active: (userId) =>
        all(
          Row,
          sql(
            `SELECT ${columns} FROM api_keys WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 100`,
            [userId],
          ),
        ),
      bySecret: (secretHash) =>
        all(
          Row,
          // A person whose account deletion has begun has no working keys, even before `finish`.
          sql(
            `SELECT ${columns} FROM api_keys WHERE secret_hash=? AND revoked_at IS NULL
             AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=api_keys.user_id)`,
            [secretHash],
          ),
        ).pipe(Effect.map((rows) => rows[0] ?? null)),
      revoke: (userId, id, at) =>
        all(
          Id,
          sql(
            "UPDATE api_keys SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL RETURNING id",
            [at, id, userId],
          ),
        ).pipe(Effect.map((rows) => (rows.length === 1 ? at : null))),
      used: (id, at, throttle) =>
        run(
          sql(
            "UPDATE api_keys SET last_used_at=?1 WHERE id=?2 AND (last_used_at IS NULL OR last_used_at<=?1-?3)",
            [at, id, throttle],
          ),
        ).pipe(Effect.asVoid),
      member: (userId, accountId) =>
        all(
          Id,
          sql(
            `SELECT a.id FROM accounts a JOIN memberships m ON m.organization_id=a.organization_id
             WHERE a.id=? AND m.user_id=? AND m.status='active' AND a.deletion_requested_at IS NULL LIMIT 1`,
            [accountId, userId],
          ),
        ).pipe(Effect.map((rows) => rows.length === 1)),
      serverAccount: (serverId) =>
        all(
          Schema.Struct({ accountId: Schema.String }),
          sql(
            "SELECT account_id AS accountId FROM servers WHERE id=? AND deletion_requested_at IS NULL",
            [serverId],
          ),
        ).pipe(Effect.map((rows) => rows[0]?.accountId ?? null)),
    });
  });
