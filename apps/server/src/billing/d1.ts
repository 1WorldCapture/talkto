import { DateTime, Effect, Layer, Schema } from "effect";
import * as B from "@talkto/api/billing";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as Billing from "./service.js";
import * as Model from "./model.js";
import * as Telemetry from "../telemetry.js";

const workspaceColumns = `account_id AS accountId, customer_id AS customerId, subscription_id AS subscriptionId,
 subscription_json AS subscription, checked_at AS checkedAt, invoice_cursor AS invoiceCursor, lease,
 COALESCE((SELECT MAX(sequence) FROM stripe_events WHERE account_id=workspace_billing.account_id),0) AS eventHead`;
const operationColumns =
  "id,account_id AS accountId,request_key AS requestKey,plan,created_at AS createdAt,customer_id AS customerId,session_id AS sessionId,status,offer";
const trialColumns =
  "account_id AS accountId,owner_id AS ownerId,email_key AS emailKey,operation_id AS operationId,subscription_id AS subscriptionId,status,start,end,allowance";

/** D1 owns atomic reservations, event receipt, allowance deduplication, and lease fencing. */
export const layer = (database: D1Database, scope: string) =>
  Layer.sync(Billing.Store, () => {
    const db = database.withSession("first-primary");
    const sql = (query: string, values: ReadonlyArray<string | number | null> = []) =>
      db.prepare(query).bind(...values);
    const all = Effect.fn("BillingStore.read")(function* <A>(
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
    const get = Effect.fn("BillingStore.get")(function* (id: P.AccountId) {
      const row = yield* one(
        Schema.Struct({ ...Model.Workspace.fields, providerScope: Schema.String }),
        sql(
          `SELECT ${workspaceColumns},provider_scope AS providerScope FROM workspace_billing WHERE account_id=?`,
          [id],
        ),
      );
      if (row !== null && row.providerScope !== scope)
        return yield* Model.unavailable("storage.provider_scope");
      return row;
    });
    const pending = (id: P.AccountId) =>
      one(
        Model.Operation,
        sql(
          `SELECT ${operationColumns} FROM billing_operations WHERE account_id=? AND status='pending'`,
          [id],
        ),
      );
    const trial = (id: P.AccountId) =>
      one(
        Model.Trial,
        sql(`SELECT ${trialColumns} FROM billing_trials WHERE account_id=? AND provider_scope=?`, [
          id,
          scope,
        ]),
      );
    const trialEligible = (id: P.AccountId, owner: P.UserId) =>
      one(
        Schema.Struct({ eligible: Schema.Int }),
        sql(
          `SELECT 1 AS eligible WHERE NOT EXISTS(SELECT 1 FROM billing_periods WHERE account_id=?)
       AND NOT EXISTS(SELECT 1 FROM billing_trials WHERE provider_scope=? AND (owner_id=? OR account_id=?) AND (account_id<>? OR status<>'pending'))
       AND NOT EXISTS(SELECT 1 FROM starter_claims WHERE (kind='owner' AND key=?) OR (kind='account' AND key=?))
       AND (SELECT COUNT(*) FROM servers WHERE account_id=?)<=1`,
          [id, scope, owner, id, id, owner, id, id],
        ),
      ).pipe(Effect.map((row) => row !== null));
    const fence = Effect.fn("BillingStore.fence")(function* (workspace: Model.Workspace) {
      const current = yield* get(workspace.accountId);
      if (current === null || current.lease !== workspace.lease || workspace.lease === null)
        return yield* Model.conflict("Billing is being updated. Retry with the same request key.");
      return current;
    });
    const update = Effect.fn("BillingStore.update")(function* (
      workspace: Model.Workspace,
      statement: D1PreparedStatement,
    ) {
      const rows = yield* all(Schema.Struct({ accountId: P.AccountId }), statement);
      if (rows.length !== 1)
        return yield* Model.conflict("Billing is being updated. Retry with the same request key.");
      return yield* fence(workspace);
    });
    const bindTrial = Effect.fn("BillingStore.bindTrial")(function* (
      workspace: Model.Workspace,
      operation: Model.Operation,
    ) {
      if (operation.offer !== "trial" || operation.status === "expired") return;
      yield* fence(workspace);
      const claim = yield* trial(workspace.accountId);
      if (claim === null) return yield* Model.unavailable("trial.claim_missing");
      if (claim.status !== "pending") return;
      if (claim.operationId === operation.id) return;
      yield* batch([
        sql(
          `UPDATE billing_trials SET operation_id=? WHERE account_id=? AND provider_scope=? AND status='pending'
          AND (operation_id IS NULL OR operation_id=?)
          AND EXISTS(SELECT 1 FROM billing_operations WHERE id=? AND account_id=? AND offer='trial' AND status<>'expired')
          AND EXISTS(SELECT 1 FROM workspace_billing WHERE account_id=? AND lease=?)`,
          [
            operation.id,
            workspace.accountId,
            scope,
            operation.id,
            operation.id,
            workspace.accountId,
            workspace.accountId,
            workspace.lease,
          ],
        ),
      ]);
      yield* fence(workspace);
      if ((yield* trial(workspace.accountId))?.operationId !== operation.id)
        return yield* Model.unavailable("trial.operation_binding");
    });
    return Billing.Store.of({
      get,
      refresh: fence,
      pending,
      bindTrial,
      trial,
      trialEligible,
      claimTrial: Effect.fn("BillingStore.claimTrial")(
        function* (workspace, owner, emailKey, legacyEmailKey, at, dailyLimit) {
          const existing = yield* trial(workspace.accountId);
          // The original checkout can be replayed after activation, but reserve()
          // below rejects a different trial intent once the claim has been spent.
          if (existing !== null) {
            if (
              existing.ownerId !== owner ||
              (existing.emailKey !== emailKey && existing.emailKey !== legacyEmailKey)
            )
              return yield* Model.conflict("This organization is not eligible for another trial.");
            return;
          }
          if (!(yield* trialEligible(workspace.accountId, owner)))
            return yield* Model.conflict("This owner or organization is not eligible for a trial.");
          const rows = yield* all(
            Model.Trial,
            sql(
              `INSERT INTO billing_trials(account_id,provider_scope,owner_id,email_key,claimed_at)
           SELECT account_id,provider_scope,?,?,? FROM workspace_billing WHERE account_id=? AND lease=?
           AND (SELECT COUNT(*) FROM billing_trials WHERE provider_scope=? AND claimed_at>=?)<?
           AND (SELECT COUNT(*) FROM servers WHERE account_id=?)<=1
           AND NOT EXISTS(SELECT 1 FROM starter_claims WHERE (kind='owner' AND key=?) OR (kind='account' AND key=?))
           AND NOT EXISTS(SELECT 1 FROM billing_trials WHERE provider_scope=? AND email_key=?)
           ON CONFLICT DO NOTHING RETURNING ${trialColumns}`,
              [
                owner,
                emailKey,
                at,
                workspace.accountId,
                workspace.lease,
                scope,
                Math.floor(at / 86400000) * 86400000,
                dailyLimit,
                workspace.accountId,
                owner,
                workspace.accountId,
                scope,
                legacyEmailKey,
              ],
            ),
          );
          if (rows.length !== 1)
            return yield* Model.conflict(
              "A trial is not available for this account right now. You can still choose a paid plan.",
            );
        },
      ),
      activateTrial: Effect.fn("BillingStore.activateTrial")(function* (workspace, observation) {
        let existing = yield* trial(workspace.accountId);
        if (existing === null) return yield* Model.unavailable("trial.claim_missing");
        if (existing.status !== "pending") return existing;
        if (existing.operationId === null) {
          const operation = yield* one(
            Model.Operation,
            sql(
              `SELECT ${operationColumns} FROM billing_operations WHERE id=? AND account_id=? AND offer='trial' AND status<>'expired'`,
              [observation.operationId, workspace.accountId],
            ),
          );
          if (operation !== null) {
            yield* bindTrial(workspace, operation);
            existing = yield* trial(workspace.accountId);
            if (existing === null) return yield* Model.unavailable("trial.claim_missing");
          }
        }
        const eligible =
          observation.cardKey !== null &&
          existing.operationId === observation.operationId &&
          DateTime.toEpochMillis(DateTime.makeUnsafe(observation.end)) -
            DateTime.toEpochMillis(DateTime.makeUnsafe(observation.start)) ===
            7 * 86400000;
        yield* batch([
          sql(
            `UPDATE billing_trials SET status='active',card_key=?,subscription_id=?,start=?,end=?
            WHERE account_id=? AND status='pending' AND ? AND operation_id=?
            AND NOT EXISTS(SELECT 1 FROM billing_trials WHERE provider_scope=? AND card_key=? AND account_id<>?)
            AND EXISTS(SELECT 1 FROM workspace_billing WHERE account_id=? AND lease=?)`,
            [
              observation.cardKey,
              observation.subscriptionId,
              observation.start,
              observation.end,
              workspace.accountId,
              eligible ? 1 : 0,
              observation.operationId,
              scope,
              observation.cardKey,
              workspace.accountId,
              workspace.accountId,
              workspace.lease,
            ],
          ),
          sql(
            `UPDATE billing_trials SET status='rejected',subscription_id=? WHERE account_id=? AND status='pending'
            AND EXISTS(SELECT 1 FROM workspace_billing WHERE account_id=? AND lease=?)`,
            [observation.subscriptionId, workspace.accountId, workspace.accountId, workspace.lease],
          ),
        ]);
        yield* fence(workspace);
        const result = yield* trial(workspace.accountId);
        if (result === null) return yield* Model.unavailable("trial.claim_missing");
        return result;
      }),
      acquire: Effect.fn("BillingStore.acquire")(function* (id, at, lease) {
        yield* batch([
          sql(
            "INSERT INTO workspace_billing(account_id,provider_scope) VALUES(?,?) ON CONFLICT(account_id) DO NOTHING",
            [id, scope],
          ),
          sql(
            "UPDATE workspace_billing SET lease=?,lease_until=?,attempted_at=? WHERE account_id=? AND provider_scope=? AND lease_until<=?",
            [lease, at + 120000, at, id, scope, at],
          ),
        ]);
        const row = yield* get(id);
        if (row === null) return yield* Model.unavailable("storage.provider_scope");
        if (row.lease !== lease)
          return yield* Model.conflict(
            "Another billing operation is in progress. Retry with the same request key.",
          );
        return row;
      }),
      release: (workspace) =>
        batch([
          sql(
            "UPDATE workspace_billing SET lease=NULL,lease_until=0 WHERE account_id=? AND lease=?",
            [workspace.accountId, workspace.lease],
          ),
        ]).pipe(Effect.asVoid),
      reserve: Effect.fn("BillingStore.reserve")(function* (workspace, input, at) {
        yield* fence(workspace);
        const existing = yield* one(
          Model.Operation,
          sql(
            `SELECT ${operationColumns} FROM billing_operations WHERE account_id=? AND request_key=?`,
            [workspace.accountId, input.requestKey],
          ),
        );
        if (existing !== null) {
          if (existing.plan !== input.plan || existing.offer !== (input.offer ?? "paid"))
            return yield* Model.conflict("This request key belongs to a different plan or offer.");
          yield* bindTrial(workspace, existing);
          return existing;
        }
        if ((yield* pending(workspace.accountId)) !== null)
          return yield* Model.conflict(
            "A checkout is already pending. Resume it with its original request key.",
          );
        if (input.offer === "trial" && (yield* trial(workspace.accountId))?.status !== "pending")
          return yield* Model.conflict("This organization has already used its trial.");
        const currentTrial = yield* trial(workspace.accountId);
        if (
          currentTrial?.status === "active" &&
          currentTrial.end !== null &&
          currentTrial.end > DateTime.formatIso(DateTime.makeUnsafe(at))
        )
          return yield* Model.conflict(
            "This organization still has a trial allowance. Use the trial conversion action after its messages are used, or wait until it ends.",
          );
        if (
          workspace.subscription !== null &&
          !["canceled", "incomplete_expired"].includes(workspace.subscription.status)
        )
          return yield* Model.conflict("This organization already has a subscription.");
        const paidThrough = yield* one(
          Schema.Struct({ end: M.Timestamp }),
          // A period whose payment was refunded or is disputed no longer holds paid time.
          sql(
            `SELECT end FROM billing_periods p WHERE account_id=? AND end>? AND NOT EXISTS(
          SELECT 1 FROM billing_revocations r WHERE r.account_id=p.account_id AND r.invoice_id=p.invoice_id AND r.status='active')
          LIMIT 1`,
            [workspace.accountId, DateTime.formatIso(DateTime.makeUnsafe(at))],
          ),
        );
        if (paidThrough !== null)
          return yield* Model.conflict(
            "This organization still has a paid message allowance. Start a new subscription after it ends.",
          );
        const operationId = crypto.randomUUID();
        const offer = input.offer ?? "paid";
        yield* batch([
          sql(
            `INSERT INTO billing_operations(id,account_id,request_key,plan,created_at,customer_id,offer)
        SELECT ?,account_id,?,?,?,customer_id,? FROM workspace_billing WHERE account_id=? AND lease=?
        AND (?='paid' OR EXISTS(SELECT 1 FROM billing_trials t WHERE t.account_id=workspace_billing.account_id
          AND t.provider_scope=? AND t.status='pending' AND (t.operation_id IS NULL OR EXISTS(
            SELECT 1 FROM billing_operations o WHERE o.id=t.operation_id AND o.account_id=t.account_id AND o.status='expired'))))`,
            [
              operationId,
              input.requestKey,
              input.plan,
              at,
              offer,
              workspace.accountId,
              workspace.lease,
              offer,
              scope,
            ],
          ),
          sql(
            `UPDATE billing_trials SET operation_id=? WHERE account_id=? AND provider_scope=? AND status='pending'
            AND EXISTS(SELECT 1 FROM billing_operations WHERE id=? AND offer='trial')
            AND EXISTS(SELECT 1 FROM workspace_billing WHERE account_id=? AND lease=?)`,
            [
              operationId,
              workspace.accountId,
              scope,
              operationId,
              workspace.accountId,
              workspace.lease,
            ],
          ),
        ]);
        yield* fence(workspace);
        const row = yield* one(
          Model.Operation,
          sql(`SELECT ${operationColumns} FROM billing_operations WHERE id=? AND account_id=?`, [
            operationId,
            workspace.accountId,
          ]),
        );
        if (row === null)
          return yield* Model.conflict(
            "Billing is being updated. Retry with the same request key.",
          );
        return row;
      }),
      customer: Effect.fn("BillingStore.customer")(function* (workspace, operation, customer) {
        const current = yield* update(
          workspace,
          sql(
            "UPDATE workspace_billing SET customer_id=? WHERE account_id=? AND lease=? AND (customer_id IS NULL OR customer_id=?) RETURNING account_id AS accountId",
            [customer, workspace.accountId, workspace.lease, customer],
          ),
        );
        yield* batch([
          sql(
            "UPDATE billing_operations SET customer_id=? WHERE id=? AND EXISTS(SELECT 1 FROM workspace_billing WHERE account_id=? AND lease=?)",
            [customer, operation.id, workspace.accountId, workspace.lease],
          ),
        ]);
        return current;
      }),
      session: Effect.fn("BillingStore.session")(function* (workspace, operation, session) {
        yield* batch([
          sql(
            `UPDATE billing_operations SET session_id=?,status=? WHERE id=?
        AND EXISTS(SELECT 1 FROM workspace_billing WHERE account_id=? AND lease=?)`,
            [
              session.id,
              session.result.status === "open" ? "pending" : session.result.status,
              operation.id,
              workspace.accountId,
              workspace.lease,
            ],
          ),
          sql(
            "UPDATE workspace_billing SET subscription_id=COALESCE(?,subscription_id) WHERE account_id=? AND lease=?",
            [session.subscriptionId, workspace.accountId, workspace.lease],
          ),
        ]);
        yield* fence(workspace);
      }),
      observe: Effect.fn("BillingStore.observe")(function* (workspace, observation, at) {
        const statements = observation.periods.map((period) =>
          sql(
            `INSERT INTO billing_periods(account_id,subscription_id,invoice_id,line_id,plan,plan_version,start,end,allowance)
        SELECT account_id,?,?,?,?,?,?,?,? FROM workspace_billing WHERE account_id=? AND lease=? ON CONFLICT DO NOTHING`,
            [
              period.subscriptionId,
              period.invoiceId,
              period.lineId,
              period.plan,
              period.planVersion,
              period.start,
              period.end,
              period.allowance,
              workspace.accountId,
              workspace.lease,
            ],
          ),
        );
        for (const change of observation.changes)
          statements.push(
            sql(
              `INSERT INTO billing_plan_changes(account_id,subscription_id,invoice_id,line_id,from_plan,plan,at,period_end)
        SELECT account_id,?,?,?,?,?,?,? FROM workspace_billing WHERE account_id=? AND lease=? ON CONFLICT DO NOTHING`,
              [
                change.subscriptionId,
                change.invoiceId,
                change.lineId,
                change.from,
                change.plan,
                change.at,
                change.end,
                workspace.accountId,
                workspace.lease,
              ],
            ),
          );
        // Why a payment stopped counting stays recorded; a won dispute clears it but keeps the row.
        for (const charge of observation.charges) {
          if (charge.invoiceId === null) continue;
          statements.push(
            charge.reason === null
              ? sql(
                  `UPDATE billing_revocations SET status='cleared',updated_at=? WHERE charge_id=? AND account_id=? AND status='active'
        AND EXISTS(SELECT 1 FROM workspace_billing WHERE account_id=? AND lease=?)`,
                  [at, charge.chargeId, workspace.accountId, workspace.accountId, workspace.lease],
                )
              : sql(
                  `INSERT INTO billing_revocations(charge_id,account_id,invoice_id,reason,status,revoked_at,updated_at)
        SELECT ?,account_id,?,?,'active',?,? FROM workspace_billing WHERE account_id=? AND lease=?
        ON CONFLICT(charge_id) DO UPDATE SET reason=excluded.reason,status='active',updated_at=excluded.updated_at,
         revoked_at=CASE WHEN billing_revocations.status='active' THEN billing_revocations.revoked_at ELSE excluded.revoked_at END
        WHERE billing_revocations.account_id=excluded.account_id`,
                  [
                    charge.chargeId,
                    charge.invoiceId,
                    charge.reason,
                    at,
                    at,
                    workspace.accountId,
                    workspace.lease,
                  ],
                ),
          );
        }
        statements.push(
          sql(
            `UPDATE workspace_billing SET subscription_id=?,subscription_json=?,checked_at=?,invoice_cursor=?,synced_event=?
        WHERE account_id=? AND lease=?`,
            [
              observation.subscriptionId,
              observation.subscription === null ? null : JSON.stringify(observation.subscription),
              at,
              observation.invoiceCursor,
              workspace.eventHead,
              workspace.accountId,
              workspace.lease,
            ],
          ),
        );
        yield* batch(statements);
        yield* fence(workspace);
      }),
      period: Effect.fn("BillingStore.period")(function* (id, at, start) {
        const row = yield* one(
          Schema.Struct({ ...B.PaidPeriod.fields, subscriptionId: Schema.String }),
          sql(
            "SELECT subscription_id AS subscriptionId,plan,plan_version AS planVersion,start,end,allowance FROM billing_periods WHERE account_id=? AND start<=? AND (? IS NULL OR start=?) ORDER BY start DESC LIMIT 1",
            [id, at, start ?? null, start ?? null],
          ),
        );
        if (row === null) return null;
        const { subscriptionId, ...period } = row;
        const changes = yield* all(
          Schema.Struct({ from: B.Plan, plan: B.Plan, at: M.Timestamp }),
          sql(
            `SELECT from_plan AS "from",plan,at FROM billing_plan_changes
        WHERE account_id=? AND subscription_id=? AND period_end=? AND at>=? AND at<=? ORDER BY at,invoice_id`,
            [id, subscriptionId, period.end, period.start, at],
          ),
        );
        return Model.upgraded(period, changes);
      }),
      charges: Effect.fn("BillingStore.charges")(function* (workspace) {
        const synced = yield* one(
          Schema.Struct({ syncedEvent: Schema.Int }),
          sql("SELECT synced_event AS syncedEvent FROM workspace_billing WHERE account_id=?", [
            workspace.accountId,
          ]),
        );
        const syncedEvent = synced?.syncedEvent ?? 0;
        const rows = yield* all(
          Schema.Struct({ chargeId: Schema.String }),
          sql(
            `SELECT DISTINCT object_id AS chargeId FROM stripe_events WHERE account_id=? AND object_id IS NOT NULL
        AND sequence>? AND sequence<=? ORDER BY object_id LIMIT 100`,
            [workspace.accountId, syncedEvent, workspace.eventHead],
          ),
        );
        return { chargeIds: rows.map((row) => row.chargeId), syncedEvent };
      }),
      revocation: (id, start) =>
        one(
          Model.Revocation,
          sql(
            `SELECT r.reason,r.status,r.revoked_at AS at FROM billing_revocations r
        JOIN billing_periods p ON p.account_id=r.account_id AND p.start=?
        WHERE r.account_id=? AND (r.invoice_id=p.invoice_id OR r.invoice_id IN (
          SELECT c.invoice_id FROM billing_plan_changes c
          WHERE c.account_id=p.account_id AND c.subscription_id=p.subscription_id AND c.period_end=p.end))
        ORDER BY r.status='active' DESC,r.revoked_at DESC LIMIT 1`,
            [start, id],
          ),
        ),
      downgrades: (from, until) =>
        all(
          Model.Downgrade,
          sql(
            `SELECT w.account_id AS accountId,a.organization_id AS organizationId,
         json_extract(w.subscription_json,'$.change.plan') AS plan,json_extract(w.subscription_json,'$.change.at') AS at
        FROM workspace_billing w JOIN accounts a ON a.id=w.account_id
        WHERE w.provider_scope=? AND a.organization_id IS NOT NULL AND a.deletion_requested_at IS NULL
         AND json_extract(w.subscription_json,'$.status')='active'
         AND json_extract(w.subscription_json,'$.change.at')>? AND json_extract(w.subscription_json,'$.change.at')<=?
        ORDER BY at,w.account_id LIMIT 50`,
            [scope, from, until],
          ),
        ),
      hold: (workspace, hold, heldAt) =>
        batch([
          sql(
            `INSERT INTO billing_plan_holds(account_id,subscription_id,plan,kept,at,people,held_at)
        SELECT account_id,subscription_id,?,?,?,?,? FROM workspace_billing
        WHERE account_id=? AND lease=? AND subscription_id IS NOT NULL ON CONFLICT DO NOTHING`,
            [
              hold.plan,
              hold.kept,
              hold.at,
              hold.people,
              heldAt,
              workspace.accountId,
              workspace.lease,
            ],
          ),
        ]).pipe(Effect.asVoid),
      held: (id, since) =>
        one(
          Model.Hold,
          sql(
            "SELECT plan,kept,at,people FROM billing_plan_holds WHERE account_id=? AND at>? ORDER BY at DESC LIMIT 1",
            [id, since],
          ),
        ),
      receive: (event) =>
        one(
          Schema.Struct({ accountId: P.AccountId }),
          sql(
            `INSERT INTO stripe_events(event_id,account_id,event_type,object_id)
      SELECT ?,account_id,?,? FROM workspace_billing WHERE customer_id=? AND provider_scope=? ON CONFLICT(event_id) DO NOTHING
      RETURNING account_id AS accountId`,
            [event.id, event.type, event.chargeId, event.customerId, scope],
          ),
        ).pipe(
          Effect.map((row) => row?.accountId ?? null),
          // An unrecorded event must not be acknowledged, so Stripe retries it.
          Effect.mapError(() => Model.unavailable("storage.write")),
        ),
      due: (before: M.Timestamp) =>
        all(
          Model.Due,
          sql(
            `WITH candidates AS (
      SELECT b.account_id AS id,attempted_at,checked_at,invoice_cursor,
       EXISTS(SELECT 1 FROM stripe_events e WHERE e.account_id=b.account_id AND e.sequence>b.synced_event) AS urgent
      FROM workspace_billing b WHERE provider_scope=?
     ), ranked AS (
      SELECT id,attempted_at,checked_at,urgent,ROW_NUMBER() OVER (PARTITION BY urgent ORDER BY attempted_at,id) AS position
      FROM candidates WHERE urgent OR checked_at IS NULL OR checked_at<? OR invoice_cursor IS NOT NULL
     )
     SELECT id,checked_at AS checkedAt,attempted_at AS attemptedAt FROM ranked
     ORDER BY CASE WHEN urgent AND position<=24 THEN 0 WHEN NOT urgent AND position<=6 THEN 1 ELSE 2 END,
      urgent DESC,attempted_at,id LIMIT 30`,
            [scope, before],
          ),
        ),
    });
  });
