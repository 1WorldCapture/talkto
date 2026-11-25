import { Effect, Layer, Option, Schema, SchemaGetter, Encoding, Result } from "effect";
import * as B from "@talkto/api/billing";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as Model from "./model.js";
import * as Entitlements from "../account-entitlements.js";
import * as StarterConfiguration from "../starter/configuration.js";
import * as Platform from "./service.js";
import * as Provisioning from "./provisioning-policy.js";
import * as Telemetry from "../telemetry.js";
import * as GuestsD1 from "../guests/d1.js";

const accountColumns =
  "id, organization_id AS organizationId, name, created_by AS createdBy, created_at AS createdAt";
const serverColumns =
  "s.id, s.account_id AS accountId, s.name, s.created_by AS createdBy, s.created_at AS createdAt, s.status, s.board";
/** D1 keeps `servers.board` as 0 or 1 (migration 0027); a server shows `board: true` only when 1. */
const boardColumn = Schema.Literals([0, 1]).pipe(
  Schema.decodeTo(Schema.optionalKey(Schema.Literal(true)), {
    decode: SchemaGetter.transformOptional<true, 0 | 1>(
      Option.flatMap((n) => (n === 1 ? Option.some<true>(true) : Option.none())),
    ),
    encode: SchemaGetter.transformOptional<0 | 1, true>((board) =>
      Option.some(Option.isSome(board) ? 1 : 0),
    ),
  }),
);
const serverRow = Schema.Struct({ ...P.Server.fields, board: boardColumn });
const reservationRow = Schema.Struct({ ...Model.ServerReservation.fields, board: boardColumn });
const grantColumns =
  "id, server_id AS serverId, user_id AS userId, membership_id AS membershipId, principal_key AS principalKey, created_at AS createdAt, revoked_at AS revokedAt, revision, applied_revision AS appliedRevision";
const readableServer =
  "g.revoked_at IS NULL AND g.applied_revision=g.revision AND m.status='active' AND s.status='ready' AND s.deletion_requested_at IS NULL";
const managedServer = `(s.deletion_requested_at IS NULL AND (s.created_by=? OR (${readableServer})))`;
const unavailable = (cause?: unknown) =>
  Telemetry.withCause(
    new Model.Failure({
      code: "storage_unavailable",
      message: "Platform storage is temporarily unavailable.",
    }),
    cause,
  );
const missing = () =>
  new Model.Failure({
    code: "not_found",
    message: "The organization, server, or access grant is unavailable.",
  });
const conflict = () =>
  new Model.Failure({
    code: "idempotency_conflict",
    message: "The request key was already used for a different name.",
  });
/**
 * Where each rename target's name lives. Table names are constants, never input. An organization
 * is live once WorkOS created it and until its deletion; a server until its deletion.
 */
const renameTables = {
  organization: {
    table: "accounts",
    live: "organization_id IS NOT NULL AND deletion_requested_at IS NULL",
  },
  server: { table: "servers", live: "deletion_requested_at IS NULL" },
} as const;
/** The name a target was created with: its earliest rename's previous name, else its name. */
const createdName = (kind: Model.RenameTarget["kind"], alias: string) =>
  `COALESCE((SELECT r.previous_name FROM directory_renames r WHERE r.kind='${kind}' AND r.target_id=${alias}.id ORDER BY r.seq LIMIT 1),${alias}.name)`;
const currentColumns = (kind: Model.RenameTarget["kind"], alias: string) =>
  `${alias}.name,COALESCE((SELECT MAX(r.seq) FROM directory_renames r WHERE r.kind='${kind}' AND r.target_id=${alias}.id),0) AS revision,
  EXISTS(SELECT 1 FROM directory_renames r WHERE r.kind='${kind}' AND r.target_id=${alias}.id AND r.applied_at IS NULL) AS pending`;
const CurrentRow = Schema.Struct({
  ...Model.CurrentName.fields,
  pending: Schema.Literals([0, 1]),
});
const RenameTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("organization"), id: P.AccountId }),
  Schema.Struct({ kind: Schema.Literal("server"), id: M.ServerId }),
]);
const page = <A>(items: ReadonlyArray<A>, key: (item: A) => string, limit = 100): P.Page<A> => {
  const last = items[limit - 1];
  return {
    items: items.slice(0, limit),
    nextCursor: items.length > limit && last !== undefined ? key(last) : null,
  };
};

/**
 * Active membership snapshots this isolate has already written, per database. The upsert only moves
 * a row forward, so writing an identical active snapshot again changes nothing; skipping it saves a
 * D1 round trip on every account request. Each request still checks membership with WorkOS.
 */
