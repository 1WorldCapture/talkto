import { DurableObject } from "cloudflare:workers";
import { DateTime, Option, Schema } from "effect";
import * as U from "@talkto/api/metering";
import * as M from "@talkto/api/models";
import * as Model from "./model.js";
import * as P from "@talkto/api/platform";
import { free, share, starter } from "@talkto/api/pricing";
import * as FreePlan from "../free-plan.js";
import * as Pool from "../files/pool.js";
import * as Entitlements from "../account-entitlements.js";
import * as History from "../history/model.js";
import * as PoolAuthority from "../files/pool-authority.js";
import * as BudgetAuthority from "../budgets/authority.js";
import * as BudgetModel from "../budgets/model.js";
import { run } from "@talkto/telemetry/effect";
import * as EmailModel from "../email/model.js";
import * as EmailHttp from "../email/http.js";

const periodRow = Schema.Struct({
  ...Model.Period.fields,
  reserved: M.Count,
  used: M.Count,
  lastReportedAt: Schema.NullOr(M.Timestamp),
  carried: M.Count,
  bonus: M.Count,
});
const allocationRow = Schema.Struct({
  ...Model.Allocation.fields,
  closed: Schema.Literals([0, 1]),
});
const decodePeriod = Schema.decodeUnknownSync(periodRow);
const decodeAllocation = Schema.decodeUnknownSync(allocationRow);
/** An allocation with when its hold ends on this object's clock; null for the short hold. */
const decodeHeldAllocation = Schema.decodeUnknownSync(
  Schema.Struct({ ...allocationRow.fields, holdUntil: Schema.NullOr(M.Timestamp) }),
);
const openBlockRow = Schema.Struct({ id: M.RequestKey, serverId: M.ServerId, capacity: M.Count });
const recallRow = Schema.Struct({
  id: M.RequestKey,
  serverId: M.ServerId,
  due: Schema.Number,
  attempts: M.Count,
  closed: Schema.NullOr(Schema.Literals([0, 1])),
  holdUntil: Schema.NullOr(M.Timestamp),
});
const decodeRecalls = Schema.decodeUnknownSync(Schema.Array(recallRow));
/**
 * A block gets the short hold when its period ends sooner than a hold and this margin, so every
 * held block is reported at least this long before its period ends and counts there.
 */
const holdMargin = 60_000;
/** A recall the server did not act on is asked again after 1, 2, 4… seconds, at most a minute. */
const recallRetry = (attempts: number) => Math.min(60_000, 1000 * 2 ** Math.min(6, attempts - 1));
const realNow = () => DateTime.toEpochMillis(DateTime.nowUnsafe());
/**
 * Everything a period can fund: its allowance, free messages carried into it, share-link messages
 * added to it, and overdraft.
 */
const fundable = (period: typeof periodRow.Type) =>
  period.allowance + period.carried + period.bonus + period.overdraft;
/** One share-link bonus: its ID (`<referral>:<side>`, 1 to 128 characters) and its size. */
const BonusRequest = Schema.Struct({
  accountId: P.AccountId,
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  messages: Schema.Literal(share.messages),
});
const PriorBonus = Schema.Struct({ outcome: Schema.Literals(["added", "not_added"]) });
const time = () => M.Timestamp.make(DateTime.formatIso(DateTime.nowUnsafe()));
const iso = (ms: number) => M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(ms)));
/** The Free plan month that starts at `start` ends at the next UTC month boundary. */
const freeEnd = (start: M.Timestamp) => iso(FreePlan.nextMonth(Date.parse(start)));
const periods =
  "account_id AS accountId,start,end,allowance,overdraft,kind,reserved,used,last_reported_at AS lastReportedAt,carried,bonus";
const allocations =
  "id,server_id AS serverId,period_start AS periodStart,period_end AS periodEnd,capacity,used,closed";

