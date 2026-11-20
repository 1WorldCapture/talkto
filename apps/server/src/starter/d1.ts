import { Effect, Layer, Result, Schema } from "effect";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as Provisioning from "../platform/provisioning-policy.js";
import * as Model from "./model.js";
import * as Telemetry from "../telemetry.js";

const grantColumns = `id,account_id AS accountId,organization_id AS organizationId,owner_id AS ownerId,
 request_key AS requestKey,server_name AS serverName,server_id AS serverId,allowance,status,
 reserved_at AS reservedAt,activated_at AS activatedAt,published_at AS publishedAt,offer_version AS offerVersion`;
/** Matches any spent claim for these keys, including the card-backed trial's own records. */
const spentClause = `(EXISTS(SELECT 1 FROM starter_claims WHERE namespace=? AND (
   (kind='owner' AND key=?) OR (kind='inbox' AND key IN (?,?)) OR (kind='organization' AND key=?) OR (kind='account' AND key=?)))
 OR EXISTS(SELECT 1 FROM billing_trials WHERE owner_id=? OR account_id=? OR email_key IN (?,?)))`;
/** Null keys match nothing: `IN` never matches NULL. */
const spentValues = (namespace: string, keys: Model.Keys) => [
  namespace,
  keys.owner,
  keys.inbox,
  keys.previousInbox,
  keys.organization,
  keys.account,
  keys.owner,
  keys.account,
  keys.trialEmail,
  keys.legacyEmail,
];
const day = (at: M.Timestamp) => at.slice(0, 10);
/** The server this grant's request key created for its owner, if any. */
const reservedServer = `SELECT s.id FROM servers s WHERE s.account_id=starter_grants.account_id
 AND s.created_by=starter_grants.owner_id AND s.request_key=starter_grants.request_key`;

