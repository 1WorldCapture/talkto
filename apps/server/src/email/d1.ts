import { Context, Effect, Layer, Schema } from "effect";
import { productUpdatesByDefault } from "@talkto/api/email";
import * as B from "@talkto/api/billing";
import * as Model from "./model.js";
import * as Telemetry from "../telemetry.js";

/*
  The email outbox, preferences, suppression list and announcements in D1 (migration 0015). Every
  write that queues an email is an INSERT OR IGNORE on (key, user), so a repeated event is one row,
  and every send is claimed by batch before the provider is called.
*/

type Value = string | number | null;
const storage = (operation: string, cause?: unknown) =>
  Telemetry.withCause(Model.failure(`d1.${operation}`, "ambiguous"), cause);

/** A claimed outbox row. */
export const Row = Schema.Struct({
  key: Schema.String,
  userId: Schema.String,
  kind: Model.Kind,
  payload: Schema.String,
  attempts: Schema.Int,
  claimedAt: Schema.NullOr(Schema.Int),
});
/** Parsed outbox row. */
export interface Row extends Schema.Schema.Type<typeof Row> {}
/** How a claimed row ended. */
export type Outcome =
  | { readonly state: "sent"; readonly providerId: string }
  | { readonly state: "skipped" | "failed"; readonly reason: string };
/** A subscription Stripe reports as unpaid, with the end of its last paid month. */
export const PaymentProblem = Schema.Struct({
  accountId: Schema.String,
  subscriptionId: Schema.String,
  plan: Schema.NullOr(B.Plan),
  paidThrough: Schema.NullOr(Schema.String),
});
/** Parsed payment problem. */
export interface PaymentProblem extends Schema.Schema.Type<typeof PaymentProblem> {}
/** A scheduled move to a smaller plan that billing canceled to keep the current plan. */
export const PlanHold = Schema.Struct({
  accountId: Schema.String,
  subscriptionId: Schema.String,
  plan: B.Plan,
  kept: B.Plan,
  at: Schema.String,
  people: Schema.Int,
});
/** Parsed kept plan. */
export interface PlanHold extends Schema.Schema.Type<typeof PlanHold> {}
/** A product update still being queued. */
export const Announcement = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  cursor: Schema.String,
});
/** Parsed announcement. */
export interface Announcement extends Schema.Schema.Type<typeof Announcement> {}
/** A server invitation as its email needs it at send time (migration 0023). */
export const Invitation = Schema.Struct({
  email: Schema.String,
  state: Schema.String,
  sends: Schema.Int,
  expiresAt: Schema.String,
  /** 1 while its server is ready and neither the server nor its organization is being deleted. */
  live: Schema.Int,
});
/** Parsed invitation. */
export interface Invitation extends Schema.Schema.Type<typeof Invitation> {}

type Operation<A> = Effect.Effect<A, Model.Failure>;
/** Storage for TalkTo's email. */
export class Store extends Context.Service<
  Store,
  {
    /** Queue one email to an organization's owner, with the organization's name filled in. */
    readonly queueForOwner: (input: {
      readonly key: string;
      readonly kind: Model.Kind;
      readonly accountId: string;
      readonly payload: string;
      readonly at: string;
    }) => Operation<void>;
    /**
     * Queue one email about a server for `userId`, with the server's and organization's names
     * filled in. Nothing is queued while either is being deleted. True when a row was written.
     */
    readonly queueForServer: (input: {
      readonly key: string;
      readonly kind: Model.Kind;
      readonly userId: string;
      readonly accountId: string;
      readonly serverId: string;
      readonly payload: string;
      readonly at: string;
    }) => Operation<boolean>;
    /**
     * Queue one email to one person about an organization, with its payload as given: the
     * organization may already be marked for deletion. True when a row was written.
     */
    readonly queueForPerson: (input: {
      readonly key: string;
      readonly kind: Model.Kind;
      readonly userId: string;
      readonly accountId: string;
      readonly payload: string;
      readonly at: string;
    }) => Operation<boolean>;
    /** The invitation an email is for, with the address it was sent to; null once deleted. */
    readonly invitation: (id: string) => Operation<Invitation | null>;
    /** Batches claimed longer ago than `before` whose outcome was never recorded. */
    readonly stale: (before: number) => Operation<ReadonlyArray<string>>;
    /** Claim up to `limit` due rows as batch `batchId`, account emails before product updates. */
    readonly claim: (batchId: string, now: number, limit: number) => Operation<ReadonlyArray<Row>>;
    /** The rows of a batch still waiting for an outcome. */
    readonly batch: (batchId: string) => Operation<ReadonlyArray<Row>>;
    readonly finish: (
      batchId: string,
      outcomes: ReadonlyArray<{ readonly row: Row; readonly outcome: Outcome }>,
      at: string,
    ) => Operation<void>;
    /** Put a batch the provider certainly did not send back in the queue, due at `next`. */
    readonly release: (batchId: string, next: number) => Operation<void>;
    /** Emails sent or in flight since `since` (an ISO time), for the daily limit. */
    readonly sentSince: (since: string) => Operation<number>;
    /** The stored product update choice; null when the person never chose. */
    readonly preference: (userId: string) => Operation<boolean | null>;
    readonly setPreference: (
      userId: string,
      productUpdates: boolean,
      source: "settings" | "unsubscribe_link" | "one_click",
      at: string,
    ) => Operation<void>;
    readonly suppressed: (addressKey: string) => Operation<boolean>;
    readonly suppress: (
      addressKey: string,
      reason: "bounced" | "complained" | "suppressed",
      at: string,
    ) => Operation<void>;
    /** Record a webhook delivery; false when it was already applied. */
    readonly firstDelivery: (id: string, at: string) => Operation<boolean>;
    readonly paymentProblems: () => Operation<ReadonlyArray<PaymentProblem>>;
    /** Scheduled moves canceled since `since` because of a people limit. */
    readonly planHolds: (since: string) => Operation<ReadonlyArray<PlanHold>>;
    readonly queuing: () => Operation<Announcement | null>;
    readonly announcement: (id: string) => Operation<Announcement | null>;
    /**
     * Queue the announcement for the next `limit` people after its cursor who want product updates,
     * and move the cursor. Marks it queued when no one is left. Returns how many were queued.
     */
    readonly queueAnnouncement: (
      announcement: Announcement,
      limit: number,
      at: string,
    ) => Operation<number>;
  }
