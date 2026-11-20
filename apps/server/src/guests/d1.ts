import { DateTime, Effect, Layer, Schema } from "effect";
import * as G from "@talkto/api/guests";
import * as M from "@talkto/api/models";
import * as Platform from "../platform/model.js";
import type * as People from "../platform/people.js";
import * as Telemetry from "../telemetry.js";
import * as Model from "./model.js";

/*
  Server guests in D1 (platform migration 0023). Guest memberships are rows of `memberships` with
  an `om_guest…` ID and role `guest`, written only here; WorkOS IDs start with `om_01`.
*/

const unavailable = (cause?: unknown) =>
  Telemetry.withCause(
    new Platform.Failure({
      code: "storage_unavailable",
      message: "Server invitations are temporarily unavailable.",
    }),
    cause,
  );
const rowColumns = `i.id,i.server_id AS serverId,i.account_id AS accountId,i.organization_id AS organizationId,
 i.inviter_id AS inviterId,i.member_id AS memberId,i.email,i.email_key AS emailKey,i.state,i.created_at AS createdAt,i.sent_at AS sentAt,
 i.sends,i.expires_at AS expiresAt,i.accepted_user_id AS acceptedUserId,i.accepted_at AS acceptedAt,
 i.canceled_at AS canceledAt`;
const foundColumns = `${rowColumns},s.name AS serverName,a.name AS organizationName,
 CASE WHEN s.status='ready' AND s.deletion_requested_at IS NULL AND a.deletion_requested_at IS NULL THEN 1 ELSE 0 END AS live`;
const foundFrom =
  "server_invitations i JOIN servers s ON s.id=i.server_id JOIN accounts a ON a.id=i.account_id";
/** A guest membership: TalkTo's own row, never a WorkOS one. */
const guestMembership = (alias: string) => `substr(${alias}.id,1,8)='om_guest'`;
/** The user, in `alias`, is also an active member of the organization through WorkOS. */
const alsoMember = (alias: string) =>
  `EXISTS(SELECT 1 FROM memberships w WHERE w.organization_id=${alias}.organization_id AND w.user_id=${alias}.user_id AND w.status='active' AND NOT ${guestMembership("w")})`;
/**
 * Guests who hold a place in organization `?1`: an active guest membership, access to at least one
 * live server, and no active WorkOS membership in the same organization (that one counts already).
 */
const counted = `SELECT DISTINCT m.user_id AS userId FROM memberships m
 JOIN server_access g ON g.membership_id=m.id AND g.revoked_at IS NULL
 JOIN servers s ON s.id=g.server_id AND s.deletion_requested_at IS NULL
 WHERE m.organization_id=?1 AND m.status='active' AND ${guestMembership("m")} AND NOT ${alsoMember("m")}`;
/**
 * Addresses with a live invitation in organization `?1` at `?2`, minus addresses of counted guests
 * and of active members (counted already).
 */
const invited = `SELECT DISTINCT i.email_key AS emailKey FROM server_invitations i
 JOIN servers s ON s.id=i.server_id AND s.deletion_requested_at IS NULL
 WHERE i.organization_id=?1 AND i.state='pending' AND i.expires_at>?2
 AND NOT (i.member_id IS NOT NULL AND EXISTS(SELECT 1 FROM memberships w WHERE w.organization_id=i.organization_id
  AND w.user_id=i.member_id AND w.status='active' AND NOT ${guestMembership("w")}))
 AND NOT EXISTS(SELECT 1 FROM server_invitations d WHERE d.organization_id=i.organization_id
  AND d.email_key=i.email_key AND d.state='accepted' AND d.accepted_user_id IN (SELECT userId FROM guests))`;

const read = <A>(schema: Schema.Decoder<A>, statement: D1PreparedStatement) =>
  Effect.tryPromise({ try: () => statement.all(), catch: unavailable }).pipe(
    Effect.flatMap((result) =>
      Schema.decodeUnknownEffect(Schema.Array(schema))(result.results).pipe(
        Effect.mapError(() => unavailable()),
      ),
    ),
  );

/**
 * Places server guests hold in an organization's people limit: guests counted once however many
 * servers they can open, and each other address with a pending, unexpired invitation.
 */
export const places =
  (database: D1Database): People.GuestPlaces =>
  (organizationId, at) =>
    read(
      Schema.Struct({ count: Schema.Int }),
      database
        .withSession("first-primary")
        .prepare(
          `WITH guests AS (${counted}), addresses AS (${invited})
           SELECT (SELECT COUNT(*) FROM guests) + (SELECT COUNT(*) FROM addresses) AS count`,
        )
        .bind(organizationId, at),
    ).pipe(Effect.map((rows) => rows[0]?.count ?? 0));

