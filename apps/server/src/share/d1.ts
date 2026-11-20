import { Effect, Layer, Schema } from "effect";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as Share from "@talkto/api/share";
import { share } from "@talkto/api/pricing";
import * as Model from "./model.js";

/*
  Share links in D1 (platform migration 0020). Every rule that must hold under concurrent requests
  and overlapping cron runs is one conditional statement inside one batch: room on the link, one
  join per organization and per owner, at most `share.sharerLimit` sharer bonuses per person, and
  exactly one bonus per referral and side.
*/

const linkColumns = "code,account_id AS accountId,owner_id AS ownerId,created_at AS createdAt";
const referralColumns = `r.id,r.code,r.sharer_account_id AS sharerAccountId,r.sharer_owner_id AS sharerOwnerId,
 r.account_id AS accountId,r.owner_id AS ownerId,r.joined_at AS joinedAt,r.window_start AS windowStart,
 r.window_end AS windowEnd,r.status,r.settled_at AS settledAt`;
const bonusColumns = (alias: string) =>
  `${alias}.referral_id AS referralId,${alias}.side,${alias}.account_id AS accountId,${alias}.owner_id AS ownerId,${alias}.status,${alias}.applied_at AS appliedAt,${alias}.created_at AS createdAt`;

const LinkRow = Schema.Struct({
  code: Share.Code,
  accountId: P.AccountId,
  ownerId: P.UserId,
  createdAt: M.Timestamp,
});
const ReferralRow = Schema.Struct({
  id: Schema.String,
  code: Share.Code,
  sharerAccountId: P.AccountId,
  sharerOwnerId: P.UserId,
  accountId: P.AccountId,
  ownerId: P.UserId,
  joinedAt: M.Timestamp,
  windowStart: M.Timestamp,
  windowEnd: M.Timestamp,
  status: Share.Referral.fields.status,
  settledAt: Schema.NullOr(M.Timestamp),
});
const BonusRow = Schema.Struct({
  referralId: Schema.String,
  side: Schema.Literals(["sharer", "joined"]),
  accountId: P.AccountId,
  ownerId: P.UserId,
  status: Share.BonusStatus,
  appliedAt: Schema.NullOr(M.Timestamp),
  createdAt: M.Timestamp,
});
/** A referral joined with its bonus; the bonus columns are null where there is none. */
const ListedRow = Schema.Struct({
  ...ReferralRow.fields,
  bonusStatus: Schema.NullOr(Share.BonusStatus),
  bonusAppliedAt: Schema.NullOr(M.Timestamp),
  bonusCreatedAt: Schema.NullOr(M.Timestamp),
});
const Flag = Schema.Struct({ value: Schema.Int });
/** Bonuses one person received as a sharer, counted where the limit is enforced. */
const sharerBonuses = "(SELECT COUNT(*) FROM share_bonuses WHERE side='sharer' AND owner_id=?)";

const listed = (
  row: typeof ListedRow.Type,
  side: Model.Side,
  ownerId: P.UserId,
  accountId: P.AccountId,
): Model.Listed => {
  const { bonusStatus, bonusAppliedAt, bonusCreatedAt, ...referral } = row;
  return {
    ...referral,
    bonus:
      bonusStatus === null || bonusCreatedAt === null
        ? null
        : {
            referralId: referral.id,
            side,
            accountId,
            ownerId,
            status: bonusStatus,
            appliedAt: bonusAppliedAt,
            createdAt: bonusCreatedAt,
          },
  };
};

