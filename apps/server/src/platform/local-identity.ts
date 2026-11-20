import { Clock, DateTime, Effect, Layer, Option, Schema } from "effect";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as Model from "./model.js";
import * as Platform from "./service.js";

/**
 * People, organizations and invitations kept in the copy's own D1 database, for self-hosted copies
 * that sign people in with Cloudflare Access (docs/self-host-cloudflare-access.md) or Better Auth
 * (docs/self-host-better-auth.md) instead of WorkOS. Nothing here sends email: an invitation is
 * accepted the first time its email signs in.
 */

/** How long an invitation stays open, as on WorkOS. Resending renews it. */
const invitationDays = 7;
/** How often one isolate records the same person's sign-in. */
const seenEveryMs = 5 * 60 * 1000;
const pageSize = 100;

const unavailable = () =>
  new Model.Failure({
    code: "identity_unavailable",
    message: "Sign-in records are temporarily unavailable.",
  });
const missing = () =>
  new Model.Failure({
    code: "not_found",
    message: "The user, membership, or invitation is unavailable.",
  });
const invalid = (message: string) => new Model.Failure({ code: "invalid_input", message });

const now = Clock.currentTimeMillis.pipe(
  Effect.map((ms) => M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(ms)))),
);
const later = (at: M.Timestamp, days: number) =>
  M.Timestamp.make(DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(at), { days })));
const randomId = () => crypto.randomUUID().replaceAll("-", "");

/** 32 hex characters of SHA-256, for IDs that must come out the same on every retry. */
const digest = Effect.fn("LocalIdentity.digest")(function* (value: string) {
  const bytes = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...new Uint8Array(bytes)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
});
/**
 * One membership ID per organization and person, so concurrent first sign-ins all name the same
 * membership in their events.
 */
const membershipId = (organizationId: P.OrganizationId, id: P.UserId) =>
  digest(`${organizationId}:${id}`).pipe(Effect.map((hex) => P.MembershipId.make(`om_${hex}`)));

const UserRow = Schema.Struct({
  id: P.UserId,
  email: Schema.String,
  first_name: Schema.NullOr(Schema.String),
  last_name: Schema.NullOr(Schema.String),
});
const MemberRow = Schema.Struct({
  id: P.MembershipId,
  organization_id: P.OrganizationId,
  user_id: P.UserId,
  status: P.Member.fields.status,
  role: Schema.String,
  updated_at: M.Timestamp,
});
const InvitationRow = Schema.Struct({
  id: P.InvitationId,
  organization_id: P.OrganizationId,
  email: Schema.String,
  state: Schema.Literals(["pending", "accepted", "revoked"]),
  accepted_user_id: Schema.NullOr(P.UserId),
  created_at: M.Timestamp,
  expires_at: M.Timestamp,
});
type InvitationRow = typeof InvitationRow.Type;
const EventRow = Schema.Struct({
  sequence: Schema.Number,
  payload: Schema.fromJsonString(Schema.Unknown),
});
/** The event payload without its ID; the ID comes from the row's sequence. */
const EventBody = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("membership"), member: P.Member }),
  Schema.Struct({ kind: Schema.Literal("user_deleted"), userId: P.UserId, at: M.Timestamp }),
  Schema.Struct({
    kind: Schema.Literal("organization_deleted"),
    organizationId: P.OrganizationId,
    at: M.Timestamp,
  }),
]);
type EventBody = typeof EventBody.Type;
const eventId = (sequence: number) => `local_event_${String(sequence).padStart(12, "0")}`;
const eventSequence = (id: string) => {
  const match = /^local_event_(\d{12})$/.exec(id);
  return match === null ? null : Number(match[1]);
};