>()("@talkto/email/Store") {}

/** Product updates go to a person unless they turned them off (or, when opt-in, turned them on). */
const wantsUpdates = productUpdatesByDefault
  ? "NOT EXISTS(SELECT 1 FROM email_preferences p WHERE p.user_id=m.user_id AND p.product_updates=0)"
  : "EXISTS(SELECT 1 FROM email_preferences p WHERE p.user_id=m.user_id AND p.product_updates=1)";
const rowColumns = "key,user_id AS userId,kind,payload,attempts,claimed_at AS claimedAt";
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

/** The D1 store. */
export const layer = (database: D1Database) =>
  Layer.sync(Store, () => {
    const db = database.withSession("first-primary");
    const sql = (query: string, values: ReadonlyArray<Value> = []) =>
      db.prepare(query).bind(...values);
    const run = (operation: string, statement: D1PreparedStatement) =>
      Effect.tryPromise({
        try: () => statement.run(),
        catch: (cause) => storage(operation, cause),
      });
    const all = <A>(operation: string, schema: Schema.Decoder<A>, statement: D1PreparedStatement) =>
      Effect.tryPromise({
        try: () => statement.all(),
        catch: (cause) => storage(operation, cause),
      }).pipe(
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(Schema.Array(schema))(result.results).pipe(
            Effect.mapError(() => storage(operation)),
          ),
        ),
      );
    const rows = (operation: string, statement: D1PreparedStatement) =>
      Effect.tryPromise({
        try: () => statement.all(),
        catch: (cause) => storage(operation, cause),
      }).pipe(
        Effect.flatMap((result) =>
          decodeRows(result.results).pipe(Effect.mapError(() => storage(operation))),
        ),
      );
    const Count = Schema.Struct({ count: Schema.Int });
    return Store.of({
      queueForOwner: (input) =>
        run(
          "queue_owner",
          sql(
            `INSERT OR IGNORE INTO email_outbox(key,user_id,kind,account_id,payload,state,created_at)
             SELECT ?,a.created_by,?,a.id,json_set(?,'$.organization',a.name),'pending',?
             FROM accounts a WHERE a.id=? AND a.deletion_requested_at IS NULL`,
            [input.key, input.kind, input.payload, input.at, input.accountId],
          ),
        ).pipe(Effect.asVoid),
      queueForServer: (input) =>
        run(
          "queue_server",
          sql(
            `INSERT OR IGNORE INTO email_outbox(key,user_id,kind,account_id,payload,state,created_at)
             SELECT ?,?,?,a.id,json_set(?,'$.organization',a.name,'$.server',s.name),'pending',?
             FROM servers s JOIN accounts a ON a.id=s.account_id
             WHERE s.id=? AND a.id=? AND s.deletion_requested_at IS NULL AND a.deletion_requested_at IS NULL`,
            [
              input.key,
              input.userId,
              input.kind,
              input.payload,
              input.at,
              input.serverId,
              input.accountId,
            ],
          ),
        ).pipe(Effect.map((result) => result.meta.changes > 0)),
      queueForPerson: (input) =>
        run(
          "queue_person",
          sql(
            `INSERT OR IGNORE INTO email_outbox(key,user_id,kind,account_id,payload,state,created_at)
             VALUES(?,?,?,?,?,'pending',?)`,
            [input.key, input.userId, input.kind, input.accountId, input.payload, input.at],
          ),
        ).pipe(Effect.map((result) => result.meta.changes > 0)),
      invitation: (id) =>
        all(
          "invitation",
          Invitation,
          sql(
            `SELECT i.email,i.state,i.sends,i.expires_at AS expiresAt,
              CASE WHEN s.status='ready' AND s.deletion_requested_at IS NULL AND a.deletion_requested_at IS NULL THEN 1 ELSE 0 END AS live
             FROM server_invitations i JOIN servers s ON s.id=i.server_id JOIN accounts a ON a.id=i.account_id
             WHERE i.id=?`,
            [id],
          ),
        ).pipe(Effect.map((items) => items[0] ?? null)),
      stale: (before) =>
        all(
          "stale",
          Schema.Struct({ batchId: Schema.String }),
          sql(
            "SELECT DISTINCT batch_id AS batchId FROM email_outbox WHERE state='sending' AND claimed_at<? LIMIT 5",
            [before],
          ),
        ).pipe(Effect.map((items) => items.map((item) => item.batchId))),
      claim: Effect.fn("EmailStore.claim")(function* (batchId, now, limit) {
        yield* run(
          "claim",
          sql(
            `UPDATE email_outbox SET state='sending',batch_id=?,claimed_at=?,attempts=attempts+1
             WHERE rowid IN (SELECT rowid FROM email_outbox WHERE state='pending' AND next_attempt_at<=?
              ORDER BY CASE kind WHEN 'product_update' THEN 1 ELSE 0 END,created_at,key,user_id LIMIT ?)`,
            [batchId, now, now, limit],
          ),
        );
        return yield* rows(
          "claimed",
          sql(
            `SELECT ${rowColumns} FROM email_outbox WHERE batch_id=? AND state='sending' ORDER BY key,user_id`,
            [batchId],
          ),
        );
      }),
      batch: (batchId) =>
        rows(
          "batch",
          sql(
            `SELECT ${rowColumns} FROM email_outbox WHERE batch_id=? AND state='sending' ORDER BY key,user_id`,
            [batchId],
          ),
        ),
      finish: (batchId, outcomes, at) =>
        outcomes.length === 0
          ? Effect.void
          : Effect.tryPromise({
              try: () =>
                db.batch(
                  outcomes.map(({ row, outcome }) =>
                    outcome.state === "sent"
                      ? sql(
                          "UPDATE email_outbox SET state='sent',provider_id=?,sent_at=? WHERE key=? AND user_id=? AND batch_id=? AND state='sending'",
                          [outcome.providerId, at, row.key, row.userId, batchId],
                        )
                      : sql(
                          "UPDATE email_outbox SET state=?,reason=? WHERE key=? AND user_id=? AND batch_id=? AND state='sending'",
                          [outcome.state, outcome.reason, row.key, row.userId, batchId],
                        ),
                  ),
                ),
              catch: (cause) => storage("finish", cause),
            }).pipe(Effect.asVoid),
      release: (batchId, next) =>
        run(
          "release",
          sql(
            "UPDATE email_outbox SET state='pending',batch_id=NULL,claimed_at=NULL,next_attempt_at=? WHERE batch_id=? AND state='sending'",
            [next, batchId],
          ),
        ).pipe(Effect.asVoid),
      sentSince: (since) =>
        all(
          "sent_since",
          Count,
          sql(
            "SELECT COUNT(*) AS count FROM email_outbox WHERE (state='sent' AND sent_at>=?) OR state='sending'",
            [since],
          ),
        ).pipe(Effect.map((items) => items[0]?.count ?? 0)),
      preference: (userId) =>
        all(
          "preference",
          Schema.Struct({ productUpdates: Schema.Literals([0, 1]) }),
          sql("SELECT product_updates AS productUpdates FROM email_preferences WHERE user_id=?", [
            userId,
          ]),
        ).pipe(
          Effect.map((items) => (items[0] === undefined ? null : items[0].productUpdates === 1)),
        ),
      setPreference: (userId, productUpdates, source, at) =>
        run(
          "set_preference",
          sql(
            `INSERT INTO email_preferences(user_id,product_updates,source,updated_at) VALUES(?,?,?,?)
             ON CONFLICT(user_id) DO UPDATE SET product_updates=excluded.product_updates,source=excluded.source,updated_at=excluded.updated_at`,
            [userId, productUpdates ? 1 : 0, source, at],
          ),
        ).pipe(Effect.asVoid),
      suppressed: (addressKey) =>
        all(
          "suppressed",
          Count,
          sql("SELECT COUNT(*) AS count FROM email_suppressions WHERE address_key=?", [addressKey]),
        ).pipe(Effect.map((items) => (items[0]?.count ?? 0) > 0)),
      suppress: (addressKey, reason, at) =>
        run(
          "suppress",
          sql(
            "INSERT OR IGNORE INTO email_suppressions(address_key,reason,created_at) VALUES(?,?,?)",
            [addressKey, reason, at],
          ),
        ).pipe(Effect.asVoid),
      firstDelivery: (id, at) =>
        run(
          "webhook_event",
          sql("INSERT OR IGNORE INTO email_webhook_events(id,received_at) VALUES(?,?)", [id, at]),
        ).pipe(Effect.map((result) => result.meta.changes > 0)),
      paymentProblems: () =>
        all(
          "payment_problems",
          PaymentProblem,
          sql(
            `SELECT w.account_id AS accountId,w.subscription_id AS subscriptionId,
              json_extract(w.subscription_json,'$.plan') AS plan,
              (SELECT MAX(b.end) FROM billing_periods b WHERE b.account_id=w.account_id) AS paidThrough
             FROM workspace_billing w
             WHERE w.subscription_id IS NOT NULL
              AND json_extract(w.subscription_json,'$.status') IN ('past_due','unpaid')
             ORDER BY w.account_id LIMIT 100`,
          ),
        ),
      planHolds: (since) =>
        all(
          "plan_holds",
          PlanHold,
          sql(
            `SELECT account_id AS accountId,subscription_id AS subscriptionId,plan,kept,at,people
             FROM billing_plan_holds WHERE held_at>? ORDER BY held_at LIMIT 100`,
            [since],
          ),
        ),
      queuing: () =>
        all(
          "queuing",
          Announcement,
          sql(
            "SELECT id,subject,body,cursor FROM email_announcements WHERE state='queuing' ORDER BY created_at,id LIMIT 1",
          ),
        ).pipe(Effect.map((items) => items[0] ?? null)),
      announcement: (id) =>
        all(
          "announcement",
          Announcement,
          sql("SELECT id,subject,body,cursor FROM email_announcements WHERE id=?", [id]),
        ).pipe(Effect.map((items) => items[0] ?? null)),
      queueAnnouncement: Effect.fn("EmailStore.queueAnnouncement")(
        function* (announcement, limit, at) {
          const people = yield* all(
            "announcement_people",
            Schema.Struct({ userId: Schema.String }),
            sql(
              `SELECT DISTINCT m.user_id AS userId FROM memberships m
             WHERE m.status='active' AND m.user_id>? ORDER BY m.user_id LIMIT ?`,
              [announcement.cursor, limit],
            ),
          );
          const last = people.at(-1)?.userId ?? announcement.cursor;
          const payload = JSON.stringify({
            kind: "product_update",
            announcementId: announcement.id,
          });
          const statements = people.map((person) =>
            sql(
              `INSERT OR IGNORE INTO email_outbox(key,user_id,kind,account_id,payload,state,created_at)
             SELECT ?,m.user_id,'product_update',NULL,?,'pending',? FROM (SELECT ? AS user_id) m WHERE ${wantsUpdates}`,
              [`product_update:${announcement.id}`, payload, at, person.userId],
            ),
          );
          statements.push(
            sql(
              `UPDATE email_announcements SET cursor=?,
              recipients=recipients+(SELECT COUNT(*) FROM email_outbox WHERE key=? AND user_id>? AND user_id<=?),
              state=CASE WHEN ?<? THEN 'queued' ELSE state END,
              queued_at=CASE WHEN ?<? THEN ? ELSE queued_at END
             WHERE id=? AND state='queuing' AND cursor=?`,
              [
                last,
                `product_update:${announcement.id}`,
                announcement.cursor,
                last,
                people.length,
                limit,
                people.length,
                limit,
                at,
                announcement.id,
                announcement.cursor,
              ],
            ),
          );
          yield* Effect.tryPromise({
            try: () => db.batch(statements),
            catch: (cause) => storage("queue_announcement", cause),
          });
          return people.length;
        },
      ),
    });
  });