/** The D1 store; reads and writes use the primary so a just-written row is always seen. */
export const layer = (database: D1Database) =>
  Layer.sync(Model.Store, () => {
    const db = database.withSession("first-primary");
    const sql = (query: string, values: ReadonlyArray<string | number | null> = []) =>
      db.prepare(query).bind(...values);
    const all = Effect.fn("ShareStore.read")(function* <A>(
      schema: Schema.Decoder<A>,
      statement: D1PreparedStatement,
    ) {
      const result = yield* Effect.tryPromise({
        try: () => statement.all(),
        catch: () => Model.unavailable("storage.read"),
      });
      return yield* Schema.decodeUnknownEffect(Schema.Array(schema))(result.results).pipe(
        Effect.mapError(() => Model.unavailable("storage.decode")),
      );
    });
    const one = <A>(schema: Schema.Decoder<A>, statement: D1PreparedStatement) =>
      all(schema, statement).pipe(Effect.map((rows) => rows[0] ?? null));
    const run = (statement: D1PreparedStatement) =>
      Effect.tryPromise({
        try: () => statement.run(),
        catch: () => Model.unavailable("storage.write"),
      });
    const batch = (statements: ReadonlyArray<D1PreparedStatement>) =>
      Effect.tryPromise({
        try: () => db.batch([...statements]),
        catch: () => Model.unavailable("storage.write"),
      });
    const flag = (statement: D1PreparedStatement) =>
      one(Flag, statement).pipe(Effect.map((row) => row?.value === 1));
    const link = (accountId: P.AccountId) =>
      one(LinkRow, sql(`SELECT ${linkColumns} FROM share_links WHERE account_id=?`, [accountId]));
    const referral = (id: string) =>
      one(ReferralRow, sql(`SELECT ${referralColumns} FROM share_referrals r WHERE r.id=?`, [id]));

    return Model.Store.of({
      link,
      linkByCode: (code) =>
        one(LinkRow, sql(`SELECT ${linkColumns} FROM share_links WHERE code=?`, [code])),
      createLink: Effect.fn("ShareStore.createLink")(function* (value) {
        yield* run(
          sql(
            "INSERT INTO share_links(code,account_id,owner_id,created_at) VALUES(?,?,?,?) ON CONFLICT(account_id) DO NOTHING",
            [value.code, value.accountId, value.ownerId, value.createdAt],
          ),
        );
        const stored = yield* link(value.accountId);
        if (stored === null) return yield* Model.unavailable("storage.link_missing");
        return stored;
      }),
      newness: (accountId) =>
        one(
          Schema.Struct({ claimedAt: Schema.NullOr(M.Timestamp), createdAt: M.Timestamp }),
          sql(
            "SELECT (SELECT reserved_at FROM starter_grants WHERE account_id=a.id) AS claimedAt,a.created_at AS createdAt FROM accounts a WHERE a.id=?",
            [accountId],
          ),
        ),
      member: (accountId, userId) =>
        flag(
          sql(
            "SELECT EXISTS(SELECT 1 FROM memberships m JOIN accounts a ON a.organization_id=m.organization_id WHERE a.id=? AND m.user_id=? AND m.status='active') AS value",
            [accountId, userId],
          ),
        ),
      joined: Effect.fn("ShareStore.joined")(function* (accountId) {
        const found = yield* one(
          ListedRow,
          sql(
            `SELECT ${referralColumns},b.status AS bonusStatus,b.applied_at AS bonusAppliedAt,b.created_at AS bonusCreatedAt
             FROM share_referrals r LEFT JOIN share_bonuses b ON b.referral_id=r.id AND b.side='joined'
             WHERE r.account_id=?`,
            [accountId],
          ),
        );
        if (found === null) return null;
        const { bonus, ...value } = listed(found, "joined", found.ownerId, found.accountId);
        return { referral: value, bonus };
      }),
      referrals: Effect.fn("ShareStore.referrals")(function* (code, limit) {
        const rows = yield* all(
          ListedRow,
          sql(
            `SELECT ${referralColumns},b.status AS bonusStatus,b.applied_at AS bonusAppliedAt,b.created_at AS bonusCreatedAt
             FROM share_referrals r LEFT JOIN share_bonuses b ON b.referral_id=r.id AND b.side='sharer'
             WHERE r.code=? ORDER BY r.joined_at DESC,r.id LIMIT ?`,
            [code, limit],
          ),
        );
        return rows.map((row) => listed(row, "sharer", row.sharerOwnerId, row.sharerAccountId));
      }),
      exhausted: (value) =>
        flag(
          sql(
            `SELECT (${sharerBonuses}>=? OR (SELECT COUNT(*) FROM share_referrals WHERE code=?)>=?) AS value`,
            [value.ownerId, share.sharerLimit, value.code, share.signupsPerLink],
          ),
        ),
      join: Effect.fn("ShareStore.join")(function* (value) {
        // One batch: the referral only while the link has room and nobody joined twice, then its
        // `joined` bonus only if that referral row is the one just written.
        yield* batch([
          sql(
            `INSERT INTO share_referrals(id,code,sharer_account_id,sharer_owner_id,account_id,owner_id,joined_at,window_start,window_end,status,next_check_at)
             SELECT ?,?,?,?,?,?,?,?,?,'waiting',?
             WHERE ${sharerBonuses}<? AND (SELECT COUNT(*) FROM share_referrals WHERE code=?)<?
             ON CONFLICT DO NOTHING`,
            [
              value.id,
              value.code,
              value.sharerAccountId,
              value.sharerOwnerId,
              value.accountId,
              value.ownerId,
              value.joinedAt,
              value.windowStart,
              value.windowEnd,
              value.nextCheckAt,
              value.sharerOwnerId,
              share.sharerLimit,
              value.code,
              share.signupsPerLink,
            ],
          ),
          sql(
            `INSERT INTO share_bonuses(referral_id,side,account_id,owner_id,messages,status,created_at)
             SELECT id,'joined',account_id,owner_id,?,'pending',? FROM share_referrals WHERE id=?
             ON CONFLICT DO NOTHING`,
            [share.messages, value.joinedAt, value.id],
          ),
        ]);
        const written = yield* referral(value.id);
        if (written !== null) return { kind: "joined", referral: written } as const;
        const taken = yield* flag(
          sql(
            "SELECT EXISTS(SELECT 1 FROM share_referrals WHERE account_id=? OR owner_id=?) AS value",
            [value.accountId, value.ownerId],
          ),
        );
        return { kind: taken ? "already_joined" : "link_full" } as const;
      }),
      due: (now, limit) =>
        all(
          ReferralRow,
          sql(
            `SELECT ${referralColumns} FROM share_referrals r WHERE r.status='waiting' AND r.next_check_at<=? ORDER BY r.next_check_at LIMIT ?`,
            [now, limit],
          ),
        ),
      qualify: Effect.fn("ShareStore.qualify")(function* (value, at) {
        yield* batch([
          sql(
            `INSERT INTO share_bonuses(referral_id,side,account_id,owner_id,messages,status,created_at)
             SELECT r.id,'sharer',r.sharer_account_id,r.sharer_owner_id,?,'pending',? FROM share_referrals r
             WHERE r.id=? AND r.status='waiting' AND ${sharerBonuses}<?
             ON CONFLICT DO NOTHING`,
            [share.messages, at, value.id, value.sharerOwnerId, share.sharerLimit],
          ),
          sql(
            `UPDATE share_referrals SET status=CASE WHEN EXISTS(SELECT 1 FROM share_bonuses WHERE referral_id=share_referrals.id AND side='sharer') THEN 'qualified' ELSE 'capped' END,
             checked_at=?,settled_at=? WHERE id=? AND status='waiting'`,
            [at, at, value.id],
          ),
        ]);
        const after = yield* referral(value.id);
        if (after === null) return yield* Model.unavailable("storage.referral_missing");
        return after.status;
      }),
      settle: (referralId, status, reason, at) =>
        run(
          sql(
            "UPDATE share_referrals SET status=?,reason=?,checked_at=?,settled_at=? WHERE id=? AND status='waiting'",
            [status, reason, at, at, referralId],
          ),
        ).pipe(Effect.asVoid),
      recheck: (referralId, checkedAt, next) =>
        run(
          sql(
            "UPDATE share_referrals SET checked_at=?,next_check_at=? WHERE id=? AND status='waiting'",
            [checkedAt, next, referralId],
          ),
        ).pipe(Effect.asVoid),
      pending: (limit) =>
        all(
          BonusRow,
          sql(
            `SELECT ${bonusColumns("b")} FROM share_bonuses b WHERE b.status='pending' ORDER BY b.created_at LIMIT ?`,
            [limit],
          ),
        ),
      applied: (bonus, status, at) =>
        run(
          sql(
            "UPDATE share_bonuses SET status=?,applied_at=? WHERE referral_id=? AND side=? AND status='pending'",
            [status, at, bonus.referralId, bonus.side],
          ),
        ).pipe(Effect.asVoid),
      servers: Effect.fn("ShareStore.servers")(function* (accountId) {
        const rows = yield* all(
          Schema.Struct({ id: M.ServerId }),
          sql(
            "SELECT id FROM servers WHERE account_id=? AND status='ready' AND deletion_requested_at IS NULL ORDER BY created_at LIMIT 20",
            [accountId],
          ),
        );
        return rows.map((row) => row.id);
      }),
    });
  });