const member = (row: typeof MemberRow.Type): P.Member => ({
  id: row.id,
  organizationId: row.organization_id,
  userId: row.user_id,
  status: row.status,
  role: row.role,
  updatedAt: row.updated_at,
});
/** WorkOS reports a pending invitation past its expiry as expired; so does this store. */
const invitation = (row: InvitationRow, at: M.Timestamp): P.Invitation => ({
  id: row.id,
  organizationId: row.organization_id,
  email: row.email,
  state: row.state === "pending" && row.expires_at <= at ? "expired" : row.state,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

/** A new person's ID and name, when the sign-in provider chose them. */
export interface Newcomer {
  readonly id?: P.UserId;
  readonly name?: string;
}

/** What the store adds to `Platform.Identity`: recording a verified sign-in. */
export interface SignIns {
  /**
   * The person's user ID for a signed-in email. The first sign-in creates it, as does the first
   * sign-in after the person deleted their account; each sign-in records the time and accepts the
   * email's pending invitations. Each isolate reads it at most once every few minutes per email.
   * `newcomer` names a person this call creates; an existing person keeps their ID and name.
   */
  readonly identify: (email: string, newcomer?: Newcomer) => Effect.Effect<P.UserId, Model.Failure>;
  /**
   * The same, without accepting any invitation. Better Auth mode uses it: there an address is not
   * proven, so a membership comes only from the invitation code the person presents.
   */
  readonly record: (email: string, newcomer?: Newcomer) => Effect.Effect<P.UserId, Model.Failure>;
  /**
   * Accept one invitation for the person, only while it is open and sent to their address.
   * Answers whether they are now a member through it.
   */
  readonly acceptInvitation: (
    id: P.UserId,
    email: string,
    invitationId: P.InvitationId,
  ) => Effect.Effect<boolean, Model.Failure>;
  /** The user ID already recorded for an email, without recording a sign-in. */
  readonly existing: (email: string) => Effect.Effect<P.UserId | null, Model.Failure>;
}

/** The D1 store, as the `Platform.Identity` service and the sign-in recorder. */
export const make = (database: D1Database) => {
  const db = database.withSession("first-primary");
  const sql = (query: string, values: ReadonlyArray<string | number | null> = []) =>
    db.prepare(query).bind(...values);
  const run = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({ try: operation, catch: unavailable });
  const rows = <S extends Schema.Top>(
    schema: S,
    query: string,
    values: ReadonlyArray<string | number | null> = [],
  ) =>
    run(() => sql(query, values).all()).pipe(
      Effect.flatMap((result) =>
        Schema.decodeUnknownEffect(Schema.Array(schema))(result.results).pipe(
          Effect.mapError(unavailable),
        ),
      ),
    );
  const row = <S extends Schema.Top>(
    schema: S,
    query: string,
    values: ReadonlyArray<string | number | null> = [],
  ) => rows(schema, query, values).pipe(Effect.map((items) => items[0]));
  const event = (body: EventBody, at: M.Timestamp) =>
    sql("INSERT INTO local_identity_events(payload,created_at) VALUES (?,?)", [
      JSON.stringify(body),
      at,
    ]);

  const membershipOf = Effect.fn("LocalIdentity.membership")(function* (
    organizationId: P.OrganizationId,
    id: P.UserId,
  ) {
    const found = yield* row(
      MemberRow,
      `SELECT * FROM local_memberships WHERE organization_id=? AND user_id=?`,
      [organizationId, id],
    );
    return found === undefined ? null : member(found);
  });
  /**
   * Make the person an active member with this role, in one transaction. With an invitation, it
   * happens only while that invitation is still open, so a cancellation that lands first wins.
   * The event is written only when the membership changed.
   */
  const join = Effect.fn("LocalIdentity.join")(function* (
    organizationId: P.OrganizationId,
    id: P.UserId,
    role: string,
    at: M.Timestamp,
    invitationId: P.InvitationId | null,
  ) {
    const joined: P.Member = {
      id: yield* membershipId(organizationId, id),
      organizationId,
      userId: id,
      status: "active",
      role,
      updatedAt: at,
    };
    const open =
      invitationId === null
        ? { clause: "1", values: [] }
        : {
            clause: `EXISTS(SELECT 1 FROM local_invitations WHERE id=? AND state='pending' AND expires_at>?)`,
            values: [invitationId, at],
          };
    yield* run(() =>
      db.batch([
        sql(
          `INSERT INTO local_memberships(id,organization_id,user_id,status,role,updated_at)
           SELECT ?,?,?,'active',?,? WHERE ${open.clause}
           ON CONFLICT(organization_id,user_id) DO UPDATE SET status='active', role=excluded.role,
             updated_at=excluded.updated_at WHERE local_memberships.status<>'active'`,
          [joined.id, organizationId, id, role, at, ...open.values],
        ),
        sql(
          `INSERT INTO local_identity_events(payload,created_at) SELECT ?,?
           WHERE EXISTS(SELECT 1 FROM local_memberships WHERE id=? AND status='active' AND updated_at=?)`,
          [JSON.stringify({ kind: "membership", member: joined }), at, joined.id, at],
        ),
        ...(invitationId === null
          ? []
          : [
              sql(
                `UPDATE local_invitations SET state='accepted', accepted_user_id=?
                 WHERE id=? AND state='pending' AND expires_at>?`,
                [id, invitationId, at],
              ),
            ]),
      ]),
    );
  });
  /** Accept the email's open invitations, as WorkOS does when the invitee signs up. */
  const accept = Effect.fn("LocalIdentity.accept")(function* (
    id: P.UserId,
    email: string,
    at: M.Timestamp,
  ) {
    const open = yield* rows(
      InvitationRow,
      `SELECT * FROM local_invitations WHERE email=? AND state='pending' AND expires_at>?`,
      [email, at],
    );
    yield* Effect.forEach(open, (item) => join(item.organization_id, id, "member", at, item.id), {
      discard: true,
    });
  });
  const invitationById = Effect.fn("LocalIdentity.invitationById")(function* (id: P.InvitationId) {
    const found = yield* row(InvitationRow, `SELECT * FROM local_invitations WHERE id=?`, [id]);
    if (found === undefined) return yield* missing();
    return found;
  });
  const page = <A extends { readonly id: string }>(items: ReadonlyArray<A>, limit: number) => ({
    items: items.slice(0, limit),
    nextCursor: items.length > limit ? (items[limit - 1]?.id ?? null) : null,
  });

  const known = new Map<string, { readonly id: P.UserId; readonly until: number }>();
  const remember = Effect.fn("LocalIdentity.remember")(function* (
    email: string,
    newcomer: Newcomer,
    accepting: boolean,
  ) {
    const address = email.toLowerCase();
    const clock = yield* Clock.currentTimeMillis;
    const cached = known.get(address);
    if (cached !== undefined && cached.until > clock) return cached.id;
    const at = yield* now;
    // A new random ID only when the email has no row: on the first sign-in, or after the person
    // deleted their account, whose old ID stays retired.
    const found = yield* run(() =>
      sql(
        `INSERT INTO local_users(id,email,first_name,last_name,created_at,seen_at)
           VALUES (?,?,?,NULL,?,?)
           ON CONFLICT(email) DO UPDATE SET seen_at=excluded.seen_at
           RETURNING id`,
        [
          newcomer.id ?? `user_${randomId()}`,
          address,
          newcomer.name ?? address.split("@")[0] ?? null,
          at,
          at,
        ],
      ).first(),
    );
    const id = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: P.UserId }))(found).pipe(
      Effect.mapError(unavailable),
    );
    if (accepting) yield* accept(id.id, address, at);
    known.set(address, { id: id.id, until: clock + seenEveryMs });
    return id.id;
  });
  const signIns: SignIns = {
    identify: (email, newcomer = {}) => remember(email, newcomer, true),
    record: (email, newcomer = {}) => remember(email, newcomer, false),
    acceptInvitation: Effect.fn("LocalIdentity.acceptInvitation")(
      function* (id, email, invitationId) {
        const at = yield* now;
        const found = yield* row(
          InvitationRow,
          `SELECT * FROM local_invitations WHERE id=? AND state='pending' AND expires_at>?`,
          [invitationId, at],
        );
        if (found === undefined || found.email !== email.toLowerCase()) return false;
        yield* join(found.organization_id, id, "member", at, found.id);
        const joined = yield* invitationById(found.id);
        return joined.state === "accepted" && joined.accepted_user_id === id;
      },
    ),
    existing: Effect.fn("LocalIdentity.existing")(function* (email) {
      const found = yield* row(
        Schema.Struct({ id: P.UserId }),
        `SELECT id FROM local_users WHERE email=?`,
        [email.toLowerCase()],
      );
      return found?.id ?? null;
    }),
  };

  const identity = Platform.Identity.of({
    user: Effect.fn("LocalIdentity.user")(function* (id) {
      const found = yield* row(UserRow, `SELECT * FROM local_users WHERE id=?`, [id]);
      if (found === undefined) return yield* missing();
      return {
        id: found.id,
        email: found.email,
        // Access signed the person in with this address: an identity provider or a one-time PIN
        // has checked it. Better Auth admits an address only as a configured owner or with the
        // invitation sent to it (docs/self-host-better-auth.md).
        emailVerified: true,
        firstName: found.first_name,
        lastName: found.last_name,
      };
    }),
    invitations: Effect.fn("LocalIdentity.invitations")(function* (organizationId, after) {
      const at = yield* now;
      const items = yield* rows(
        InvitationRow,
        `SELECT * FROM local_invitations WHERE organization_id=? AND id>? ORDER BY id LIMIT ?`,
        [organizationId, after ?? "", pageSize + 1],
      );
      return page(
        items.map((item) => invitation(item, at)),
        pageSize,
      );
    }),
    invitation: Effect.fn("LocalIdentity.invitation")(function* (id) {
      return invitation(yield* invitationById(id), yield* now);
    }),
    acceptedInvitee: Effect.fn("LocalIdentity.acceptedInvitee")(function* (id) {
      return (yield* invitationById(id)).accepted_user_id;
    }),
    findInvitations: Effect.fn("LocalIdentity.findInvitations")(function* (organizationId, email) {
      const at = yield* now;
      const items = yield* rows(
        InvitationRow,
        `SELECT * FROM local_invitations WHERE organization_id=? AND email=? ORDER BY id LIMIT ?`,
        [organizationId, email.toLowerCase(), pageSize],
      );
      return { items: items.map((item) => invitation(item, at)), nextCursor: null };
    }),
    invite: Effect.fn("LocalIdentity.invite")(function* (organizationId, inviter, input) {
      const at = yield* now;
      const email = input.email.toLowerCase();
      const open = yield* row(
        Schema.Struct({ id: Schema.String }),
        `SELECT id FROM local_invitations WHERE organization_id=? AND email=? AND state='pending' AND expires_at>?`,
        [organizationId, email, at],
      );
      if (open !== undefined)
        return yield* invalid(
          "This email already has a pending invitation. List invitations to resend or cancel it.",
        );
      const existing = yield* row(UserRow, `SELECT * FROM local_users WHERE email=?`, [email]);
      if (existing !== undefined) {
        const current = yield* membershipOf(organizationId, existing.id);
        if (current?.status === "active")
          return yield* invalid("This person is already a member of the organization.");
      }
      const created: InvitationRow = {
        id: P.InvitationId.make(`invitation_${randomId()}`),
        organization_id: organizationId,
        email,
        state: "pending",
        accepted_user_id: null,
        created_at: at,
        expires_at: later(at, invitationDays),
      };
      yield* run(() =>
        sql(
          `INSERT INTO local_invitations(id,organization_id,email,state,inviter_id,accepted_user_id,created_at,expires_at)
           VALUES (?,?,?,?,?,NULL,?,?)`,
          [
            created.id,
            organizationId,
            email,
            "pending",
            inviter,
            created.created_at,
            created.expires_at,
          ],
        ).run(),
      );
      // The invitee joins at their next sign-in, never at the inviter's say alone.
      return invitation(created, at);
    }),
    resend: Effect.fn("LocalIdentity.resend")(function* (id) {
      const at = yield* now;
      const found = yield* invitationById(id);
      if (found.state !== "pending")
        return yield* invalid("Only pending invitations can be resent.");
      const expiresAt = later(at, invitationDays);
      yield* run(() =>
        sql(`UPDATE local_invitations SET expires_at=? WHERE id=?`, [expiresAt, id]).run(),
      );
      return invitation({ ...found, expires_at: expiresAt }, at);
    }),
    cancel: Effect.fn("LocalIdentity.cancel")(function* (id) {
      const found = yield* invitationById(id);
      if (found.state === "accepted")
        return yield* invalid("This invitation was already accepted.");
      yield* run(() => sql(`UPDATE local_invitations SET state='revoked' WHERE id=?`, [id]).run());
      return invitation({ ...found, state: "revoked" }, yield* now);
    }),
    deactivate: Effect.fn("LocalIdentity.deactivate")(function* (value) {
      const at = yield* now;
      const found = yield* row(MemberRow, `SELECT * FROM local_memberships WHERE id=?`, [value.id]);
      if (found === undefined) return yield* missing();
      const removed: P.Member = { ...member(found), status: "inactive", updatedAt: at };
      yield* run(() =>
        db.batch([
          sql(`UPDATE local_memberships SET status='inactive', updated_at=? WHERE id=?`, [
            at,
            value.id,
          ]),
          event({ kind: "membership", member: removed }, at),
        ]),
      );
      return removed;
    }),
    createAccount: Effect.fn("LocalIdentity.createAccount")(function* (reservation) {
      if (reservation.organizationId !== null) return reservation.organizationId;
      const at = yield* now;
      // The account ID is unique, so a retried creation finds the first organization.
      yield* run(() =>
        sql(
          `INSERT INTO local_organizations(id,account_id,name,created_at) VALUES (?,?,?,?)
           ON CONFLICT(account_id) DO NOTHING`,
          [`org_${randomId()}`, reservation.id, reservation.name, at],
        ).run(),
      );
      const found = yield* row(
        Schema.Struct({ id: P.OrganizationId }),
        `SELECT id FROM local_organizations WHERE account_id=?`,
        [reservation.id],
      );
      if (found === undefined) return yield* unavailable();
      yield* join(found.id, reservation.createdBy, "admin", at, null);
      return found.id;
    }),
    membership: Effect.fn("LocalIdentity.membershipOf")(function* (organizationId, id) {
      return yield* membershipOf(organizationId, id);
    }),
    memberships: Effect.fn("LocalIdentity.memberships")(function* (id, after, limit) {
      const items = yield* rows(
        MemberRow,
        `SELECT * FROM local_memberships WHERE user_id=? AND status<>'deleted' AND id>? ORDER BY id LIMIT ?`,
        [id, after ?? "", limit + 1],
      );
      return page(items.map(member), limit);
    }),
    members: Effect.fn("LocalIdentity.members")(function* (organizationId, after, limit) {
      const items = yield* rows(
        MemberRow,
        `SELECT * FROM local_memberships WHERE organization_id=? AND status='active' AND id>? ORDER BY id LIMIT ?`,
        [organizationId, after ?? "", limit + 1],
      );
      return page(items.map(member), limit);
    }),
    events: Effect.fn("LocalIdentity.events")(function* (cursor, startedAt) {
      const sequence = cursor === null ? null : eventSequence(cursor);
      const found = yield* rows(
        EventRow,
        sequence === null
          ? `SELECT sequence,payload FROM local_identity_events WHERE created_at>=? ORDER BY sequence LIMIT ?`
          : `SELECT sequence,payload FROM local_identity_events WHERE sequence>? ORDER BY sequence LIMIT ?`,
        [sequence ?? startedAt, pageSize],
      );
      return yield* Effect.forEach(found, (item) =>
        Schema.decodeUnknownEffect(EventBody)(item.payload).pipe(
          Effect.map((body): Model.IdentityEvent => ({ ...body, id: eventId(item.sequence) })),
          Effect.mapError(unavailable),
        ),
      );
    }),
    deleteUser: Effect.fn("LocalIdentity.deleteUser")(function* (id) {
      const at = yield* now;
      yield* run(() =>
        db.batch([
          sql(`UPDATE local_memberships SET status='deleted', updated_at=? WHERE user_id=?`, [
            at,
            id,
          ]),
          sql(`DELETE FROM local_users WHERE id=?`, [id]),
          event({ kind: "user_deleted", userId: id, at }, at),
        ]),
      );
      for (const [address, entry] of known) if (entry.id === id) known.delete(address);
    }),
    deleteOrganization: Effect.fn("LocalIdentity.deleteOrganization")(function* (account) {
      const found =
        account.organizationId ??
        Option.getOrNull(
          Option.fromNullishOr(
            (yield* row(
              Schema.Struct({ id: P.OrganizationId }),
              `SELECT id FROM local_organizations WHERE account_id=?`,
              [account.id],
            ))?.id,
          ),
        );
      if (found === null) return;
      const at = yield* now;
      yield* run(() =>
        db.batch([
          sql(
            `UPDATE local_memberships SET status='deleted', updated_at=? WHERE organization_id=?`,
            [at, found],
          ),
          sql(
            `UPDATE local_invitations SET state='revoked' WHERE organization_id=? AND state='pending'`,
            [found],
          ),
          sql(`DELETE FROM local_organizations WHERE id=?`, [found]),
          event({ kind: "organization_deleted", organizationId: found, at }, at),
        ]),
      );
    }),
    // Agents sign in through Access's Managed OAuth; Zero Trust lists and revokes those sessions.
    authorizedApplications: () => Effect.succeed([]),
    revokeAuthorizedApplication: () => Effect.void,
  });
  return { identity, signIns };
};

/** The store as a layer, for the hosted Worker's composition. */
export const layer = (store: ReturnType<typeof make>) =>
  Layer.succeed(Platform.Identity, store.identity);