/** Workspace-wide capacity authority. Only private Worker bindings can reach these RPCs. */
export class WorkspaceQuota extends DurableObject<Env> {
  private readonly pool;
  protected readonly budgets;
  /** Whether this request queued recalls, so it makes sure the alarm will run them. */
  private recallsQueued = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS quota_periods(account_id TEXT NOT NULL,start TEXT PRIMARY KEY,end TEXT,allowance INTEGER NOT NULL,overdraft INTEGER NOT NULL,reserved INTEGER NOT NULL DEFAULT 0,used INTEGER NOT NULL DEFAULT 0,last_reported_at TEXT,kind TEXT NOT NULL DEFAULT 'paid',carried INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS quota_allocations(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,period_start TEXT NOT NULL,period_end TEXT,capacity INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE INDEX IF NOT EXISTS quota_active_server ON quota_allocations(server_id,closed);
    `);
    const columns = ctx.storage.sql
      .exec<{ name: string; notnull: number }>("PRAGMA table_info(quota_periods)")
      .toArray();
    if (!columns.some((column) => column.name === "kind"))
      ctx.storage.sql.exec(
        "ALTER TABLE quota_periods ADD COLUMN kind TEXT NOT NULL DEFAULT 'paid'",
      );
    // Free messages carried into the first paid period; zero on every period stored before it.
    if (!columns.some((column) => column.name === "carried"))
      ctx.storage.sql.exec(
        "ALTER TABLE quota_periods ADD COLUMN carried INTEGER NOT NULL DEFAULT 0",
      );
    // Authorities created before the free start required an end. Rebuild them once so a starter
    // period can be stored without one; every existing row and counter is copied unchanged.
    if (columns.some((column) => column.name === "end" && column.notnull === 1))
      ctx.storage.transactionSync(() =>
        ctx.storage.sql.exec(`
          CREATE TABLE quota_periods_open(account_id TEXT NOT NULL,start TEXT PRIMARY KEY,end TEXT,allowance INTEGER NOT NULL,overdraft INTEGER NOT NULL,reserved INTEGER NOT NULL DEFAULT 0,used INTEGER NOT NULL DEFAULT 0,last_reported_at TEXT,kind TEXT NOT NULL DEFAULT 'paid',carried INTEGER NOT NULL DEFAULT 0) STRICT;
          INSERT INTO quota_periods_open(account_id,start,end,allowance,overdraft,reserved,used,last_reported_at,kind,carried)
            SELECT account_id,start,end,allowance,overdraft,reserved,used,last_reported_at,kind,carried FROM quota_periods;
          DROP TABLE quota_periods;
          ALTER TABLE quota_periods_open RENAME TO quota_periods;
          CREATE TABLE quota_allocations_open(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,period_start TEXT NOT NULL,period_end TEXT,capacity INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0) STRICT;
          INSERT INTO quota_allocations_open(id,server_id,period_start,period_end,capacity,used,closed)
            SELECT id,server_id,period_start,period_end,capacity,used,closed FROM quota_allocations;
          DROP TABLE quota_allocations;
          ALTER TABLE quota_allocations_open RENAME TO quota_allocations;
          CREATE INDEX IF NOT EXISTS quota_active_server ON quota_allocations(server_id,closed);
        `),
      );
    // Share-link messages added to a free allowance (docs/share-links-spec.md); zero everywhere
    // else. Added after the rebuild above, which copies only the columns it knows.
    if (
      !ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(quota_periods)")
        .toArray()
        .some((column) => column.name === "bonus")
    )
      ctx.storage.sql.exec("ALTER TABLE quota_periods ADD COLUMN bonus INTEGER NOT NULL DEFAULT 0");
    // One row per share-link bonus ever asked for, so a retried bonus never adds twice.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS quota_bonuses(id TEXT PRIMARY KEY,period_start TEXT NOT NULL,messages INTEGER NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN ('added','not_added')),at TEXT NOT NULL) STRICT;
    `);
    // Usage warnings to email (docs/email.md): one row per period and threshold, recorded in the
    // same transaction as the usage that crossed it, then handed to the D1 outbox by the alarm.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS quota_email_notices(period_start TEXT NOT NULL,threshold INTEGER NOT NULL,account_id TEXT NOT NULL,period_end TEXT,kind TEXT NOT NULL,used INTEGER NOT NULL,allowance INTEGER NOT NULL,queued INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(period_start,threshold)) STRICT;
    `);
    // A paid period whose payment was refunded or disputed ends early; its original end is kept
    // here so a won dispute restores it. One row per revoked period.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS quota_revocations(start TEXT PRIMARY KEY,end TEXT NOT NULL,revoked_at TEXT NOT NULL) STRICT;
    `);
    // When each block's hold ends on this object's clock (docs/message-metering.md, "Held blocks");
    // null for the short hold and for every block granted before holds. After the rebuild above,
    // which copies only the columns it knows.
    if (
      !ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(quota_allocations)")
        .toArray()
        .some((column) => column.name === "hold_until")
    )
      ctx.storage.sql.exec("ALTER TABLE quota_allocations ADD COLUMN hold_until TEXT");
    // Open blocks by period, for recalls; closed rows leave the index. One row per held block the
    // quota object has asked its server to close, kept until the block closes or its hold ends, so
    // a recall survives restarts and is asked again until it is done.
    ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS quota_open_period ON quota_allocations(period_start) WHERE closed=0;
      CREATE TABLE IF NOT EXISTS quota_recalls(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,due INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0) STRICT, WITHOUT ROWID;
    `);
    this.pool = PoolAuthority.make(
      ctx.storage,
      env,
      () => this.meteringTime(),
      () => this.onFreePlan(),
    );
    this.budgets = BudgetAuthority.make(
      ctx.storage,
      () => Date.parse(this.meteringTime()),
      () => this.budgetPlan(),
      () => this.budgetOverrides(),
    );
  }
  /**
   * Lease read or admin units to one server (docs/plan-limits.md). Owner-pilot and self-hosted
   * organizations are unlimited; everyone else spends from the plan's monthly budgets.
   */
  async budget(input: BudgetModel.Request): Promise<BudgetModel.Grant> {
    const request = Schema.decodeUnknownSync(BudgetModel.Request)(input);
    if (Entitlements.covers(Pool.limits(this.env).unlimitedAccounts, request.accountId))
      return { kind: "unlimited" };
    const grant = this.budgets.lease(request);
    await this.scheduleBudgetSave();
    return grant;
  }
  /**
   * Make sure the alarm runs by the time unsaved budget counts are due. An earlier alarm (a usage
   * warning) is kept; `alarm` saves the counts or finds leases still coming, then calls this again.
   */
  private async scheduleBudgetSave() {
    const due = this.budgets.due();
    if (due === null) return;
    const wait = due - Date.parse(this.meteringTime());
    const at = Date.now() + Math.min(BudgetAuthority.saveMillis, Math.max(0, wait));
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null || scheduled > at) await this.ctx.storage.setAlarm(at);
  }
  /**
   * The paid plan the budgets follow: the pool's, unless its period was refunded or disputed
   * (`revoke`), which ends its budgets at once with no renewal grace, until a won dispute restores
   * it.
   */
  private budgetPlan() {
    return this.pool
      .plan()
      .pipe(
        Option.filter(
          (period) =>
            this.ctx.storage.sql
              .exec("SELECT 1 FROM quota_revocations WHERE start=?", period.start)
              .toArray().length === 0,
        ),
      );
  }
  /** This month's read and admin counts. */
  async budgetUsage(): Promise<BudgetModel.Usage> {
    return this.budgets.read();
  }
  /**
   * Whether the organization is on the standing Free plan: its latest period is a Free month, or a
   * free start still in use while the switch is on (it becomes Free at its next send or read).
   */
  private onFreePlan() {
    const latest = this.current(false);
    return (
      latest !== null &&
      (latest.kind === "free" ||
        (latest.kind === "starter" && latest.end === null && this.freePlanEnabled()))
    );
  }
  /** Numbers that replace a plan's; only verification subclasses supply any. */
  protected budgetOverrides(): BudgetModel.Overrides | null {
    return null;
  }
  /** Reserve stored-file space in the organization pool; returns `full` as a value, never throws it. */
  async reserveStorage(input: Pool.Request): Promise<Pool.Outcome> {
    return this.pool.reserve(input);
  }
  /** Stop counting a deleted server's transfers. */
  async releaseStorage(input: { readonly accountId: P.AccountId; readonly serverId: M.ServerId }) {
    this.pool.release(input);
    History.forgetSize(this.ctx.storage, input.serverId);
    return { ok: true };
  }
  /** Billing records the confirmed paid plan; the pool follows it only inside its period. */
  async publishStoragePlan(input: Pool.PlanPeriod) {
    return this.pool.publish(input);
  }
  async readStorage(accountId: P.AccountId): Promise<Pool.Usage> {
    return this.pool.read(accountId);
  }
  /**
   * The history window this organization's servers apply (docs/production-deployment.md, "History retention"). The paid
   * plan billing last confirmed decides it, even after that plan lapses, so a lapse never
   * shortens history. Otherwise the standing free plan's window applies to organizations on it,
   * and everyone else (trials, no plan) keeps everything. Owner-pilot and self-hosted
   * organizations always keep everything. Each server applies a shorter window only after its
   * own grace period (history/model.ts).
   */
  async historyPolicy(input: { readonly accountId: P.AccountId }): Promise<History.Policy> {
    const { accountId } = Schema.decodeUnknownSync(Schema.Struct({ accountId: P.AccountId }))(
      input,
    );
    if (Entitlements.covers(Pool.limits(this.env).unlimitedAccounts, accountId))
      return History.keepAll;
    const paid = this.pool.plan();
    if (Option.isSome(paid)) return History.forPlan(paid.value.plan);
    await this.settled();
    return this.current(false)?.kind === "free" ? History.forPlan("free") : History.keepAll;
  }
  /**
   * Record one server's history size and answer how much it may keep in place (docs/plan-limits.md,
   * "History storage"). The plan's organization cap is shared in proportion to what each server
   * holds, and no server keeps more than the per-server cap. Null: no cap applies (trials, no
   * plan, owner-pilot and self-hosted organizations).
   */
  async historyCap(input: {
    readonly accountId: P.AccountId;
    readonly serverId: M.ServerId;
    readonly bytes: number;
  }): Promise<{ readonly targetBytes: number | null }> {
    const request = Schema.decodeUnknownSync(
      Schema.Struct({ accountId: P.AccountId, serverId: M.ServerId, bytes: M.Count }),
    )(input);
    const policy = await this.historyPolicy({ accountId: request.accountId });
    return {
      targetBytes: History.recordSize(
        this.ctx.storage,
        request.serverId,
        request.bytes,
        policy.plan,
        this.meteringTime(),
        this.historyCapOverride(),
      ),
    };
  }
  /** An organization cap in bytes that replaces the plan's; only verification subclasses set one. */
  protected historyCapOverride(): number | null {
    return null;
  }
  /** Immutable periods never reset counters when delivered again or out of order. */
  async publish(input: Model.Period) {
    const value = Schema.decodeUnknownSync(Model.Period)(input);
    const kind = value.kind ?? "paid";
    if (kind === "starter") {
      if (value.end !== null || value.allowance !== starter.messages || value.overdraft !== 0)
        throw new Error("Invalid starter allowance");
    } else if (value.end === null || value.start >= value.end)
      throw new Error("Invalid quota period");
    if (kind === "trial" && (value.allowance !== 500 || value.overdraft !== 0))
      throw new Error("Invalid trial allowance");
    if (
      kind === "free" &&
      (value.allowance !== free.messages ||
        value.overdraft !== 0 ||
        value.end !== freeEnd(value.start))
    )
      throw new Error("Invalid Free plan month");
    const accepted = this.ctx.storage.transactionSync(() => {
      const latest = this.current(false);
      if (latest !== null && latest.accountId !== value.accountId)
        throw new Error("Quota workspace cannot change");
      const row = this.ctx.storage.sql
        .exec(`SELECT ${periods} FROM quota_periods WHERE start=?`, value.start)
        .toArray()[0];
      if (row !== undefined) {
        const existing = decodePeriod(row);
        // A retired starter carries the end its paid replacement gave it; a replay still matches.
        const sameEnd =
          existing.end === value.end || (kind === "starter" && existing.kind === "starter");
        // A paid upgrade raises the same period's allowance; counters and held blocks are kept.
        // An allowance never falls inside a period, so a stale lower value changes nothing.
        if (
          sameEnd &&
          kind === "paid" &&
          existing.kind === "paid" &&
          existing.overdraft === value.overdraft &&
          value.allowance !== existing.allowance
        ) {
          if (value.allowance > existing.allowance)
            this.ctx.storage.sql.exec(
              "UPDATE quota_periods SET allowance=? WHERE start=?",
              value.allowance,
              value.start,
            );
          return true;
        }
        return (
          sameEnd &&
          existing.allowance === value.allowance &&
          existing.overdraft === value.overdraft &&
          existing.kind === kind
        );
      }
      // The free start is one lifetime allowance: never after, beside or instead of another period.
      if (kind === "starter" && latest !== null) return false;
      // The Free plan opens on an organization with no period, or replaces a free start in use.
      if (kind === "free" && latest !== null && !(latest.kind === "starter" && latest.end === null))
        return false;
      let carried = 0;
      if (latest !== null && (latest.end === null || value.start < latest.end)) {
        if (latest.kind === "free") {
          // A paid purchase ends the Free month when it starts; unused Free messages do not carry.
          // A month that renewed after the paid start ends where it began, so it never counts.
          if (kind !== "paid") return false;
        } else if (latest.kind === "starter") {
          // Joining Free retires the free start; its unspent messages do not carry over.
          if (kind === "free") {
            if (value.start <= latest.start) return false;
          } else {
            // An explicit paid purchase retires the free start, and its unspent messages become
            // extra capacity in this first paid period. This insert happens once: a replay finds the
            // row above. A block a server still holds stays the starter's; `close` hands its unused
            // part to this period, so each free message is carried exactly once.
            if (kind !== "paid" || value.start <= latest.start) return false;
            carried = Math.max(0, latest.allowance + latest.bonus - latest.reserved);
          }
        } else if (
          // Early paid conversion is safe only when no old capacity can still be
          // spent. No counter reset, reclaimed live lease, or unfenced server write.
          latest.kind !== "trial" ||
          kind !== "paid" ||
          value.start <= latest.start ||
          latest.used !== latest.allowance ||
          latest.reserved !== latest.used
        )
          return false;
        this.ctx.storage.sql.exec(
          "UPDATE quota_periods SET end=? WHERE start=?",
          value.start > latest.start ? value.start : latest.start,
          latest.start,
        );
        // Blocks servers hold from the period that just ended stop now, not at their hold's end.
        this.recall(latest.start, null);
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO quota_periods(account_id,start,end,allowance,overdraft,kind,carried) VALUES(?,?,?,?,?,?,?)",
        value.accountId,
        value.start,
        value.end,
        value.allowance,
        value.overdraft,
        kind,
        carried,
      );
      return true;
    });
    await this.scheduleRecalls();
    return { ok: accepted };
  }
  /**
   * End a paid period at `at` because its payment was refunded or disputed. New blocks are refused
   * from then on, as after an unpaid renewal, and servers holding a block are asked to close it
   * (`recall`) until each has. Idempotent: a period already revoked keeps its first end, and a
   * replay asks again for any block still open. False when no paid period starts at `start`.
   */
  async revoke(input: {
    readonly accountId: P.AccountId;
    readonly start: M.Timestamp;
    readonly at: M.Timestamp;
  }) {
    const value = Schema.decodeUnknownSync(
      Schema.Struct({ accountId: P.AccountId, start: M.Timestamp, at: M.Timestamp }),
    )(input);
    const ok = this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec(`SELECT ${periods} FROM quota_periods WHERE start=?`, value.start)
        .toArray()[0];
      if (row === undefined) return false;
      const period = decodePeriod(row);
      if (period.accountId !== value.accountId || (period.kind ?? "paid") !== "paid") return false;
      if (period.end === null) return false;
      // Blocks servers hold run out now, as they did when every block closed within seconds.
      this.recall(value.start, null);
      if (this.revoked(value.start)) return true;
      // Never before the period began, and never later than it would have ended anyway.
      const end =
        value.at < period.start ? period.start : value.at > period.end ? period.end : value.at;
      this.ctx.storage.sql.exec(
        "INSERT INTO quota_revocations(start,end,revoked_at) VALUES(?,?,?)",
        value.start,
        period.end,
        value.at,
      );
      this.ctx.storage.sql.exec("UPDATE quota_periods SET end=? WHERE start=?", end, value.start);
      return true;
    });
    await this.scheduleRecalls();
    return { ok };
  }
  /** Give a revoked paid period back its original end (a dispute was won). Idempotent. */
  async restore(input: { readonly accountId: P.AccountId; readonly start: M.Timestamp }) {
    const value = Schema.decodeUnknownSync(
      Schema.Struct({ accountId: P.AccountId, start: M.Timestamp }),
    )(input);
    this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec("SELECT end FROM quota_revocations WHERE start=?", value.start)
        .toArray()[0];
      if (row === undefined) return;
      const { end } = Schema.decodeUnknownSync(Schema.Struct({ end: M.Timestamp }))(row);
      this.ctx.storage.sql.exec(
        "UPDATE quota_periods SET end=? WHERE start=? AND account_id=? AND kind='paid'",
        end,
        value.start,
        value.accountId,
      );
      this.ctx.storage.sql.exec("DELETE FROM quota_revocations WHERE start=?", value.start);
    });
    return { ok: true };
  }
  protected meteringTime() {
    return time();
  }
  /** The Free plan switch as this object sees it; verification subclasses may flip it. */
  protected freePlanEnabled() {
    return FreePlan.isEnabled(this.env);
  }
  /** The latest period (or the latest already started); a period that ended where it began never counts. */
  private current(active = true) {
    const row = active
      ? this.ctx.storage.sql
          .exec(
            `SELECT ${periods} FROM quota_periods WHERE start<=? AND (end IS NULL OR end>start) ORDER BY start DESC LIMIT 1`,
            this.meteringTime(),
          )
          .toArray()[0]
      : this.ctx.storage.sql
          .exec(
            `SELECT ${periods} FROM quota_periods WHERE end IS NULL OR end>start ORDER BY start DESC LIMIT 1`,
          )
          .toArray()[0];
    return row === undefined ? null : decodePeriod(row);
  }
  /**
   * Keep the Free plan current before a spend or a read. With the switch on, a free start still in
   * use becomes the Free plan now, and its unspent messages do not carry over. An ended Free month
   * is followed by the month that contains now, whatever the switch says, so an organization on
   * Free keeps it. Nothing renews once a paid period has replaced Free.
   */
  private settle() {
    const latest = this.current(false);
    if (latest === null) return;
    const now = this.meteringTime();
    let start: M.Timestamp | null = null;
    if (latest.kind === "starter" && latest.end === null) {
      if (!this.freePlanEnabled() || now <= latest.start) return;
      this.ctx.storage.sql.exec("UPDATE quota_periods SET end=? WHERE start=?", now, latest.start);
      // A block a server holds from the free start stops now; its unspent messages do not carry.
      this.recall(latest.start, null);
      start = now;
    } else if (latest.kind === "free" && latest.end !== null && now >= latest.end)
      start = iso(FreePlan.monthStart(Date.parse(now)));
    if (start === null) return;
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO quota_periods(account_id,start,end,allowance,overdraft,kind) VALUES(?,?,?,?,0,'free')",
      latest.accountId,
      start,
      freeEnd(start),
      free.messages,
    );
  }
  /** Settle the Free plan in a transaction, then make sure any recall it queued will run. */
  private async settled() {
    this.ctx.storage.transactionSync(() => this.settle());
    await this.scheduleRecalls();
  }
  /** Whether the paid period starting at `start` was refunded or disputed and not restored. */
  private revoked(start: M.Timestamp) {
    return (
      this.ctx.storage.sql.exec("SELECT 1 FROM quota_revocations WHERE start=?", start).toArray()
        .length > 0
    );
  }
  /**
   * Whether the period is close to its limit: what is left unreserved is less than a block, or less
   * than all the capacity servers hold open. Then a block gets today's short hold, so no server
   * waits on capacity another server holds unused.
   */
  private near(period: typeof periodRow.Type) {
    const left = fundable(period) - period.reserved;
    return left < Math.max(Model.blockUnits, period.reserved - period.used);
  }
  /**
   * The hold a new block in this period gets at `at`: the short hold (0) near the limit, in a
   * revoked period, and when the period ends within a hold and a minute, so its usage is reported
   * (and its usage warning recorded) before the period ends.
   */
  private holdFor(period: typeof periodRow.Type, at: M.Timestamp) {
    if (this.near(period) || this.revoked(period.start)) return 0;
    if (
      period.end !== null &&
      Date.parse(period.end) - Date.parse(at) < Model.holdSeconds * 1000 + holdMargin
    )
      return 0;
    return Model.holdSeconds;
  }
  /**
   * Ask every server but `except` that holds a block in this period, with its hold not yet ended,
   * to close it: near the limit, when a grant is refused, and when the period is revoked or ends
   * early. Each block is queued once (`quota_recalls`); the alarm asks its server at once, and asks
   * again with backoff until the block closes or its hold has ended. Blocks with the short hold
   * close within seconds anyway and are not asked.
   */
  private recall(periodStart: M.Timestamp, except: M.ServerId | null) {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO quota_recalls(id,server_id,due) SELECT id,server_id,? FROM quota_allocations WHERE closed=0 AND period_start=? AND hold_until>? AND server_id IS NOT ?",
      realNow(),
      periodStart,
      this.meteringTime(),
      except,
    );
    this.recallsQueued = true;
  }
  /** After a request that may have queued recalls, make sure the alarm runs when they are due. */
  private async scheduleRecalls() {
    if (!this.recallsQueued) return;
    this.recallsQueued = false;
    await this.armRecalls();
  }
  /** Set the alarm for the next queued recall, unless it already runs by then. */
  private async armRecalls() {
    const { next } = Schema.decodeUnknownSync(
      Schema.Struct({ next: Schema.NullOr(Schema.Number) }),
    )(this.ctx.storage.sql.exec("SELECT MIN(due) AS next FROM quota_recalls").one());
    if (next === null) return;
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null || scheduled > next) await this.ctx.storage.setAlarm(next);
  }
  /**
   * Ask the servers of the recalls that are due to close their blocks (`reportUsage`). A server
   * that closes its block removes the recall (`close`); one that fails or leaves it open is asked
   * again with backoff. A recall ends once its block is closed or its hold has ended (and a margin
   * for the server's own clock): the server cannot spend from it after that, and closes it itself.
   */
  private async runRecalls() {
    const rows = decodeRecalls(
      this.ctx.storage.sql
        .exec(
          "SELECT r.id,r.server_id AS serverId,r.due,r.attempts,a.closed,a.hold_until AS holdUntil FROM quota_recalls r LEFT JOIN quota_allocations a ON a.id=r.id",
        )
        .toArray(),
    );
    if (rows.length === 0) return;
    const at = Date.parse(this.meteringTime());
    const now = realNow();
    const due = [];
    for (const row of rows) {
      if (
        row.closed !== 0 ||
        row.holdUntil === null ||
        Date.parse(row.holdUntil) + holdMargin <= at
      )
        this.ctx.storage.sql.exec("DELETE FROM quota_recalls WHERE id=?", row.id);
      else if (row.due <= now) due.push(row);
    }
    // Each server holds one block at most; the recall names it, so a block the server has since
    // replaced it with stays open.
    await Promise.all(
      due.map(async (row) => {
        try {
          await this.env.SERVERS.getByName(row.serverId).reportUsage({ id: row.id });
        } catch {
          // Asked again below.
        }
      }),
    );
    // A block that closed removed its recall; the rest are asked again later.
    const after = realNow();
    for (const row of due)
      this.ctx.storage.sql.exec(
        "UPDATE quota_recalls SET attempts=?,due=? WHERE id=?",
        row.attempts + 1,
        after + recallRetry(row.attempts + 1),
        row.id,
      );
  }
  /** Idempotent grant requests reserve at most one live block per server. */
  async allocate(input: {
    readonly id: M.RequestKey;
    readonly serverId: M.ServerId;
  }): Promise<Model.Result> {
    const request = Schema.decodeUnknownSync(
      Schema.Struct({ id: M.RequestKey, serverId: M.ServerId }),
    )(input);
    const result = this.grant(request);
    await this.scheduleRecalls();
    return result;
  }
  private grant(request: { readonly id: M.RequestKey; readonly serverId: M.ServerId }) {
    return this.ctx.storage.transactionSync((): Model.Result => {
      this.settle();
      const prior = this.ctx.storage.sql
        .exec(
          `SELECT ${allocations},hold_until AS holdUntil FROM quota_allocations WHERE id=?`,
          request.id,
        )
        .toArray()[0];
      if (prior !== undefined) {
        const { holdUntil, ...row } = decodeHeldAllocation(prior);
        if (row.serverId !== request.serverId) throw new Error("Allocation identity conflict");
        // A replayed grant gets what is left of its hold, and only while its period is current,
        // unrevoked and not close to its limit; a replay never extends a hold.
        const now = this.current();
        const at = this.meteringTime();
        const hold =
          row.closed === 0 &&
          holdUntil !== null &&
          now !== null &&
          now.start === row.periodStart &&
          (now.end === null || at < now.end) &&
          !this.revoked(now.start) &&
          !this.near(now)
            ? Math.max(0, Math.floor((Date.parse(holdUntil) - Date.parse(at)) / 1000))
            : 0;
        return {
          kind: "allocated",
          allocation: { ...row, closed: row.closed === 1 },
          holdSeconds: hold,
        };
      }
      const period = this.current();
      const now = this.meteringTime();
      if (period === null || now < period.start || (period.end !== null && now >= period.end))
        return { kind: "payment_required", periodEnd: period?.end ?? null };
      const held = this.ctx.storage.sql
        .exec(
          "SELECT id FROM quota_allocations WHERE server_id=? AND closed=0 LIMIT 1",
          request.serverId,
        )
        .toArray()[0];
      if (held !== undefined) return { kind: "pending", periodEnd: period.end };
      const remaining = fundable(period) - period.reserved;
      if (remaining <= 0) {
        if (period.used >= fundable(period)) return { kind: "exhausted", periodEnd: period.end };
        // Everything is reserved but not all used: free what other servers hold, now.
        this.recall(period.start, request.serverId);
        return { kind: "pending", periodEnd: period.end };
      }
      const capacity = Math.min(Model.blockUnits, remaining);
      const after = { ...period, reserved: period.reserved + capacity };
      const hold = this.holdFor(after, now);
      this.ctx.storage.sql.exec(
        "INSERT INTO quota_allocations(id,server_id,period_start,period_end,capacity,hold_until) VALUES(?,?,?,?,?,?)",
        request.id,
        request.serverId,
        period.start,
        period.end,
        capacity,
        hold === 0 ? null : iso(Date.parse(now) + hold * 1000),
      );
      this.ctx.storage.sql.exec(
        "UPDATE quota_periods SET reserved=reserved+? WHERE start=?",
        capacity,
        period.start,
      );
      if (this.near(after) && after.reserved - after.used > capacity)
        this.recall(period.start, request.serverId);
      return {
        kind: "allocated",
        allocation: {
          id: request.id,
          serverId: request.serverId,
          periodStart: period.start,
          periodEnd: period.end,
          capacity,
          used: 0,
          closed: false,
        },
        holdSeconds: hold,
      };
    });
  }
  /** Cumulative reports never double count. Release requires a durably closed server allocation. */
  async close(input: {
    readonly id: M.RequestKey;
    readonly serverId: M.ServerId;
    readonly used: number;
  }) {
    const request = Schema.decodeUnknownSync(
      Schema.Struct({ id: M.RequestKey, serverId: M.ServerId, used: M.Count }),
    )(input);
    const notify = this.ctx.storage.transactionSync(() => {
      const raw = this.ctx.storage.sql
        .exec(`SELECT ${allocations} FROM quota_allocations WHERE id=?`, request.id)
        .toArray()[0];
      if (raw === undefined) throw new Error("Unknown allocation");
      const row = decodeAllocation(raw);
      if (
        row.serverId !== request.serverId ||
        request.used > row.capacity ||
        request.used < row.used
      )
        throw new Error("Invalid usage report");
      this.ctx.storage.sql.exec("DELETE FROM quota_recalls WHERE id=?", row.id);
      if (row.closed) {
        if (row.used !== request.used) throw new Error("Closed usage cannot change");
        return false;
      }
      this.ctx.storage.sql.exec(
        "UPDATE quota_allocations SET used=?,closed=1 WHERE id=?",
        request.used,
        request.id,
      );
      this.ctx.storage.sql.exec(
        "UPDATE quota_periods SET used=used+?,reserved=reserved-?,last_reported_at=? WHERE start=?",
        request.used - row.used,
        row.capacity - request.used,
        this.meteringTime(),
        row.periodStart,
      );
      // A starter block closed after conversion: its unused part joins the paid period that
      // retired the starter. The allocation closed above, so this runs once per block.
      const released = row.capacity - request.used;
      if (row.periodEnd === null && released > 0)
        this.ctx.storage.sql.exec(
          "UPDATE quota_periods SET carried=carried+? WHERE kind='paid' AND start=(SELECT end FROM quota_periods WHERE kind='starter' AND start=? AND end IS NOT NULL)",
          released,
          row.periodStart,
        );
      return this.recordNotices(row.periodStart);
    });
    if (notify) await this.ctx.storage.setAlarm(DateTime.toEpochMillis(DateTime.nowUnsafe()));
    return { ok: true };
  }
  /**
   * Record which usage warnings the current period has crossed: 80% and 100% of its allowance
   * (free messages carried into it included, the courtesy cushion not). Each is recorded once per
   * period; a jump straight past 100% records 80% as already handled, so one email goes out. Late
   * reports for an older period warn nobody. Returns whether anything new needs sending.
   */
  private recordNotices(periodStart: M.Timestamp) {
    if (!EmailModel.isEnabled(this.env)) return false;
    const period = this.current();
    if (period === null || period.start !== periodStart) return false;
    const allowance = period.allowance + period.carried + period.bonus;
    if (allowance <= 0) return false;
    let added = false;
    for (const threshold of [100, 80]) {
      if (period.used * 100 < threshold * allowance) continue;
      const exists = this.ctx.storage.sql
        .exec(
          "SELECT 1 FROM quota_email_notices WHERE period_start=? AND threshold=?",
          period.start,
          threshold,
        )
        .toArray()[0];
      if (exists !== undefined) continue;
      // 80% after 100% in the same report has nothing left to say.
      const skip =
        threshold === 80 &&
        this.ctx.storage.sql
          .exec(
            "SELECT 1 FROM quota_email_notices WHERE period_start=? AND threshold=100",
            period.start,
          )
          .toArray()[0] !== undefined;
      this.ctx.storage.sql.exec(
        "INSERT INTO quota_email_notices(period_start,threshold,account_id,period_end,kind,used,allowance,queued) VALUES(?,?,?,?,?,?,?,?)",
        period.start,
        threshold,
        period.accountId,
        period.end,
        period.kind ?? "paid",
        period.used,
        allowance,
        skip ? 1 : 0,
      );
      if (!skip) added = true;
    }
    return added;
  }
  /**
   * Hand recorded usage warnings to the D1 outbox. A failure throws, so Cloudflare retries the
   * alarm; the outbox key makes a repeated hand-off one email.
   */
  override async alarm() {
    // Budget counts first: they are only in memory until saved, and saving needs no network. While
    // leases keep coming the alarm only moves on; it saves once they stop or a minute has passed.
    this.budgets.alarm();
    await this.scheduleBudgetSave();
    // Ask servers holding blocks to close them (`recall`), and set the alarm for the next retry.
    await this.runRecalls();
    await this.armRecalls();
    const Notice = Schema.Struct({
      periodStart: M.Timestamp,
      threshold: Schema.Literals([80, 100]),
      accountId: P.AccountId,
      periodEnd: Schema.NullOr(M.Timestamp),
      kind: Model.PeriodKind,
      used: M.Count,
      allowance: M.Count,
    });
    const notices = Schema.decodeUnknownSync(Schema.Array(Notice))(
      this.ctx.storage.sql
        .exec(
          "SELECT period_start AS periodStart,threshold,account_id AS accountId,period_end AS periodEnd,kind,used,allowance FROM quota_email_notices WHERE queued=0",
        )
        .toArray(),
    );
    for (const notice of notices) {
      await run(
        EmailHttp.queueAllowance(this.env, {
          accountId: notice.accountId,
          periodStart: notice.periodStart,
          periodEnd: notice.periodEnd,
          threshold: notice.threshold,
          used: notice.used,
          allowance: notice.allowance,
          funding: notice.kind,
        }),
      );
      this.ctx.storage.sql.exec(
        "UPDATE quota_email_notices SET queued=1 WHERE period_start=? AND threshold=?",
        notice.periodStart,
        notice.threshold,
      );
    }
  }
  /** The organization's free-start period, current or retired, with its own counters. */
  async starter(): Promise<Model.StarterPeriod | null> {
    await this.settled();
    const row = this.ctx.storage.sql
      .exec(`SELECT ${periods} FROM quota_periods WHERE kind='starter' LIMIT 1`)
      .toArray()[0];
    if (row === undefined) return null;
    const period = decodePeriod(row);
    return {
      start: period.start,
      end: period.end,
      allowance: period.allowance,
      bonus: period.bonus,
      used: period.used,
      reserved: period.reserved,
    };
  }
  /**
   * The organization's latest Free plan month with its own counters, or null if it never joined
   * Free. `retired` is true once a paid period replaced it.
   */
  async free(): Promise<Model.FreePeriod | null> {
    await this.settled();
    const row = this.ctx.storage.sql
      .exec(
        `SELECT ${periods} FROM quota_periods WHERE kind='free' AND end>start ORDER BY start DESC LIMIT 1`,
      )
      .toArray()[0];
    if (row === undefined) return null;
    const period = decodePeriod(row);
    if (period.end === null) return null;
    return {
      start: period.start,
      end: period.end,
      allowance: period.allowance,
      bonus: period.bonus,
      used: period.used,
      reserved: period.reserved,
      retired: this.current(false)?.start !== period.start,
    };
  }
  /** Capacity outstanding is a conservative usage upper bound, never presented as a measured count. */
  async read(): Promise<U.Usage> {
    await this.settled();
    const period = this.current();
    const asOf = this.meteringTime();
    if (period === null)
      return {
        status: "payment_required",
        periodStart: null,
        periodEnd: null,
        allowance: 0,
        overdraft: 0,
        used: 0,
        outstanding: 0,
        usageUpperBound: 0,
        available: 0,
        asOf,
        lastReportedAt: null,
      };
    const allowance = period.allowance + period.carried + period.bonus;
    const available = fundable(period) - period.reserved;
    const ended = period.end !== null && asOf >= period.end;
    const usage: U.Usage = {
      status:
        asOf < period.start || ended
          ? "payment_required"
          : period.used >= fundable(period)
            ? "exhausted"
            : available === 0
              ? "confirming"
              : period.used >= allowance
                ? "overdraft"
                : "ready",
      periodStart: period.start,
      periodEnd: period.end,
      allowance,
      overdraft: period.overdraft,
      used: period.used,
      outstanding: period.reserved - period.used,
      usageUpperBound: period.reserved,
      available: ended ? 0 : available,
      asOf,
      lastReportedAt: period.lastReportedAt,
      kind: period.kind ?? "paid",
      carriedOver: period.carried,
    };
    if (period.bonus === 0) return usage;
    return { ...usage, bonus: period.bonus };
  }
  /**
   * `read`, with the blocks servers hold open in the current period, which make up `outstanding`.
   * Uses the partial index of open blocks (`quota_open_period`); none are read when nothing is
   * outstanding. Never closes or recalls a block.
   */
  async readHeld(): Promise<Model.HeldUsage> {
    const usage = await this.read();
    if (usage.outstanding === 0 || usage.periodStart === null) return { usage, blocks: [] };
    const blocks = Schema.decodeUnknownSync(Schema.Array(openBlockRow))(
      this.ctx.storage.sql
        .exec(
          "SELECT id,server_id AS serverId,capacity FROM quota_allocations WHERE closed=0 AND period_start=?",
          usage.periodStart,
        )
        .toArray(),
    );
    return { usage, blocks };
  }
  /**
   * Add one share-link bonus to the organization's free allowance (docs/share-links-spec.md): the
   * free start (it still has no end) or the current Free plan month. Any other standing (a paid
   * period, a trial, a retired free start) records the bonus as not added. The outcome is recorded
   * with the bonus ID, so a retry returns it and never adds twice. An organization that never held
   * a period records nothing (`no_period`), so the bonus is asked again once it has one.
   */
  async addBonus(input: {
    readonly accountId: P.AccountId;
    readonly id: string;
    readonly messages: number;
  }): Promise<Model.BonusAnswer> {
    const value = Schema.decodeUnknownSync(BonusRequest)(input);
    const answer = this.ctx.storage.transactionSync((): Model.BonusAnswer => {
      this.settle();
      const prior = this.ctx.storage.sql
        .exec("SELECT outcome FROM quota_bonuses WHERE id=?", value.id)
        .toArray()[0];
      if (prior !== undefined) return Schema.decodeUnknownSync(PriorBonus)(prior);
      const latest = this.current(false);
      if (latest === null) return { outcome: "no_period" };
      if (latest.accountId !== value.accountId) throw new Error("Quota workspace cannot change");
      const now = this.meteringTime();
      const open =
        (latest.kind === "starter" && latest.end === null) ||
        (latest.kind === "free" && latest.end !== null && latest.start <= now && now < latest.end);
      const outcome = open ? "added" : "not_added";
      this.ctx.storage.sql.exec(
        "INSERT INTO quota_bonuses(id,period_start,messages,outcome,at) VALUES(?,?,?,?,?)",
        value.id,
        latest.start,
        value.messages,
        outcome,
        now,
      );
      if (open)
        this.ctx.storage.sql.exec(
          "UPDATE quota_periods SET bonus=bonus+? WHERE start=?",
          value.messages,
          latest.start,
        );
      return { outcome };
    });
    await this.scheduleRecalls();
    return answer;
  }
}