/** Delete invitations 30 days after they were accepted, canceled or expired (minute cron). */
export const prune = Effect.fn("Guests.prune")(function* (database: D1Database, at: M.Timestamp) {
  const before = M.Timestamp.make(
    DateTime.formatIso(DateTime.subtract(DateTime.makeUnsafe(at), { days: G.retentionDays })),
  );
  yield* Effect.tryPromise({
    try: () =>
      database
        .withSession("first-primary")
        .prepare(
          `DELETE FROM server_invitations WHERE id IN (SELECT id FROM server_invitations
           WHERE (state='accepted' AND accepted_at<?1) OR (state='canceled' AND canceled_at<?1)
           OR (state='pending' AND expires_at<?1) LIMIT 500)`,
        )
        .bind(before)
        .run(),
    catch: unavailable,
  });
});

/** The D1 adapter for every guest record. */
export const layer = (database: D1Database) =>
  Layer.sync(Model.Store, () => {
    const db = database.withSession("first-primary");
    const sql = (query: string, values: ReadonlyArray<string | number | null> = []) =>
      db.prepare(query).bind(...values);
    const batch = (statements: ReadonlyArray<D1PreparedStatement>) =>
      Effect.tryPromise({ try: () => db.batch([...statements]), catch: unavailable });
    const row = (statement: D1PreparedStatement) =>
      read(Model.Row, statement).pipe(Effect.map((rows) => rows[0] ?? null));
    const byId = (id: G.InvitationId) =>
      row(sql(`SELECT ${rowColumns} FROM server_invitations i WHERE i.id=?`, [id]));
    const exists = (query: string, values: ReadonlyArray<string | number | null>) =>
      read(
        Schema.Struct({ value: Schema.Int }),
        sql(`SELECT EXISTS(${query}) AS value`, values),
      ).pipe(Effect.map((rows) => rows[0]?.value === 1));
    return Model.Store.of({
      find: (id) =>
        read(Model.Found, sql(`SELECT ${foundColumns} FROM ${foundFrom} WHERE i.id=?`, [id])).pipe(
          Effect.map((rows) => rows[0] ?? null),
        ),
      pending: (serverId, emailKey) =>
        row(
          sql(
            `SELECT ${rowColumns} FROM server_invitations i WHERE i.server_id=? AND i.email_key=? AND i.state='pending'`,
            [serverId, emailKey],
          ),
        ),
      create: Effect.fn("GuestStore.create")(function* (value) {
        yield* batch([
          sql(
            `INSERT INTO server_invitations(id,server_id,account_id,organization_id,inviter_id,member_id,email,email_key,state,created_at,sent_at,sends,expires_at)
             VALUES(?,?,?,?,?,?,?,?,'pending',?,?,1,?) ON CONFLICT DO NOTHING`,
            [
              value.id,
              value.serverId,
              value.accountId,
              value.organizationId,
              value.inviterId,
              value.memberId,
              value.email,
              value.emailKey,
              value.createdAt,
              value.sentAt,
              value.expiresAt,
            ],
          ),
        ]);
        const stored = yield* row(
          sql(
            `SELECT ${rowColumns} FROM server_invitations i WHERE i.server_id=? AND i.email_key=? AND i.state='pending'`,
            [value.serverId, value.emailKey],
          ),
        );
        if (stored === null) return yield* unavailable();
        return stored;
      }),
      renew: Effect.fn("GuestStore.renew")(function* (id, at, expiresAt) {
        yield* batch([
          sql(
            "UPDATE server_invitations SET sends=sends+1,sent_at=?,expires_at=? WHERE id=? AND state='pending'",
            [at, expiresAt, id],
          ),
        ]);
        return yield* byId(id);
      }),
      cancel: Effect.fn("GuestStore.cancel")(function* (id, at) {
        yield* batch([
          sql(
            "UPDATE server_invitations SET state='canceled',canceled_at=? WHERE id=? AND state='pending'",
            [at, id],
          ),
        ]);
        return yield* byId(id);
      }),
      list: (serverId) =>
        read(
          Model.Listed,
          sql(
            `SELECT ${rowColumns},g.revoked_at AS revokedAt,g.revision,g.applied_revision AS appliedRevision
             FROM server_invitations i LEFT JOIN server_access g ON g.server_id=i.server_id AND g.user_id=i.accepted_user_id
             WHERE i.server_id=? AND i.state<>'canceled' ORDER BY i.created_at DESC,i.id LIMIT 200`,
            [serverId],
          ),
        ),
      holdsPlace: (organizationId, emailKey, at) =>
        exists(
          `WITH guests AS (${counted}) SELECT 1 FROM (${invited}) WHERE emailKey=?3
           UNION ALL SELECT 1 FROM server_invitations d WHERE d.organization_id=?1 AND d.email_key=?3
           AND d.state='accepted' AND d.accepted_user_id IN (SELECT userId FROM guests)`,
          [organizationId, at, emailKey],
        ),
      hasAccess: (serverId, emailKey) =>
        exists(
          `SELECT 1 FROM server_invitations i JOIN server_access g ON g.server_id=i.server_id AND g.user_id=i.accepted_user_id
           WHERE i.server_id=? AND i.email_key=? AND i.state='accepted' AND g.revoked_at IS NULL`,
          [serverId, emailKey],
        ),
      accept: Effect.fn("GuestStore.accept")(function* (invitation, userId, through, at) {
        // Every later statement acts only if this batch accepted the invitation for this person.
        const accepted =
          "EXISTS(SELECT 1 FROM server_invitations WHERE id=? AND state='accepted' AND accepted_user_id=? AND accepted_at=?)";
        const acceptance = [invitation.id, userId, at];
        const statements = [
          sql(
            `UPDATE server_invitations SET state='accepted',accepted_user_id=?,accepted_at=?
             WHERE id=? AND state='pending' AND expires_at>?
             AND EXISTS(SELECT 1 FROM servers WHERE id=server_invitations.server_id AND status='ready' AND deletion_requested_at IS NULL)`,
            [userId, at, invitation.id, at],
          ),
        ];
        if (through.guest)
          // The same guards as WorkOS membership snapshots: a deleted person, or an organization
          // being deleted, never gains rows again.
          statements.push(
            sql(
              `INSERT INTO memberships(id,organization_id,user_id,status,role,updated_at)
               SELECT ?,?,?,'active','guest',? WHERE ${accepted}
               AND NOT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=?)
               AND NOT EXISTS(SELECT 1 FROM accounts WHERE organization_id=? AND deletion_requested_at IS NOT NULL)
               ON CONFLICT(id) DO UPDATE SET status='active',updated_at=MAX(memberships.updated_at,excluded.updated_at)
               WHERE memberships.status<>'deleted'`,
              [
                through.id,
                invitation.organizationId,
                userId,
                at,
                ...acceptance,
                userId,
                invitation.organizationId,
              ],
            ),
          );
        // As `allow`: a revoked grant is renewed under a new ID; an unrevoked one is kept.
        statements.push(
          sql(
            `INSERT INTO server_access(server_id,user_id,id,membership_id,principal_key,created_at,revision)
             SELECT ?,?,?,?,?,?,1 WHERE ${accepted}
             AND EXISTS(SELECT 1 FROM memberships WHERE id=? AND user_id=? AND status='active')
             AND EXISTS(SELECT 1 FROM servers WHERE id=? AND deletion_requested_at IS NULL)
             ON CONFLICT(server_id,user_id) DO UPDATE SET id=excluded.id,membership_id=excluded.membership_id,
             created_at=excluded.created_at,revoked_at=NULL,revision=server_access.revision+1
             WHERE server_access.revoked_at IS NOT NULL`,
            [
              invitation.serverId,
              userId,
              crypto.randomUUID(),
              through.id,
              Platform.actor(userId).principalKey,
              at,
              ...acceptance,
              through.id,
              userId,
              invitation.serverId,
            ],
          ),
        );
        yield* batch(statements);
      }),
      shared: (userId) =>
        read(
          Model.SharedRow,
          sql(
            `SELECT s.id,s.account_id AS accountId,s.name,s.created_by AS createdBy,s.created_at AS createdAt,s.status,
             a.name AS organizationName,CASE WHEN g.applied_revision=g.revision THEN 1 ELSE 0 END AS readable
             FROM server_access g JOIN memberships m ON m.id=g.membership_id
             JOIN servers s ON s.id=g.server_id JOIN accounts a ON a.id=s.account_id
             WHERE g.user_id=? AND g.revoked_at IS NULL AND m.status='active' AND ${guestMembership("m")}
             AND s.status='ready' AND s.deletion_requested_at IS NULL AND a.deletion_requested_at IS NULL
             AND NOT ${alsoMember("m")} ORDER BY a.name,s.name,s.id LIMIT 200`,
            [userId],
          ),
        ),
      invitedTo: (emailKey, at) =>
        read(
          Model.Found,
          sql(
            `SELECT ${foundColumns} FROM ${foundFrom} WHERE i.email_key=? AND i.state='pending' AND i.expires_at>?
             AND s.status='ready' AND s.deletion_requested_at IS NULL AND a.deletion_requested_at IS NULL
             ORDER BY i.sent_at DESC LIMIT 50`,
            [emailKey, at],
          ),
        ),
    });
  });