const recorded = new WeakMap<D1Database, Set<string>>();
const snapshot = (member: P.Member) =>
  JSON.stringify([
    member.id,
    member.organizationId,
    member.userId,
    member.status,
    member.role,
    member.updatedAt,
  ]);

/** Native D1 adapter: bound SQL, atomic batches, and decoded rows. No messaging dependency. */
export const layer = (
  database: D1Database,
  configuration: Effect.Effect<Provisioning.Configuration, Model.Failure>,
) =>
  Layer.sync(Platform.Directory, () => {
    // Permission and mutation decisions always use the primary. Replicated discovery can be added independently.
    const db = database.withSession("first-primary");
    const sql = (query: string, values: ReadonlyArray<string | number | null> = []) =>
      db.prepare(query).bind(...values);
    const batch = Effect.fn("Directory.batch")(function* (
      statements: ReadonlyArray<D1PreparedStatement>,
    ) {
      yield* Effect.tryPromise({ try: () => db.batch([...statements]), catch: unavailable });
    });
    const all = Effect.fn("Directory.read")(function* <A>(
      schema: Schema.Decoder<A>,
      statement: D1PreparedStatement,
    ) {
      const result = yield* Effect.tryPromise({ try: () => statement.all(), catch: unavailable });
      return yield* Schema.decodeUnknownEffect(Schema.Array(schema))(result.results).pipe(
        Effect.mapError(() => unavailable()),
      );
    });
    const one = Effect.fn("Directory.find")(function* <A>(
      schema: Schema.Decoder<A>,
      statement: D1PreparedStatement,
    ) {
      return (yield* all(schema, statement))[0] ?? null;
    });
    /** Writes and a read of their outcome in one round trip: a batch is one transaction. */
    const writeThenFind = Effect.fn("Directory.writeThenFind")(function* <A>(
      schema: Schema.Decoder<A>,
      statements: ReadonlyArray<D1PreparedStatement>,
      read: D1PreparedStatement,
    ) {
      const results = yield* Effect.tryPromise({
        try: () => db.batch([...statements, read]),
        catch: unavailable,
      });
      return (
        (yield* Schema.decodeUnknownEffect(Schema.Array(schema))(results.at(-1)?.results).pipe(
          Effect.mapError(() => unavailable()),
        ))[0] ?? null
      );
    });
    const requireValue = <A>(value: A | null) =>
      value === null ? Effect.fail(missing()) : Effect.succeed(value);
    const accountStatement = (id: P.AccountId) =>
      sql(
        `SELECT ${accountColumns} FROM accounts WHERE id=? AND organization_id IS NOT NULL AND deletion_requested_at IS NULL`,
        [id],
      );
    const account = (id: P.AccountId) => one(P.Account, accountStatement(id));
    /** A live target's name, revision and organization; its one parameter is the target's ID. */
    const currentQuery = (kind: Model.RenameTarget["kind"]) =>
      kind === "organization"
        ? `SELECT ${currentColumns("organization", "a")},a.organization_id AS organizationId FROM accounts a WHERE a.id=? AND a.organization_id IS NOT NULL AND a.deletion_requested_at IS NULL`
        : `SELECT ${currentColumns("server", "s")},a.organization_id AS organizationId FROM servers s JOIN accounts a ON a.id=s.account_id WHERE s.id=? AND s.deletion_requested_at IS NULL`;
    const currentStatement = (target: Model.RenameTarget) =>
      sql(currentQuery(target.kind), [target.id]);
    const current = (row: typeof CurrentRow.Type): Model.CurrentName => ({
      ...row,
      pending: row.pending === 1,
    });
    const server = (id: M.ServerId) =>
      one(
        reservationRow,
        sql(
          `SELECT ${serverColumns}, a.organization_id AS organizationId, s.request_key AS requestKey, s.general_id AS generalId FROM servers s JOIN accounts a ON a.id=s.account_id WHERE s.id=? AND s.deletion_requested_at IS NULL`,
          [id],
        ),
      );
    const deletion = (id: M.ServerId) =>
      one(
        Model.ServerDeletion,
        sql(
          "SELECT id AS serverId,account_id AS accountId,created_by AS createdBy,deletion_completed_at AS completedAt FROM servers WHERE id=? AND deletion_requested_at IS NOT NULL",
          [id],
        ),
      );
    const grant = (id: M.ServerId, userId: P.UserId) =>
      one(
        Model.AccessCommand,
        sql(`SELECT ${grantColumns} FROM server_access WHERE server_id=? AND user_id=?`, [
          id,
          userId,
        ]),
      );
    const membershipStatements = (member: P.Member) => [
      // A deleted person, or an organization deleted with its owner, never gains rows again.
      sql(
        `INSERT INTO memberships(id,organization_id,user_id,status,role,updated_at) SELECT ?,?,?,?,?,?
      WHERE NOT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=?)
      AND NOT EXISTS(SELECT 1 FROM accounts WHERE organization_id=? AND deletion_requested_at IS NOT NULL)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,role=excluded.role,updated_at=excluded.updated_at
      WHERE excluded.updated_at > memberships.updated_at OR (excluded.updated_at=memberships.updated_at AND excluded.status IN ('inactive','deleted'))`,
        [
          member.id,
          member.organizationId,
          member.userId,
          member.status,
          member.role,
          member.updatedAt,
          member.userId,
          member.organizationId,
        ],
      ),
      sql(
        `UPDATE server_access SET revoked_at=MAX(created_at,?),revision=revision+1
      WHERE membership_id=? AND revoked_at IS NULL AND created_at<=? AND ? IN ('inactive','deleted')`,
        [member.updatedAt, member.id, member.updatedAt, member.status],
      ),
    ];
    const written = recorded.get(database) ?? new Set<string>();
    recorded.set(database, written);
    const record = Effect.fn("Directory.recordMemberships")(function* (
      members: ReadonlyArray<P.Member>,
    ) {
      const pending = members.filter(
        (member) => member.status !== "active" || !written.has(snapshot(member)),
      );
      if (pending.length === 0) return;
      yield* batch(pending.flatMap(membershipStatements));
      if (written.size > 10000) written.clear();
      for (const member of pending) if (member.status === "active") written.add(snapshot(member));
    });
    return Platform.Directory.of({
      guestPlaces: GuestsD1.places(database),
      reserveAccount: Effect.fn("Directory.reserveAccount")(function* (actor, input, at) {
        // One round trip: the insert does nothing when this request key already holds an account,
        // and missing limits insert nothing yet still find an account reserved earlier.
        const policy = yield* Effect.result(configuration);
        const value = yield* writeThenFind(
          Schema.Struct({ ...Model.AccountReservation.fields, createdName: M.ServerName }),
          Result.isFailure(policy)
            ? []
            : [
                sql(
                  `INSERT INTO accounts(id,name,created_by,request_key,created_at)
            SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM accounts WHERE created_by=? AND created_at>?)<?
            AND NOT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=?)
            ON CONFLICT(created_by,request_key) DO NOTHING`,
                  [
                    crypto.randomUUID(),
                    input.name,
                    actor.userId,
                    input.requestKey,
                    at,
                    actor.userId,
                    Provisioning.windows(at).hour,
                    policy.success.organizationsPerHour,
                    actor.userId,
                  ],
                ),
              ],
          sql(
            `SELECT ${accountColumns},request_key AS requestKey,${createdName("organization", "accounts")} AS createdName FROM accounts WHERE created_by=? AND request_key=?`,
            [actor.userId, input.requestKey],
          ),
        );
        if (value === null)
          return yield* Result.isFailure(policy) ? policy.failure : Provisioning.denied();
        // A retry after a rename still names the organization as it was created.
        const { createdName: requested, ...reservation } = value;
        if (requested !== input.name) return yield* conflict();
        return reservation;
      }),
      completeAccount: Effect.fn("Directory.completeAccount")(function* (id, organizationId) {
        return yield* writeThenFind(
          P.Account,
          [
            sql(
              "UPDATE accounts SET organization_id=? WHERE id=? AND (organization_id IS NULL OR organization_id=?)",
              [organizationId, id, organizationId],
            ),
          ],
          accountStatement(id),
        ).pipe(Effect.flatMap(requireValue));
      }),
      account,
      standing: Effect.fn("Directory.standing")(function* (id, at) {
        const policy = yield* configuration;
        // A paid period covering now wins, at the plan of its latest paid upgrade; otherwise the
        // plan chosen for an active trial.
        const current = yield* one(
          Schema.Struct({ plan: B.Plan }),
          sql(
            `SELECT plan FROM (
        SELECT COALESCE((SELECT c.plan FROM billing_plan_changes c WHERE c.account_id=p.account_id
          AND c.subscription_id=p.subscription_id AND c.period_end=p.end AND c.at>=p.start AND c.at<=?
          ORDER BY c.at DESC,CASE c.plan WHEN 'factory' THEN 2 WHEN 'studio' THEN 1 ELSE 0 END DESC LIMIT 1),p.plan) AS plan,0 AS rank,p.start AS start
        FROM billing_periods p WHERE p.account_id=? AND p.start<=? AND p.end>?
        UNION ALL
        SELECT o.plan,1 AS rank,t.start FROM billing_trials t JOIN billing_operations o ON o.id=t.operation_id
        WHERE t.account_id=? AND t.status='active' AND t.start<=? AND t.end>?
       ) ORDER BY rank,start DESC LIMIT 1`,
            [at, id, at, at, id, at, at],
          ),
        );
        // The Free plan: a claim made while Free was offered, or any free start while the switch
        // is on (it becomes Free at its next send). A paid plan or trial above wins.
        const free =
          current === null
            ? yield* one(
                Schema.Struct({ free: Schema.Int }),
                sql(
                  "SELECT 1 AS free FROM starter_grants WHERE account_id=? AND status='active' AND (offer_version=? OR ?=1) LIMIT 1",
                  [id, StarterConfiguration.freeOfferVersion, policy.freePlan ? 1 : 0],
                ),
              )
            : null;
        return {
          plan: current?.plan ?? null,
          unlimited: Entitlements.covers(policy.unlimitedAccounts, id),
          free: free !== null,
        };
      }),
      accounts: (userId, ids) =>
        all(
          Model.AccountSummary,
          sql(
            `SELECT ${accountColumns},
            (SELECT COUNT(*) FROM servers s
             LEFT JOIN server_access g ON g.server_id=s.id AND g.user_id=?
             LEFT JOIN memberships m ON m.id=g.membership_id
             WHERE s.account_id=accounts.id AND ${managedServer}) AS serverCount
            FROM accounts WHERE organization_id IN (SELECT value FROM json_each(?)) AND deletion_requested_at IS NULL ORDER BY id`,
            [userId, userId, JSON.stringify(ids)],
          ),
        ),
      recordMembership: (member) => record([member]),
      recordMemberships: record,
      removeMembership: (member, at) =>
        batch([
          ...membershipStatements(member),
          sql(
            "UPDATE server_access SET revoked_at=MAX(created_at,?),revision=revision+1 WHERE membership_id=? AND revoked_at IS NULL",
            [at, member.id],
          ),
        ]),
      pendingMembership: (id) =>
        all(
          Model.AccessCommand,
          sql(
            `SELECT ${grantColumns} FROM server_access WHERE membership_id=? AND applied_revision<revision AND server_id IN (SELECT id FROM servers WHERE deletion_requested_at IS NULL) ORDER BY server_id LIMIT 100`,
            [id],
          ),
        ),
      managedServers: Effect.fn("Directory.managedServers")(function* (userId, accountId, input) {
        const limit = input.limit ?? 100;
        let after: string | null = null;
        let query = input.query ?? "";
        const Cursor = Schema.Struct({
          accountId: P.AccountId,
          userId: P.UserId,
          after: M.ServerId,
          query: Schema.String,
        });
        const legacy = Schema.decodeUnknownResult(M.ServerId)(input.after);
        if (Result.isSuccess(legacy) && input.query === undefined) after = legacy.success;
        else if (input.after !== undefined) {
          const raw = Encoding.decodeBase64UrlString(input.after);
          if (Result.isFailure(raw))
            return yield* new Model.Failure({
              code: "invalid_input",
              message: "Invalid server directory continuation.",
            });
          const cursor = Schema.decodeUnknownResult(Schema.fromJsonString(Cursor))(raw.success);
          if (
            Result.isFailure(cursor) ||
            cursor.success.accountId !== accountId ||
            cursor.success.userId !== userId ||
            input.query !== undefined
          )
            return yield* new Model.Failure({
              code: "invalid_input",
              message: "Invalid server directory continuation.",
            });
          after = cursor.success.after;
          query = cursor.success.query;
        }
        const rows = yield* all(
          Schema.Struct({ ...serverRow.fields, readable: Schema.Int }),
          sql(
            `SELECT ${serverColumns}, CASE WHEN ${readableServer} THEN 1 ELSE 0 END AS readable
          FROM servers s LEFT JOIN server_access g ON g.server_id=s.id AND g.user_id=? LEFT JOIN memberships m ON m.id=g.membership_id
          WHERE s.account_id=? AND ${managedServer}
          AND (? IS NULL OR s.id>?) AND instr(lower(s.name),lower(?))>0 ORDER BY s.id LIMIT ?`,
            [userId, accountId, userId, after, after, query, limit + 1],
          ),
        );
        return page(
          rows.map(({ readable, ...server }) => ({
            ...server,
            permissions: {
              readMessages: readable === 1,
              manageAccess: server.createdBy === userId,
              resume: server.createdBy === userId && server.status === "provisioning",
            },
          })),
          (server) =>
            Encoding.encodeBase64Url(
              JSON.stringify({ accountId, userId, after: server.id, query }),
            ),
          limit,
        );
      }),
      reserveServer: Effect.fn("Directory.reserveServer")(
        function* (actor, account, member, input, at) {
          // One round trip: the insert does nothing when this request key already holds a server
          // (missing limits insert nothing), the first grant follows only a server of this name,
          // and the read reports the outcome.
          const policy = yield* Effect.result(configuration);
          const window = Provisioning.windows(at);
          const create = Result.isFailure(policy)
            ? []
            : [
                sql(
                  `WITH unlimited AS (SELECT value AS id FROM json_each(?)),
        paid AS (SELECT 1 FROM billing_periods WHERE account_id=? AND start<=? AND end>?)
        INSERT INTO servers(id,account_id,name,created_by,request_key,general_id,created_at,status,admission_kind,board)
        SELECT ?,?,?,?,?,?,?,'provisioning',CASE WHEN EXISTS(SELECT 1 FROM paid) THEN 'paid' ELSE 'unpaid' END,?
        WHERE EXISTS(SELECT 1 FROM memberships WHERE id=? AND status='active')
        AND (? IN (SELECT id FROM unlimited) OR (
        (SELECT COUNT(*) FROM servers WHERE account_id=? AND deletion_requested_at IS NULL)<?
        AND (SELECT COUNT(*) FROM servers WHERE created_by=? AND created_at>? AND account_id NOT IN (SELECT id FROM unlimited))<?
        AND (SELECT COUNT(*) FROM servers s JOIN accounts a ON a.id=s.account_id WHERE a.created_by=? AND s.created_at>? AND s.account_id NOT IN (SELECT id FROM unlimited))<?
        AND (
          EXISTS(SELECT 1 FROM paid)
          OR (
            ((NOT EXISTS(SELECT 1 FROM billing_trials WHERE account_id=?) AND NOT EXISTS(SELECT 1 FROM starter_grants WHERE account_id=?)) OR (SELECT COUNT(*) FROM servers WHERE account_id=? AND deletion_requested_at IS NULL)<1)
            AND (SELECT COUNT(*) FROM servers s JOIN accounts a ON a.id=s.account_id
              WHERE a.created_by=? AND s.deletion_requested_at IS NULL AND s.account_id NOT IN (SELECT id FROM unlimited) AND NOT EXISTS(SELECT 1 FROM billing_periods p WHERE p.account_id=a.id AND p.start<=? AND p.end>?))<?
            AND (SELECT COUNT(*) FROM servers WHERE admission_kind='unpaid' AND created_at>=? AND account_id NOT IN (SELECT id FROM unlimited))<?
          )
        )))
        ON CONFLICT(account_id,created_by,request_key) DO NOTHING`,
                  [
                    JSON.stringify(
                      Entitlements.forAccount(policy.success.unlimitedAccounts, account.id),
                    ),
                    account.id,
                    at,
                    at,
                    crypto.randomUUID(),
                    account.id,
                    input.name,
                    actor.userId,
                    input.requestKey,
                    crypto.randomUUID(),
                    at,
                    policy.success.boards && input.board === true ? 1 : 0,
                    member.id,
                    account.id,
                    account.id,
                    Provisioning.serverCap(policy.success, account.id),
                    actor.userId,
                    window.hour,
                    policy.success.serversPerHour,
                    account.createdBy,
                    window.hour,
                    policy.success.serversPerHour,
                    account.id,
                    account.id,
                    account.id,
                    account.createdBy,
                    at,
                    at,
                    policy.success.unpaidServers,
                    window.day,
                    policy.success.unpaidServersPerDay,
                  ],
                ),
              ];
          const found = yield* writeThenFind(
            Schema.Struct({
              ...reservationRow.fields,
              deleted: Schema.Int,
              createdName: M.ServerName,
            }),
            [
              ...create,
              sql(
                `INSERT INTO server_access(server_id,user_id,id,membership_id,principal_key,created_at,revision)
        SELECT s.id,?,?,?,?,s.created_at,1 FROM servers s WHERE s.account_id=? AND s.created_by=? AND s.request_key=? AND ${createdName("server", "s")}=? AND s.deletion_requested_at IS NULL
        AND EXISTS(SELECT 1 FROM memberships WHERE id=? AND status='active')
        ON CONFLICT(server_id,user_id) DO NOTHING`,
                [
                  member.userId,
                  crypto.randomUUID(),
                  member.id,
                  Model.actor(member.userId).principalKey,
                  account.id,
                  actor.userId,
                  input.requestKey,
                  input.name,
                  member.id,
                ],
              ),
            ],
            sql(
              `SELECT ${serverColumns}, a.organization_id AS organizationId, s.request_key AS requestKey, s.general_id AS generalId, s.deletion_requested_at IS NOT NULL AS deleted,${createdName("server", "s")} AS createdName FROM servers s JOIN accounts a ON a.id=s.account_id WHERE s.account_id=? AND s.created_by=? AND s.request_key=?`,
              [account.id, actor.userId, input.requestKey],
            ),
          );
          if (found === null) {
            // Name the safety cap when it is what refused the server.
            const policy = yield* configuration;
            const cap = Provisioning.serverCap(policy, account.id);
            const held = yield* one(
              Schema.Struct({ count: Schema.Int }),
              sql(
                "SELECT COUNT(*) AS count FROM servers WHERE account_id=? AND deletion_requested_at IS NULL",
                [account.id],
              ),
            );
            if (
              !Entitlements.covers(policy.unlimitedAccounts, account.id) &&
              (held?.count ?? 0) >= cap
            )
              return yield* Provisioning.serverLimitReached(cap);
            return yield* Provisioning.denied();
          }
          const { deleted, createdName: requested, ...value } = found;
          if (deleted === 1) return yield* missing();
          // A retry after a rename still names the server as it was created.
          if (requested !== input.name) return yield* conflict();
          return value;
        },
      ),
      server,
      ready: (id) =>
        batch([
          sql("UPDATE servers SET status='ready' WHERE id=? AND deletion_requested_at IS NULL", [
            id,
          ]),
        ]),
      rename: Effect.fn("Directory.rename")(function* (actor, target, input, at, limit) {
        const { table, live } = renameTables[target.kind];
        const id = crypto.randomUUID();
        const key = [target.kind, target.id, actor.userId, input.requestKey] as const;
        // One transaction: the record is written only for a new key and a different name (a
        // case-only change counts) while the target has had fewer than `limit.max` renames since
        // `limit.since`, so parallel renames cannot pass the limit together. The name follows only
        // that record, and the read reports both.
        const row = yield* writeThenFind(
          Schema.Struct({
            ...CurrentRow.fields,
            recordedId: Schema.NullOr(Schema.String),
            recordedName: Schema.NullOr(M.ServerName),
          }),
          [
            sql(
              `INSERT INTO directory_renames(id,kind,target_id,previous_name,name,renamed_by,request_key,renamed_at)
              SELECT ?,?,t.id,t.name,?,?,?,? FROM ${table} t WHERE t.id=? AND ${live} AND t.name<>?
              AND (SELECT COUNT(*) FROM directory_renames r WHERE r.kind=? AND r.target_id=t.id AND r.renamed_at>?)<?
              ON CONFLICT(kind,target_id,renamed_by,request_key) DO NOTHING`,
              [
                id,
                target.kind,
                input.name,
                actor.userId,
                input.requestKey,
                at,
                target.id,
                input.name,
                target.kind,
                limit.since,
                limit.max,
              ],
            ),
            sql(
              `UPDATE ${table} SET name=? WHERE id=? AND EXISTS(SELECT 1 FROM directory_renames WHERE id=?)`,
              [input.name, target.id, id],
            ),
          ],
          sql(
            `SELECT c.*,
            (SELECT id FROM directory_renames WHERE kind=? AND target_id=? AND renamed_by=? AND request_key=?) AS recordedId,
            (SELECT name FROM directory_renames WHERE kind=? AND target_id=? AND renamed_by=? AND request_key=?) AS recordedName
            FROM (${currentQuery(target.kind)}) c`,
            [...key, ...key, target.id],
          ),
        );
        if (row === null) return yield* missing();
        const { recordedId, recordedName, ...value } = row;
        const now = current(value);
        // No record: the name was already exactly this, and nothing changed; or another name was
        // refused by the limit.
        if (recordedId === null)
          return now.name === input.name ? { changed: false, current: now } : "limited";
        if (recordedName !== input.name) return yield* conflict();
        return { changed: recordedId === id, current: now };
      }),
      renamesSince: Effect.fn("Directory.renamesSince")(function* (target, since) {
        const row = yield* one(
          Schema.Struct({ count: Schema.Number, earliest: Schema.NullOr(M.Timestamp) }),
          sql(
            "SELECT COUNT(*) AS count, MIN(renamed_at) AS earliest FROM directory_renames WHERE kind=? AND target_id=? AND renamed_at>?",
            [target.kind, target.id, since],
          ),
        );
        return row ?? { count: 0, earliest: null };
      }),
      currentName: Effect.fn("Directory.currentName")(function* (target) {
        const row = yield* one(CurrentRow, currentStatement(target));
        return row === null ? null : current(row);
      }),
      nameApplied: (target, revision, at) =>
        batch([
          sql(
            "UPDATE directory_renames SET applied_at=? WHERE kind=? AND target_id=? AND seq<=? AND applied_at IS NULL",
            [at, target.kind, target.id, revision],
          ),
        ]),
      pendingNames: () =>
        all(
          RenameTarget,
          sql(
            `SELECT kind,target_id AS id FROM directory_renames WHERE applied_at IS NULL
            AND ((kind='organization' AND target_id IN (SELECT id FROM accounts WHERE ${renameTables.organization.live}))
              OR (kind='server' AND target_id IN (SELECT id FROM servers WHERE ${renameTables.server.live})))
            GROUP BY kind,target_id ORDER BY MIN(seq) LIMIT 20`,
          ),
        ),
      serverRenames: (id, limit) =>
        all(
          Model.ServerRenameRecord,
          sql(
            "SELECT id,previous_name AS previousName,name,renamed_at AS renamedAt,renamed_by AS renamedBy FROM directory_renames WHERE kind='server' AND target_id=? ORDER BY seq DESC LIMIT ?",
            [id, limit],
          ),
        ),
      deletion,
      beginDeletion: Effect.fn("Directory.beginDeletion")(function* (id, at) {
        yield* batch([
          sql(
            "UPDATE servers SET deletion_requested_at=COALESCE(deletion_requested_at,?) WHERE id=?",
            [at, id],
          ),
        ]);
        return yield* deletion(id).pipe(Effect.flatMap(requireValue));
      }),
      finishDeletion: (id, at) =>
        batch([
          sql(
            "UPDATE user_onboarding SET state=json_set(state,'$.run',NULL,'$.revision',revision+1),revision=revision+1,updated_at=? WHERE json_extract(state,'$.run.setup.serverId')=? OR (json_extract(state,'$.run.setup.kind')='creating' AND user_id IN (SELECT created_by FROM servers WHERE id=?) AND ('onboarding:' || json_extract(state,'$.run.id') || ':server') IN (SELECT request_key FROM servers WHERE id=?))",
            [at, id, id, id],
          ),
          sql(
            "DELETE FROM server_access WHERE server_id=? AND EXISTS(SELECT 1 FROM servers WHERE id=? AND deletion_requested_at IS NOT NULL)",
            [id, id],
          ),
          sql(
            "DELETE FROM activity_progress WHERE server_id=? AND EXISTS(SELECT 1 FROM servers WHERE id=? AND deletion_requested_at IS NOT NULL)",
            [id, id],
          ),
          // Agent invites (docs/agent-invites.md): the server's links, waiting list and mode.
          ...["agent_invite_requests", "agent_invites", "server_invite_modes"].map((table) =>
            sql(
              `DELETE FROM ${table} WHERE server_id=? AND EXISTS(SELECT 1 FROM servers WHERE id=? AND deletion_requested_at IS NOT NULL)`,
              [id, id],
            ),
          ),
          // Earlier names go with the name: the tombstone keeps no content.
          sql(
            "DELETE FROM directory_renames WHERE kind='server' AND target_id=? AND EXISTS(SELECT 1 FROM servers WHERE id=? AND deletion_requested_at IS NOT NULL)",
            [id, id],
          ),
          sql(
            "UPDATE servers SET name='Deleted server',deletion_completed_at=COALESCE(deletion_completed_at,?) WHERE id=? AND deletion_requested_at IS NOT NULL",
            [at, id],
          ),
        ]),
      pendingDeletions: () =>
        all(
          Model.ServerDeletion,
          sql(
            "SELECT id AS serverId,account_id AS accountId,created_by AS createdBy,deletion_completed_at AS completedAt FROM servers WHERE deletion_requested_at IS NOT NULL AND deletion_completed_at IS NULL ORDER BY deletion_requested_at LIMIT 20",
          ),
        ),
      discover: Effect.fn("Directory.discover")(function* (userId, after) {
        const items = yield* all(
          serverRow,
          sql(
            `SELECT ${serverColumns} FROM servers s JOIN server_access g ON g.server_id=s.id
        JOIN memberships m ON m.id=g.membership_id WHERE g.user_id=? AND g.revoked_at IS NULL AND g.applied_revision=g.revision
        AND m.status='active' AND s.status='ready' AND s.deletion_requested_at IS NULL AND (? IS NULL OR s.id>?) ORDER BY s.id LIMIT 101`,
            [userId, after ?? null, after ?? null],
          ),
        );
        return page(items, (item) => item.id);
      }),
      grants: Effect.fn("Directory.grants")(function* (id, after) {
        return page(
          yield* all(
            Model.AccessCommand,
            sql(
              `SELECT ${grantColumns} FROM server_access WHERE server_id=? AND (? IS NULL OR user_id>?) ORDER BY user_id LIMIT 101`,
              [id, after ?? null, after ?? null],
            ),
          ),
          (item) => item.userId,
        );
      }),
      grant,
      existingGrantees: Effect.fn("Directory.existingGrantees")(function* (id, userIds) {
        const rows = yield* all(
          Schema.Struct({ userId: P.UserId }),
          sql(
            "SELECT user_id AS userId FROM server_access WHERE server_id=? AND user_id IN (SELECT value FROM json_each(?))",
            [id, JSON.stringify(userIds)],
          ),
        );
        return rows.map((row) => row.userId);
      }),
      allow: Effect.fn("Directory.allow")(function* (id, member, at) {
        yield* batch([
          sql(
            `INSERT INTO server_access(server_id,user_id,id,membership_id,principal_key,created_at,revision)
        SELECT ?,?,?,?,?,?,1 WHERE EXISTS(SELECT 1 FROM memberships WHERE id=? AND status='active') AND EXISTS(SELECT 1 FROM servers WHERE id=? AND deletion_requested_at IS NULL)
        ON CONFLICT(server_id,user_id) DO UPDATE SET id=excluded.id,membership_id=excluded.membership_id,created_at=excluded.created_at,
        revoked_at=NULL,revision=server_access.revision+1 WHERE server_access.revoked_at IS NOT NULL`,
            [
              id,
              member.userId,
              crypto.randomUUID(),
              member.id,
              Model.actor(member.userId).principalKey,
              at,
              member.id,
              id,
            ],
          ),
        ]);
        const result = yield* grant(id, member.userId).pipe(Effect.flatMap(requireValue));
        if (result.revokedAt !== null) return yield* missing();
        return result;
      }),
      revoke: Effect.fn("Directory.revoke")(function* (id, userId, at) {
        yield* batch([
          sql(
            "UPDATE server_access SET revoked_at=MAX(created_at,?),revision=revision+1 WHERE server_id=? AND user_id=? AND revoked_at IS NULL",
            [at, id, userId],
          ),
        ]);
        return yield* grant(id, userId).pipe(Effect.flatMap(requireValue));
      }),
      applied: (command) =>
        batch([
          sql(
            "UPDATE server_access SET applied_revision=MAX(applied_revision,?) WHERE server_id=? AND user_id=? AND revision>=?",
            [command.revision, command.serverId, command.userId, command.revision],
          ),
        ]),
      pending: Effect.fn("Directory.pending")(function* () {
        const commands = yield* all(
          Model.AccessCommand,
          sql(
            `SELECT ${grantColumns} FROM server_access WHERE applied_revision<revision AND server_id IN (SELECT id FROM servers WHERE deletion_requested_at IS NULL) ORDER BY attempted_at,server_id,user_id LIMIT 100`,
          ),
        );
        if (commands.length > 0)
          yield* batch([
            sql(
              "UPDATE server_access SET attempted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (SELECT value FROM json_each(?))",
              [JSON.stringify(commands.map((c) => c.id))],
            ),
          ]);
        return commands;
      }),
      syncPosition: () =>
        one(
          Schema.Struct({ cursor: Schema.NullOr(Schema.String), startedAt: M.Timestamp }),
          sql("SELECT cursor,started_at AS startedAt FROM identity_sync WHERE singleton=1"),
        ).pipe(Effect.flatMap(requireValue)),
      consume: Effect.fn("Directory.consume")(function* (event, previous, at) {
        const updates: D1PreparedStatement[] = [];
        switch (event.kind) {
          case "membership":
            updates.push(...membershipStatements(event.member));
            break;
          case "user_deleted":
            updates.push(
              sql(
                "UPDATE memberships SET status='deleted',updated_at=MAX(updated_at,?) WHERE user_id=?",
                [event.at, event.userId],
              ),
            );
            updates.push(
              sql(
                "UPDATE server_access SET revoked_at=MAX(created_at,?),revision=revision+1 WHERE user_id=? AND revoked_at IS NULL",
                [event.at, event.userId],
              ),
            );
            // Their API keys stop too (epoch milliseconds in api_keys).
            updates.push(
              sql(
                "UPDATE api_keys SET revoked_at=CAST(unixepoch(?,'subsec')*1000 AS INTEGER) WHERE user_id=? AND revoked_at IS NULL",
                [event.at, event.userId],
              ),
            );
            break;
          case "organization_deleted":
            updates.push(
              sql(
                "UPDATE memberships SET status='deleted',updated_at=MAX(updated_at,?) WHERE organization_id=?",
                [event.at, event.organizationId],
              ),
            );
            updates.push(
              sql(
                "UPDATE server_access SET revoked_at=MAX(created_at,?),revision=revision+1 WHERE revoked_at IS NULL AND membership_id IN (SELECT id FROM memberships WHERE organization_id=?)",
                [event.at, event.organizationId],
              ),
            );
            break;
        }
        updates.push(
          sql(
            "UPDATE identity_sync SET cursor=?,last_success_at=? WHERE singleton=1 AND cursor IS ?",
            [event.id, at, previous],
          ),
        );
        yield* batch(updates);
      }),
    });
  });
