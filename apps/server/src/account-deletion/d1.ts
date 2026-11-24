import { Effect, Layer, Schema } from "effect";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as B from "@talkto/api/billing";
import * as Model from "../platform/model.js";
import * as AccountDeletion from "./service.js";
import * as Telemetry from "../telemetry.js";

const unavailable = (cause?: unknown) =>
  Telemetry.withCause(
    new Model.Failure({
      code: "storage_unavailable",
      message: "Platform storage is temporarily unavailable.",
    }),
    cause,
  );
// Revocations the person's surviving servers have not yet confirmed. Erased servers need none.
const unconfirmed =
  "SELECT 1 FROM server_access WHERE user_id=? AND applied_revision<revision AND server_id IN (SELECT id FROM servers WHERE deletion_requested_at IS NULL)";
// Organizations marked for deletion with this person whose tombstone is not final.
const openOrganizations =
  "SELECT 1 FROM accounts WHERE created_by=? AND deletion_requested_at IS NOT NULL AND deletion_completed_at IS NULL";

const organizationColumns =
  "id,organization_id AS organizationId,name,created_by AS createdBy,deletion_requested_at AS requestedAt,deletion_completed_at AS completedAt";

/** Native D1 adapter for account deletion; every write is conditional, so retries are safe. */
export const layer = (database: D1Database) =>
  Layer.sync(AccountDeletion.Store, () => {
    const db = database.withSession("first-primary");
    const sql = (query: string, values: ReadonlyArray<string | number | null> = []) =>
      db.prepare(query).bind(...values);
    const batch = (statements: ReadonlyArray<D1PreparedStatement>) =>
      Effect.tryPromise({ try: () => db.batch([...statements]), catch: unavailable });
    const all = Effect.fn("AccountDeletionStore.read")(function* <A>(
      schema: Schema.Decoder<A>,
      statement: D1PreparedStatement,
    ) {
      const result = yield* Effect.tryPromise({ try: () => statement.all(), catch: unavailable });
      return yield* Schema.decodeUnknownEffect(Schema.Array(schema))(result.results).pipe(
        Effect.mapError(() => unavailable()),
      );
    });
    const deletion = Effect.fn("AccountDeletionStore.deletion")(function* (userId: P.UserId) {
      const rows = yield* all(
        AccountDeletion.Deletion,
        sql(
          "SELECT user_id AS userId,requested_at AS requestedAt,user_deleted_at AS userDeletedAt,completed_at AS completedAt FROM account_deletions WHERE user_id=?",
          [userId],
        ),
      );
      return rows[0] ?? null;
    });
    return AccountDeletion.Store.of({
      deletion,
      owned: (userId) =>
        all(
          AccountDeletion.Owned,
          sql(
            `SELECT a.id,a.organization_id AS organizationId,a.name,
            (SELECT COUNT(*) FROM servers s WHERE s.account_id=a.id AND s.deletion_requested_at IS NULL) AS servers,
            (SELECT CASE WHEN json_extract(b.subscription_json,'$.status') NOT IN ('canceled','incomplete_expired')
              THEN json_extract(b.subscription_json,'$.plan') END FROM workspace_billing b WHERE b.account_id=a.id) AS plan
            FROM accounts a WHERE a.created_by=? AND a.deletion_requested_at IS NULL ORDER BY a.created_at,a.id`,
            [userId],
          ),
        ),
      created: (userId) =>
        all(
          AccountDeletion.Created,
          sql(
            `SELECT s.id AS serverId,s.name,a.id AS accountId,a.organization_id AS organizationId,a.name AS organization
            FROM servers s JOIN accounts a ON a.id=s.account_id
            WHERE s.created_by=? AND a.created_by<>? AND s.deletion_requested_at IS NULL AND a.deletion_requested_at IS NULL
            ORDER BY a.name,s.name,s.id`,
            [userId, userId],
          ),
        ),
      begin: (userId, accounts, at) => {
        const ids = JSON.stringify(accounts);
        return batch([
          sql(
            "INSERT INTO account_deletions(user_id,requested_at) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING",
            [userId, at],
          ),
          sql(
            "UPDATE accounts SET deletion_requested_at=COALESCE(deletion_requested_at,?) WHERE created_by=? AND id IN (SELECT value FROM json_each(?))",
            [at, userId, ids],
          ),
          // Out of discovery at once; each erasure follows the server-deletion protocol.
          sql(
            "UPDATE servers SET deletion_requested_at=COALESCE(deletion_requested_at,?) WHERE account_id IN (SELECT id FROM accounts WHERE created_by=? AND id IN (SELECT value FROM json_each(?)))",
            [at, userId, ids],
          ),
          // Access revoked earlier is delivered again too, so every server the person used renames
          // their person participant (`forgetPerson`).
          sql(
            "UPDATE server_access SET revoked_at=COALESCE(revoked_at,MAX(created_at,?)),revision=revision+1 WHERE user_id=?",
            [at, userId],
          ),
          sql(
            "UPDATE memberships SET status='deleted',updated_at=MAX(updated_at,?) WHERE user_id=?",
            [at, userId],
          ),
        ]).pipe(Effect.asVoid);
      },
      userDeleted: (userId, at) =>
        batch([
          sql(
            "UPDATE account_deletions SET user_deleted_at=COALESCE(user_deleted_at,?) WHERE user_id=?",
            [at, userId],
          ),
        ]).pipe(Effect.asVoid),
      deleting: (userId) =>
        all(
          Model.AccountTombstone,
          sql(
            "SELECT id,organization_id AS organizationId FROM accounts WHERE created_by=? AND deletion_requested_at IS NOT NULL AND deletion_completed_at IS NULL ORDER BY id",
            [userId],
          ),
        ),
      servers: Effect.fn("AccountDeletionStore.servers")(function* (accountId) {
        const rows = yield* all(
          Schema.Struct({ id: M.ServerId }),
          sql("SELECT id FROM servers WHERE account_id=? AND deletion_completed_at IS NULL", [
            accountId,
          ]),
        );
        return rows.map((row) => row.id);
      }),
      finishOrganization: (accountId, at) =>
        batch([
          sql(
            "DELETE FROM memberships WHERE organization_id=(SELECT organization_id FROM accounts WHERE id=? AND deletion_requested_at IS NOT NULL)",
            [accountId],
          ),
          // Earlier names go with the name: the tombstone keeps no content.
          sql(
            "DELETE FROM directory_renames WHERE kind='organization' AND target_id=? AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND deletion_requested_at IS NOT NULL)",
            [accountId, accountId],
          ),
          sql(
            "UPDATE accounts SET name='Deleted organization',deletion_completed_at=COALESCE(deletion_completed_at,?) WHERE id=? AND deletion_requested_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM servers WHERE account_id=? AND deletion_completed_at IS NULL)",
            [at, accountId, accountId],
          ),
        ]).pipe(Effect.asVoid),
      pendingAccess: (userId) =>
        all(
          Model.AccessCommand,
          sql(
            `SELECT id,server_id AS serverId,user_id AS userId,membership_id AS membershipId,principal_key AS principalKey,created_at AS createdAt,revoked_at AS revokedAt,revision,applied_revision AS appliedRevision
            FROM server_access WHERE user_id=? AND applied_revision<revision AND server_id IN (SELECT id FROM servers WHERE deletion_requested_at IS NULL) ORDER BY server_id LIMIT 100`,
            [userId],
          ),
        ),
      finish: Effect.fn("AccountDeletionStore.finish")(function* (userId, at) {
        const ready = `NOT EXISTS(${unconfirmed}) AND NOT EXISTS(${openOrganizations})`;
        yield* batch([
          // Hand each surviving server the person created to its organization's owner. A request
          // key the owner already used in that organization keeps the row unchanged.
          sql(
            `UPDATE OR IGNORE servers SET created_by=(SELECT a.created_by FROM accounts a WHERE a.id=servers.account_id)
            WHERE created_by=? AND deletion_requested_at IS NULL AND ${ready}`,
            [userId, userId, userId],
          ),
          sql(`DELETE FROM server_access WHERE user_id=? AND ${ready}`, [userId, userId, userId]),
          // Renames the person made in other people's organizations stay, no longer naming them.
          sql(`UPDATE directory_renames SET renamed_by=NULL WHERE renamed_by=? AND ${ready}`, [
            userId,
            userId,
            userId,
          ]),
          sql(`DELETE FROM memberships WHERE user_id=? AND ${ready}`, [userId, userId, userId]),
          sql(`DELETE FROM user_onboarding WHERE user_id=? AND ${ready}`, [userId, userId, userId]),
          // TalkTo's own email (docs/email.md): the person's choice and their queued or sent records.
          sql(`DELETE FROM email_preferences WHERE user_id=? AND ${ready}`, [
            userId,
            userId,
            userId,
          ]),
          sql(`DELETE FROM email_outbox WHERE user_id=? AND ${ready}`, [userId, userId, userId]),
          // Signed-in computers: where the person's agent apps signed in, and their sign-outs.
          sql(`DELETE FROM mcp_client_sessions WHERE user_id=? AND ${ready}`, [
            userId,
            userId,
            userId,
          ]),
          sql(`DELETE FROM mcp_revocations WHERE user_id=? AND ${ready}`, [userId, userId, userId]),
          // Feedback and bug reports the person sent (docs/feedback.md).
          sql(`DELETE FROM feedback WHERE user_id=? AND ${ready}`, [userId, userId, userId]),
          // Their emails first (docs/email.md, "Server invitations"): an invitation's own rows
          // name the inviter, the inviter's "joined" email names the person who accepted, and an
          // "organization deleted" email names the owner who deleted it.
          sql(
            `DELETE FROM email_outbox WHERE (user_id IN (SELECT id FROM server_invitations WHERE inviter_id=? OR accepted_user_id=?)
             OR key IN (SELECT 'server_joined:'||id FROM server_invitations WHERE accepted_user_id=?)
             OR (key LIKE 'organization_deleted:%' AND account_id IN (SELECT id FROM accounts WHERE created_by=?))) AND ${ready}`,
            [userId, userId, userId, userId, userId, userId],
          ),
          // Server guest invitations the person sent or accepted (docs/dashboard-api.md).
          sql(
            `DELETE FROM server_invitations WHERE (inviter_id=? OR accepted_user_id=?) AND ${ready}`,
            [userId, userId, userId, userId],
          ),
          sql(
            `UPDATE account_deletions SET completed_at=COALESCE(completed_at,?) WHERE user_id=? AND user_deleted_at IS NOT NULL AND ${ready}`,
            [at, userId, userId, userId],
          ),
        ]);
        const value = yield* deletion(userId);
        return value !== null && value.completedAt !== null;
      }),
      pending: Effect.fn("AccountDeletionStore.pending")(function* () {
        const rows = yield* all(
          Schema.Struct({ userId: P.UserId }),
          sql(
            "SELECT user_id AS userId FROM account_deletions WHERE completed_at IS NULL ORDER BY requested_at LIMIT 10",
          ),
        );
        return rows.map((row) => row.userId);
      }),
      organization: Effect.fn("AccountDeletionStore.organization")(function* (accountId) {
        const rows = yield* all(
          AccountDeletion.Organization,
          sql(`SELECT ${organizationColumns} FROM accounts WHERE id=?`, [accountId]),
        );
        return rows[0] ?? null;
      }),
      organizationFacts: Effect.fn("AccountDeletionStore.organizationFacts")(
        function* (accountId, at) {
          const servers = yield* all(
            Schema.Struct({ id: M.ServerId, name: M.ServerName }),
            sql(
              "SELECT id,name FROM servers WHERE account_id=? AND deletion_requested_at IS NULL ORDER BY name,id",
              [accountId],
            ),
          );
          const facts = yield* all(
            Schema.Struct({
              guests: M.Count,
              serverInvitations: M.Count,
              plan: Schema.NullOr(B.Plan),
              paidThrough: Schema.NullOr(M.Timestamp),
              freeStart: Schema.Literals([0, 1]),
            }),
            sql(
              `SELECT
              (SELECT COUNT(DISTINCT m.user_id) FROM memberships m WHERE m.organization_id=a.organization_id AND m.status='active' AND substr(m.id,1,8)='om_guest'
                AND NOT EXISTS(SELECT 1 FROM memberships w WHERE w.organization_id=m.organization_id AND w.user_id=m.user_id AND w.status='active' AND substr(w.id,1,8)<>'om_guest')) AS guests,
              (SELECT COUNT(*) FROM server_invitations i JOIN servers s ON s.id=i.server_id AND s.deletion_requested_at IS NULL
                WHERE i.account_id=a.id AND i.state='pending' AND i.expires_at>?) AS serverInvitations,
              (SELECT json_extract(b.subscription_json,'$.plan') FROM workspace_billing b WHERE b.account_id=a.id
                AND json_extract(b.subscription_json,'$.status') IN ('trialing','active','past_due','unpaid','paused')) AS plan,
              (SELECT MAX(p.end) FROM billing_periods p WHERE p.account_id=a.id AND p.start<=? AND p.end>?) AS paidThrough,
              EXISTS(SELECT 1 FROM starter_grants g WHERE g.account_id=a.id) OR EXISTS(SELECT 1 FROM billing_trials t WHERE t.account_id=a.id AND t.status='active') AS freeStart
              FROM accounts a WHERE a.id=?`,
              [at, at, at, accountId],
            ),
          );
          const value = facts[0];
          if (value === undefined) return yield* unavailable();
          return { ...value, servers, freeStart: value.freeStart === 1 };
        },
      ),
      beginOrganization: (accountId, userId, at) =>
        batch([
          sql(
            "UPDATE accounts SET deletion_requested_at=COALESCE(deletion_requested_at,?),deletion_requested_by=COALESCE(deletion_requested_by,?) WHERE id=? AND created_by=? AND deletion_completed_at IS NULL",
            [at, userId, accountId, userId],
          ),
          // Out of discovery at once; each erasure follows the server-deletion protocol.
          sql(
            "UPDATE servers SET deletion_requested_at=COALESCE(deletion_requested_at,?) WHERE account_id=? AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND created_by=? AND deletion_requested_at IS NOT NULL)",
            [at, accountId, accountId, userId],
          ),
        ]).pipe(Effect.asVoid),
      deletingOrganizations: () =>
        all(
          AccountDeletion.Organization,
          sql(
            `SELECT ${organizationColumns} FROM accounts WHERE deletion_requested_by IS NOT NULL AND deletion_completed_at IS NULL ORDER BY deletion_requested_at LIMIT 10`,
          ),
        ),
    });
  });
