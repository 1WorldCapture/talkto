import { Effect, Layer, Schema } from "effect";
import * as Model from "./model.js";
import * as Entitlements from "../account-entitlements.js";
import * as Platform from "./service.js";
import * as Policy from "./invitation-policy.js";

const unavailable = () =>
  new Model.Failure({
    code: "storage_unavailable",
    message: "Invitations are temporarily unavailable. Nothing was sent.",
  });
/** Paid: a confirmed paid period covering the attempt, or an operator grant. Checkout is not. */
const tier = `CASE WHEN ? IN (SELECT value FROM json_each(?))
 OR EXISTS(SELECT 1 FROM billing_periods WHERE account_id=? AND start<=? AND end>?)
 THEN 'paid' ELSE 'unpaid' END`;

/**
 * Invitation budgets in one D1 batch: the attempt is written only if every budget still has room,
 * and the counts are read in the same transaction, so racing attempts cannot both pass.
 */
export const layer = (
  database: D1Database,
  configuration: Effect.Effect<Policy.Configuration, Model.Failure>,
) =>
  Layer.sync(Platform.Invitations, () => {
    const db = database.withSession("first-primary");
    const sql = (query: string, values: ReadonlyArray<string | number | null>) =>
      db.prepare(query).bind(...values);
    return Platform.Invitations.of({
      reserve: Effect.fn("Invitations.reserve")(function* (attempt) {
        const policy = yield* configuration;
        const { account, at } = attempt;
        const id = crypto.randomUUID();
        const today = Policy.day(at);
        const tierValues = [
          account.id,
          JSON.stringify(Entitlements.forAccount(policy.unlimitedAccounts, account.id)),
          account.id,
          at,
          at,
        ];
        const results = yield* Effect.tryPromise({
          try: () =>
            db.batch([
              sql("DELETE FROM invitation_attempts WHERE day<?", [Policy.retainedFrom(at)]),
              sql(
                `WITH current AS (SELECT ${tier} AS tier)
                 INSERT INTO invitation_attempts(id,account_id,organization_id,owner_id,recipient_key,kind,tier,attempted_at,day)
                 SELECT ?,?,?,?,?,?,current.tier,?,? FROM current
                 WHERE (SELECT COUNT(*) FROM invitation_attempts WHERE organization_id=? AND owner_id=? AND day=?)
                   < CASE WHEN current.tier='paid' THEN ? ELSE ? END
                 AND (current.tier='paid' OR (SELECT COUNT(*) FROM invitation_attempts WHERE day=? AND tier='unpaid')<?)
                 AND (SELECT COUNT(*) FROM invitation_attempts WHERE organization_id=? AND recipient_key=? AND day=?)<?
                 AND NOT EXISTS(SELECT 1 FROM invitation_attempts WHERE organization_id=? AND recipient_key=? AND attempted_at>? AND ?>0)`,
                [
                  ...tierValues,
                  id,
                  account.id,
                  account.organizationId,
                  account.createdBy,
                  attempt.recipientKey,
                  attempt.kind,
                  at,
                  today,
                  account.organizationId,
                  account.createdBy,
                  today,
                  policy.paidDaily,
                  policy.unpaidDaily,
                  today,
                  policy.unpaidTotalDaily,
                  account.organizationId,
                  attempt.recipientKey,
                  today,
                  policy.recipientDaily,
                  account.organizationId,
                  attempt.recipientKey,
                  Policy.cooldownStart(policy, at),
                  policy.recipientCooldownMinutes,
                ],
              ),
              sql(
                `SELECT EXISTS(SELECT 1 FROM invitation_attempts WHERE id=?) AS admitted,
                 ${tier} AS tier,
                 (SELECT COUNT(*) FROM invitation_attempts WHERE organization_id=? AND owner_id=? AND day=?) AS organization,
                 (SELECT COUNT(*) FROM invitation_attempts WHERE day=? AND tier='unpaid') AS unpaidTotal,
                 (SELECT COUNT(*) FROM invitation_attempts WHERE organization_id=? AND recipient_key=? AND day=?) AS recipientToday,
                 (SELECT MAX(attempted_at) FROM invitation_attempts WHERE organization_id=? AND recipient_key=?) AS lastRecipient`,
                [
                  id,
                  ...tierValues,
                  account.organizationId,
                  account.createdBy,
                  today,
                  today,
                  account.organizationId,
                  attempt.recipientKey,
                  today,
                  account.organizationId,
                  attempt.recipientKey,
                ],
              ),
            ]),
          catch: unavailable,
        });
        const facts = yield* Schema.decodeUnknownEffect(Policy.Facts)(results[2]?.results[0]).pipe(
          Effect.mapError(unavailable),
        );
        if (facts.admitted === 1) return null;
        // The counts come from the same transaction as the refused insert, so one budget is full.
        // If a future change lets them disagree, refuse briefly rather than send unrecorded email.
        return Policy.refusal(policy, at, facts) ?? Policy.briefly(at, facts.tier);
      }),
    });
  });
