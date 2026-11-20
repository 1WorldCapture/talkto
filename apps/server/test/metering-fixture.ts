import { Schema } from "effect";
import * as M from "@talkto/api/models";
import * as BudgetModel from "../src/budgets/model.js";
import * as Metering from "../src/metering/model.js";
import { WorkspaceQuota } from "../src/metering/coordinator.js";
import type * as Pool from "../src/files/pool.js";

/** Rows this quota object's own statements wrote, read once each statement has run. */
const written = new WeakMap<DurableObjectStorage, Array<() => number>>();
/** Allocation and close calls this quota object answered, per incarnation. */
const answered = new WeakMap<DurableObjectStorage, { allocates: number; closes: number }>();

/** Faults and time controls exist only in the test bundle. */
export class TestQuota extends WorkspaceQuota {
  constructor(ctx: DurableObjectState, env: Env) {
    // Count what Cloudflare bills (`rowsWritten`), leaving out the fixture's own test tables.
    const sql = ctx.storage.sql;
    const exec = sql.exec.bind(sql);
    const cursors: Array<() => number> = [];
    written.set(ctx.storage, cursors);
    answered.set(ctx.storage, { allocates: 0, closes: 0 });
    sql.exec = <T extends Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: unknown[]
    ) => {
      const cursor = exec<T>(query, ...bindings);
      if (!query.includes("test_")) cursors.push(() => cursor.rowsWritten);
      return cursor;
    };
    super(ctx, env);
  }
  /**
   * Rows written by this object's statements, and the allocations and closes it answered, since
   * the last call (this incarnation only).
   */
  async takeCost() {
    const cursors = written.get(this.ctx.storage) ?? [];
    const rows = cursors.reduce((total, rowsWritten) => total + rowsWritten(), 0);
    cursors.length = 0;
    const calls = answered.get(this.ctx.storage) ?? { allocates: 0, closes: 0 };
    answered.set(this.ctx.storage, { allocates: 0, closes: 0 });
    return { rows, ...calls };
  }
  private answer(call: "allocates" | "closes") {
    const calls = answered.get(this.ctx.storage);
    if (calls !== undefined) calls[call]++;
  }
  async configure(input: {
    at?: M.Timestamp;
    down?: boolean;
    loseAllocate?: boolean;
    loseClose?: boolean;
    losePublish?: boolean;
    legacyHold?: boolean;
    free?: boolean;
    budgets?: BudgetModel.Overrides | null;
    historyCapBytes?: number | null;
  }) {
    const value = Schema.decodeUnknownSync(
      Schema.Struct({
        at: Schema.optionalKey(M.Timestamp),
        down: Schema.optionalKey(Schema.Boolean),
        loseAllocate: Schema.optionalKey(Schema.Boolean),
        loseClose: Schema.optionalKey(Schema.Boolean),
        losePublish: Schema.optionalKey(Schema.Boolean),
        legacyHold: Schema.optionalKey(Schema.Boolean),
        free: Schema.optionalKey(Schema.Boolean),
        budgets: Schema.optionalKey(Schema.NullOr(BudgetModel.Overrides)),
        historyCapBytes: Schema.optionalKey(Schema.NullOr(M.Count)),
      }),
    )(input);
    if (value.historyCapBytes !== undefined) {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS test_history_cap(bytes INTEGER NOT NULL)",
      );
      this.ctx.storage.sql.exec("DELETE FROM test_history_cap");
      if (value.historyCapBytes !== null)
        this.ctx.storage.sql.exec("INSERT INTO test_history_cap VALUES(?)", value.historyCapBytes);
    }
    // Replace the plan's budget numbers for this organization only.
    if (value.budgets !== undefined) {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_budgets(overrides TEXT NOT NULL)");
      this.ctx.storage.sql.exec("DELETE FROM test_budgets");
      if (value.budgets !== null)
        this.ctx.storage.sql.exec(
          "INSERT INTO test_budgets VALUES(?)",
          JSON.stringify(value.budgets),
        );
    }
    // Turning the Free plan switch on or off as a redeploy would, for this object only.
    if (value.free !== undefined) {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS test_free_switch(free INTEGER NOT NULL)",
      );
      this.ctx.storage.sql.exec("DELETE FROM test_free_switch");
      this.ctx.storage.sql.exec("INSERT INTO test_free_switch VALUES(?)", value.free ? 1 : 0);
    }
    await this.ctx.storage.put("test-control", value);
    if (value.at !== undefined) {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_clock(at TEXT NOT NULL)");
      this.ctx.storage.sql.exec("DELETE FROM test_clock");
      this.ctx.storage.sql.exec("INSERT INTO test_clock VALUES(?)", value.at);
    }
  }
  protected override meteringTime() {
    const exists = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name='test_clock'")
      .toArray()[0];
    return exists === undefined
      ? super.meteringTime()
      : Schema.decodeUnknownSync(Schema.Struct({ at: M.Timestamp }))(
          this.ctx.storage.sql.exec("SELECT at FROM test_clock").one(),
        ).at;
  }
  protected override historyCapOverride() {
    const exists = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name='test_history_cap'")
      .toArray()[0];
    if (exists === undefined) return null;
    const row = this.ctx.storage.sql.exec("SELECT bytes FROM test_history_cap").toArray()[0];
    return row === undefined ? null : Schema.decodeUnknownSync(M.Count)(row["bytes"]);
  }
  protected override budgetOverrides() {
    const exists = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name='test_budgets'")
      .toArray()[0];
    if (exists === undefined) return null;
    const row = this.ctx.storage.sql.exec("SELECT overrides FROM test_budgets").toArray()[0];
    return row === undefined
      ? null
      : Schema.decodeUnknownSync(Schema.fromJsonString(BudgetModel.Overrides))(row["overrides"]);
  }
  /** Lease calls this object answered, so tests can see that reads are batched. */
  override async budget(input: BudgetModel.Request) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS test_budget_calls(lane TEXT NOT NULL, want INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec("INSERT INTO test_budget_calls VALUES(?,?)", input.lane, input.want);
    await this.fault("down", false);
    return super.budget(input);
  }
  /** The budget counts as saved in storage, which may trail the counts in memory. */
  async budgetRows() {
    return this.ctx.storage.sql
      .exec("SELECT lane, used, beyond FROM budget_months ORDER BY lane")
      .toArray();
  }
  /** When the budget alarm is due on this object's clock (epoch milliseconds), or null. */
  async budgetDue() {
    return { due: this.budgets.due() };
  }
  /** Run the alarm now, as Cloudflare would when it is due. */
  async runAlarm() {
    const scheduled = await this.ctx.storage.getAlarm();
    await this.alarm();
    return { scheduled, now: Date.now() };
  }
  async budgetCalls() {
    const exists = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name='test_budget_calls'")
      .toArray()[0];
    if (exists === undefined) return [];
    return this.ctx.storage.sql.exec("SELECT lane, want FROM test_budget_calls").toArray();
  }
  protected override freePlanEnabled() {
    const exists = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name='test_free_switch'")
      .toArray()[0];
    if (exists === undefined) return super.freePlanEnabled();
    return this.ctx.storage.sql.exec("SELECT free FROM test_free_switch").one()["free"] === 1;
  }
  private async fault(key: string, consume: boolean) {
    const control = await this.ctx.storage.get<Record<string, boolean | string>>("test-control");
    if (control?.[key] !== true) return;
    if (consume) await this.ctx.storage.put("test-control", { ...control, [key]: false });
    throw new Error("Injected quota transport outage");
  }
  override async allocate(input: {
    readonly id: M.RequestKey;
    readonly serverId: M.ServerId;
  }): Promise<Metering.Result> {
    this.answer("allocates");
    await this.fault("down", false);
    const result = await super.allocate(input);
    await this.fault("loseAllocate", true);
    // An authority from before holds answers without a hold.
    const control = await this.ctx.storage.get<Record<string, boolean | string>>("test-control");
    if (control?.["legacyHold"] === true && result.kind === "allocated")
      return { kind: "allocated", allocation: result.allocation };
    return result;
  }
  override async close(input: {
    readonly id: M.RequestKey;
    readonly serverId: M.ServerId;
    readonly used: number;
  }) {
    this.answer("closes");
    await this.fault("down", false);
    const result = await super.close(input);
    await this.fault("loseClose", true);
    return result;
  }
  override async publish(input: Metering.Period) {
    await this.fault("losePublish", true);
    return super.publish(input);
  }
  override async reserveStorage(input: Pool.Request): Promise<Pool.Outcome> {
    await this.fault("down", false);
    return super.reserveStorage(input);
  }
  /** Seed previously committed usage through the real allocation/closure protocol. No production entry point. */
  async consumeHistory(input: { serverId: M.ServerId; count: number }) {
    const { serverId, count } = Schema.decodeUnknownSync(
      Schema.Struct({
        serverId: M.ServerId,
        count: M.Count.check(Schema.isLessThanOrEqualTo(40000)),
      }),
    )(input);
    let remaining = count;
    while (remaining > 0) {
      const id = M.RequestKey.make(crypto.randomUUID());
      const result = await super.allocate({ id, serverId });
      if (result.kind !== "allocated") throw new Error("Historical allowance unavailable");
      const allocation = result.allocation;
      const used = Math.min(remaining, allocation.capacity);
      await super.close({ id, serverId, used });
      remaining -= used;
    }
    return this.read();
  }
  async restart() {
    this.ctx.abort("Test eviction");
  }
  /** The held blocks this object is asking servers to close. */
  async recallQueue() {
    return this.ctx.storage.sql
      .exec("SELECT id,server_id AS serverId,due,attempts FROM quota_recalls ORDER BY id")
      .toArray();
  }
  /** Replace the tables with the pre-free-start shape (required ends) holding one paid period. */
  async legacySchema(input: { accountId: string; start: string; end: string }) {
    this.ctx.storage.sql.exec(`
      DROP TABLE quota_periods; DROP TABLE quota_allocations;
      CREATE TABLE quota_periods(account_id TEXT NOT NULL,start TEXT PRIMARY KEY,end TEXT NOT NULL,allowance INTEGER NOT NULL,overdraft INTEGER NOT NULL,reserved INTEGER NOT NULL DEFAULT 0,used INTEGER NOT NULL DEFAULT 0,last_reported_at TEXT) STRICT;
      CREATE TABLE quota_allocations(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,period_start TEXT NOT NULL,period_end TEXT NOT NULL,capacity INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE INDEX quota_active_server ON quota_allocations(server_id,closed);
    `);
    this.ctx.storage.sql.exec(
      "INSERT INTO quota_periods(account_id,start,end,allowance,overdraft,reserved,used) VALUES(?,?,?,40000,500,7,7)",
      input.accountId,
      input.start,
      input.end,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO quota_allocations(id,server_id,period_start,period_end,capacity,used,closed) VALUES('legacy','legacy-server',?,?,7,7,1)",
      input.start,
      input.end,
    );
    return { ok: true };
  }
  /** Whether each table still requires an end, after construction ran. */
  async endRequired() {
    const required = (table: string, column: string) =>
      this.ctx.storage.sql
        .exec<{ name: string; notnull: number }>(`PRAGMA table_info(${table})`)
        .toArray()
        .some((row) => row.name === column && row.notnull === 1);
    return {
      periods: required("quota_periods", "end"),
      allocations: required("quota_allocations", "period_end"),
      rows: this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM quota_allocations").one().n,
    };
  }
}