/** Admission is one D1 batch, so concurrent claims serialize and cannot both pass the checks. */
export const layer = (database: D1Database) =>
  Layer.sync(Model.Store, () => {
    const db = database.withSession("first-primary");
    const sql = (query: string, values: ReadonlyArray<string | number | null> = []) =>
      db.prepare(query).bind(...values);
    const all = Effect.fn("StarterStore.read")(function* <A>(
      schema: Schema.Decoder<A>,
      statement: D1PreparedStatement,
    ) {
      const result = yield* Effect.tryPromise({
        try: () => statement.all(),
        catch: (cause) => Telemetry.withCause(Model.unavailable("storage.read"), cause),
      });
      return yield* Schema.decodeUnknownEffect(Schema.Array(schema))(result.results).pipe(
        Effect.mapError(() => Model.unavailable("storage.decode")),
      );
    });
    const one = <A>(schema: Schema.Decoder<A>, statement: D1PreparedStatement) =>
      all(schema, statement).pipe(Effect.map((rows) => rows[0] ?? null));
    const batch = (statements: ReadonlyArray<D1PreparedStatement>) =>
      Effect.tryPromise({
        try: () => db.batch([...statements]),
        catch: (cause) => Telemetry.withCause(Model.unavailable("storage.write"), cause),
      });
    /** Writes and a read of their outcome in one round trip: a batch is one transaction. */
    const writeThenRead = Effect.fn("StarterStore.writeThenRead")(function* <A>(
      schema: Schema.Decoder<A>,
      statements: ReadonlyArray<D1PreparedStatement>,
      read: D1PreparedStatement,
    ) {
      const results = yield* batch([...statements, read]);
      return (
        (yield* Schema.decodeUnknownEffect(Schema.Array(schema))(results.at(-1)?.results).pipe(
          Effect.mapError(() => Model.unavailable("storage.decode")),
        ))[0] ?? null
      );
    });
    const grant = (accountId: P.AccountId) =>
      one(
        Model.Grant,
        sql(`SELECT ${grantColumns} FROM starter_grants WHERE account_id=?`, [accountId]),
      );
    /** Update one grant and return it as stored. */
    const update = Effect.fn("StarterStore.update")(function* (
      id: string,
      statement: D1PreparedStatement,
    ) {
      const value = yield* writeThenRead(
        Model.Grant,
        [statement],
        sql(`SELECT ${grantColumns} FROM starter_grants WHERE id=?`, [id]),
      );
      if (value === null) return yield* Model.unavailable("storage.grant_missing");
      return value;
    });
    const spent = Effect.fn("StarterStore.spent")(function* (namespace: string, keys: Model.Keys) {
      const row = yield* one(
        Schema.Struct({ spent: Schema.Int }),
        sql(`SELECT ${spentClause} AS spent`, spentValues(namespace, keys)),
      );
      return row?.spent === 1;
    });
    const standing = Effect.fn("StarterStore.standing")(function* (accountId: P.AccountId) {
      const [flags, servers] = yield* Effect.all(
        [
          one(
            Schema.Struct({ paid: Schema.Int, trial: Schema.Int }),
            sql(
              `SELECT EXISTS(SELECT 1 FROM billing_periods WHERE account_id=?) AS paid,
               EXISTS(SELECT 1 FROM billing_trials WHERE account_id=?) AS trial`,
              [accountId, accountId],
            ),
          ),
          all(
            Schema.Struct({ id: M.ServerId, createdBy: P.UserId, status: P.Server.fields.status }),
            sql(
              "SELECT id,created_by AS createdBy,status FROM servers WHERE account_id=? AND deletion_requested_at IS NULL ORDER BY created_at LIMIT 3",
              [accountId],
            ),
          ),
        ],
        { concurrency: 2 },
      );
      return { paid: flags?.paid === 1, trial: flags?.trial === 1, servers };
    });
    return Model.Store.of({
      grant,
      spent,
      standing,
      admitted: Effect.fn("StarterStore.admitted")(function* (cohort, today) {
        const row = yield* one(
          Schema.Struct({ today: Schema.Int, total: Schema.Int }),
          sql(
            "SELECT COUNT(CASE WHEN reserved_day=? THEN 1 END) AS today,COUNT(*) AS total FROM starter_grants WHERE cohort=?",
            [today, cohort],
          ),
        );
        return { today: row?.today ?? 0, total: row?.total ?? 0 };
      }),
      // Mirrors the unpaid branch of platform/d1.ts `reserveServer`; keep the two in step.
      capacity: Effect.fn("StarterStore.capacity")(function* (owner, at, unlimited) {
        const window = Provisioning.windows(at);
        const row = yield* one(
          Schema.Struct({ owned: Schema.Int, recent: Schema.Int, today: Schema.Int }),
          sql(
            `WITH unlimited AS (SELECT value AS id FROM json_each(?))
             SELECT (SELECT COUNT(*) FROM servers s JOIN accounts a ON a.id=s.account_id
               WHERE a.created_by=? AND s.deletion_requested_at IS NULL AND s.account_id NOT IN (SELECT id FROM unlimited)
               AND NOT EXISTS(SELECT 1 FROM billing_periods p WHERE p.account_id=a.id AND p.start<=? AND p.end>?)) AS owned,
             MAX((SELECT COUNT(*) FROM servers WHERE created_by=? AND created_at>? AND account_id NOT IN (SELECT id FROM unlimited)),
               (SELECT COUNT(*) FROM servers s JOIN accounts a ON a.id=s.account_id
                 WHERE a.created_by=? AND s.created_at>? AND s.account_id NOT IN (SELECT id FROM unlimited))) AS recent,
             (SELECT COUNT(*) FROM servers WHERE admission_kind='unpaid' AND created_at>=?
               AND account_id NOT IN (SELECT id FROM unlimited)) AS today`,
            [
              JSON.stringify(unlimited),
              owner,
              at,
              at,
              owner,
              window.hour,
              owner,
              window.hour,
              window.day,
            ],
          ),
        );
        return { owned: row?.owned ?? 0, recent: row?.recent ?? 0, today: row?.today ?? 0 };
      }),
      reserve: Effect.fn("StarterStore.reserve")(function* (input) {
        const { keys, namespace } = input;
        const claim = (kind: string, key: string | null) =>
          sql(
            `INSERT INTO starter_claims(namespace,kind,key,grant_id,created_at)
             SELECT ?,?,?,id,? FROM starter_grants WHERE id=? AND ? IS NOT NULL`,
            [namespace, kind, key, input.at, input.grantId, key],
          );
        // Every check and every counter is evaluated inside this one transaction. Claim keys are
        // primary keys, so a racing claim that slipped past the checks aborts the whole batch.
        const written = yield* batch([
          sql(
            `INSERT INTO starter_grants(id,namespace,cohort,offer_version,account_id,organization_id,owner_id,request_key,server_name,allowance,reserved_at,reserved_day)
             SELECT ?,?,?,?,?,?,?,?,?,?,?,?
             WHERE NOT ${spentClause}
             AND NOT EXISTS(SELECT 1 FROM billing_periods WHERE account_id=?)
             AND (SELECT COUNT(*) FROM servers WHERE account_id=? AND deletion_requested_at IS NULL)<=1
             AND (SELECT COUNT(*) FROM starter_grants WHERE cohort=? AND reserved_day=?)<?
             AND (SELECT COUNT(*) FROM starter_grants WHERE cohort=?)<?
             ON CONFLICT(account_id) DO NOTHING`,
            [
              input.grantId,
              namespace,
              input.cohort,
              input.offerVersion,
              input.account.id,
              input.account.organizationId,
              keys.owner,
              input.requestKey,
              input.serverName,
              input.allowance,
              input.at,
              day(input.at),
              ...spentValues(namespace, keys),
              input.account.id,
              input.account.id,
              input.cohort,
              day(input.at),
              input.dailyLimit,
              input.cohort,
              input.cohortLimit,
            ],
          ),
          claim("owner", keys.owner),
          claim("inbox", keys.inbox),
          claim("organization", keys.organization),
          claim("account", keys.account),
          sql(
            `INSERT INTO starter_observations(grant_id,network_key,observed_at)
             SELECT id,?,? FROM starter_grants WHERE id=? ON CONFLICT(grant_id) DO NOTHING`,
            [input.networkKey, input.at, input.grantId],
          ),
        ]).pipe(Effect.result);
        const current = yield* grant(input.account.id);
        if (current !== null)
          return {
            kind: current.id === input.grantId ? ("reserved" as const) : ("resumed" as const),
            grant: current,
          };
        if (yield* spent(namespace, keys)) return { kind: "spent" as const };
        const facts = yield* standing(input.account.id);
        if (facts.paid || facts.servers.length > 1) return { kind: "ineligible" as const };
        if (Result.isFailure(written)) return yield* written.failure;
        return { kind: "full" as const };
      }),
      settle: Effect.fn("StarterStore.settle")(function* (grantId) {
        const unbound = "EXISTS(SELECT 1 FROM starter_grants WHERE id=? AND server_id IS NULL)";
        // One transaction: a server that exists is bound and nothing is deleted; otherwise the
        // grant, every claim it holds and its observation go together, freeing its admission slot.
        yield* batch([
          sql(
            `UPDATE starter_grants SET server_id=(${reservedServer})
             WHERE id=? AND server_id IS NULL AND EXISTS(${reservedServer})`,
            [grantId],
          ),
          sql(`DELETE FROM starter_claims WHERE grant_id=? AND ${unbound}`, [grantId, grantId]),
          sql(`DELETE FROM starter_observations WHERE grant_id=? AND ${unbound}`, [
            grantId,
            grantId,
          ]),
          sql("DELETE FROM starter_grants WHERE id=? AND server_id IS NULL", [grantId]),
        ]);
        return yield* one(
          Model.Grant,
          sql(`SELECT ${grantColumns} FROM starter_grants WHERE id=?`, [grantId]),
        );
      }),
      stranded: (before) =>
        all(
          Model.Grant,
          sql(
            `SELECT ${grantColumns} FROM starter_grants WHERE server_id IS NULL AND reserved_at<? ORDER BY reserved_at LIMIT 20`,
            [before],
          ),
        ),
      bind: (grantId, serverId) =>
        update(
          grantId,
          sql("UPDATE starter_grants SET server_id=? WHERE id=? AND server_id IS NULL", [
            serverId,
            grantId,
          ]),
        ),
      activate: (grantId, at) =>
        update(
          grantId,
          sql(
            "UPDATE starter_grants SET status='active',activated_at=COALESCE(activated_at,?) WHERE id=? AND server_id IS NOT NULL",
            [at, grantId],
          ),
        ),
      published: (grantId, at) =>
        batch([
          sql(
            "UPDATE starter_grants SET published_at=COALESCE(published_at,?) WHERE id=? AND status='active'",
            [at, grantId],
          ),
        ]).pipe(Effect.asVoid),
      remember: (namespace, grantId, inbox, at) =>
        batch([
          sql(
            `INSERT INTO starter_claims(namespace,kind,key,grant_id,created_at) VALUES(?,'inbox',?,?,?)
             ON CONFLICT DO NOTHING`,
            [namespace, inbox, grantId, at],
          ),
        ]).pipe(Effect.asVoid),
      unpublished: () =>
        all(
          Model.Grant,
          sql(
            `SELECT ${grantColumns} FROM starter_grants WHERE published_at IS NULL AND server_id IS NOT NULL ORDER BY reserved_at LIMIT 20`,
          ),
        ),
      forget: (before) =>
        batch([sql("DELETE FROM starter_observations WHERE observed_at<?", [before])]).pipe(
          Effect.asVoid,
        ),
    });
  });
