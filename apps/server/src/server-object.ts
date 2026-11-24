import { run } from "@talkto/telemetry/effect";
import { DurableObject } from "cloudflare:workers";
import {
  Clock,
  Context,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Result,
  Schedule,
  Schema,
} from "effect";
import * as A from "@talkto/api/agent";
import * as P from "@talkto/api/platform";
import * as Agent from "./agent.js";
import * as Envelope from "@talkto/api/envelope";
import * as M from "@talkto/api/models";
import * as O from "@talkto/api/onboarding";
import * as Access from "./access.js";
import * as Actors from "./actors.js";
import * as Persons from "./people.js";
import * as Configuration from "./configuration.js";
import * as Http from "./http.js";
import * as Sqlite from "./storage/sqlite.js";
import * as TalkTo from "./talkto.js";
import * as Signal from "./update-signal.js";
import * as Responses from "./responses.js";
import * as Platform from "./platform/model.js";
import * as Projection from "./platform/activity-projection.js";
import * as ActivitySearch from "./platform/activity-search.js";
import * as Persistence from "./persistence.js";
import * as Metering from "./metering/model.js";
import * as MeterConfig from "./metering/configuration.js";
import * as LocalMeter from "./metering/local.js";
import * as Files from "./files/model.js";
import * as FileBindings from "./files/bindings.js";
import * as FileRevocation from "./files/revocation.js";
import * as FileRepository from "./files/repository.js";
import * as Transfers from "./files/transfers.js";
import { capabilities } from "./capabilities.js";
import * as Pool from "./files/pool.js";
import * as Reads from "./reads.js";
import * as BudgetClient from "./budgets/client.js";
import * as Entitlements from "./account-entitlements.js";
import * as Telemetry from "./telemetry.js";
import * as Signals from "./signals.js";
import * as SignalCheck from "./signal-check.js";
import { StuckReaders } from "./stuck-readers.js";
import * as WakeSchedule from "./wakes/schedule.js";
import * as WakeStore from "./wakes/store.js";
import * as WakeCrypto from "./wakes/crypto.js";
import * as WakeTransport from "./wakes/transport.js";
import * as WakeSettings from "./wakes/settings.js";
import * as WakePolicy from "./wakes/policy.js";
import * as Wakes from "./wakes/service.js";
import * as McpEvents from "./wakes/mcp-events.js";
import * as History from "./history/model.js";
import * as Prune from "./history/prune.js";
import * as Archive from "./history/archive.js";

const hourMillis = 3_600_000;
/** One archived message per line, in the shape every message reader returns. */
const encodeArchived = Schema.encodeSync(Schema.fromJsonString(M.Message));

/** What deciding to hold an HTTP page needs from its body. */
const decodeJsonPage = Schema.decodeUnknownOption(Schema.fromJsonString(Signal.Page));

/** The server ID a failed request named, only when it parses as one; logs never carry path text. */
const loggedServerId = (request: Request) =>
  Option.getOrNull(
    Schema.decodeUnknownOption(M.ServerId)(new URL(request.url).pathname.split("/")[3]),
  );

/** One independently authorized TalkTo server and its SQLite database. Only Worker bindings reach this class. */
export class TalkToServer extends DurableObject<Env> {
  private readonly ready;
  private readonly web;
  private readonly application;
  private meter = Metering.unmetered;
  private shareCost = Metering.singleUnit;
  private files = Files.unavailable;
  private transfers = Transfers.unavailable;
  private reads = Reads.unmeasured;
  private owner: Reads.Owner | null = null;
  /** Undefined until decided; null where nothing is budgeted. */
  private budgets: BudgetClient.Client | null | undefined = undefined;
  private closeUsage: (
    force: boolean,
    only?: M.RequestKey,
  ) => Effect.Effect<void, Metering.Failure> = () => Effect.void;
  /** When the message block next needs a pass, on the metering clock; null without a block. */
  private usageDue: () => M.Timestamp | null = () => null;
  private activeWrites = 0;
  private deleting = false;
  /**
   * Whether the server table exists: found at startup, set by provisioning, cleared by erasing.
   * Access checks rely on it instead of scanning the schema table on every request.
   */
  private initialized = false;
  private activeOperations = 0;
  private drained: (() => void) | null = null;
  private erasing: Promise<void> | null = null;
  private projecting: Promise<{ caughtUp: boolean }> | null = null;
  /** The UTC day each storage size threshold was last reported, mirroring durable storage. */
  private readonly storageAlerts = new Map<string, string>();
  /** Readers asking get_updates from one checkpoint while messages wait (stuck-readers.ts). */
  private readonly stuckReaders = new StuckReaders();
  private meteringReady = false;
  /** `TALKTO_AGENT_OWNERSHIP`, settled at startup before any request. */
  private agentOwnership: Actors.OwnershipMode = "enforce";
  private meterInitialization: Promise<void> | null = null;
  /** Waiting get_updates calls' hibernatable watches; sends wake them, erase ends them. */
  protected readonly watches: Signal.Watches;
  private readonly wakeSettings: WakeSettings.Settings;
  private readonly wakeStore: WakeStore.WakeStore["Service"];
  /** Initialize persistent state once, while holding Cloudflare's initialization gate. */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.watches = new Signal.Watches({
      acceptWebSocket: (ws, tags) => ctx.acceptWebSocket(ws, tags),
      getWebSockets: (tag) => ctx.getWebSockets(tag),
    });
    this.wakeSettings = WakeSettings.fromEnv(env);
    this.wakeStore = WakeStore.sqlite(ctx.storage);
    const identifiers = Layer.succeed(
      TalkTo.Identifiers,
      TalkTo.Identifiers.of({ uuid: () => Effect.sync(() => crypto.randomUUID()) }),
    );
    const reads = Layer.succeed(
      Reads.Reads,
      Reads.Reads.of({
        admit: (access, read) => this.reads.admit(access, read),
        admin: (access, call) => this.reads.admin(access, call),
        refused: (access, call) => this.reads.refused(access, call),
      }),
    );
    const ownership = Layer.succeed(
      Actors.AgentOwnership,
      Actors.AgentOwnership.of({ mode: () => this.agentOwnership }),
    );
    const schedule = Layer.succeed(
      WakeSchedule.WakeSchedule,
      WakeSchedule.WakeSchedule.of({
        notify: (arrival) => Effect.promise(() => this.scheduleWake(arrival)),
        arm: (at) => Effect.promise(() => this.armWake(at)),
      }),
    );
    // Wakes keep their own store and ports, so the message path only ever marks a row due.
    const wakes = Wakes.layer.pipe(
      Layer.provide(Sqlite.layer(ctx.storage)),
      Layer.provide(schedule),
      Layer.provide(Layer.succeed(WakeStore.WakeStore, this.wakeStore)),
      Layer.provide(Layer.succeed(WakeCrypto.WakeSealer, WakeCrypto.fromEnv(env))),
      Layer.provide(Layer.succeed(WakeTransport.WakeTransport, this.wakeTransport())),
      Layer.provide(Layer.succeed(WakeSettings.WakeSettings, this.wakeSettings)),
      Layer.provide(reads),
      Layer.provide(identifiers),
      Layer.provide(ownership),
    );
    const application = TalkTo.layer.pipe(
      Layer.provide(Sqlite.layer(ctx.storage)),
      Layer.provide(ownership),
      Layer.provide(
        Layer.succeed(
          Metering.Meter,
          Metering.Meter.of({
            consume: (id, units, kind) => this.meter.consume(id, units, kind),
            refill: (units) =>
              Effect.tryPromise({
                try: () => this.configureMeter(),
                catch: () => Metering.unavailable("ownership"),
              }).pipe(Effect.flatMap(() => this.meter.refill(units))),
          }),
        ),
      ),
      // Initialization reads the environment before any request, so both are settled by first use.
      Layer.provide(
        Layer.succeed(Metering.ShareCost, Metering.ShareCost.of({ units: () => this.shareCost })),
      ),
      Layer.provide(
        Layer.succeed(
          Files.FileStore,
          Files.FileStore.of({
            ensure: (serverId, recorded) => this.files.ensure(serverId, recorded),
            mint: (serverId, scope, ttl) => this.files.mint(serverId, scope, ttl),
            revoke: (serverId, tokenId) => this.files.revoke(serverId, tokenId),
            remove: (serverId) => this.files.remove(serverId),
          }),
        ),
      ),
      Layer.provide(Layer.succeed(Signal.UpdateSignal, Signal.fromWatches(this.watches))),
      Layer.provide(
        Layer.succeed(
          Signals.SignalSecrets,
          Signals.secrets(Signals.signalKey(env.TALKTO_SIGNAL_KEY)),
        ),
      ),
      Layer.provide(schedule),
      Layer.provide(
        Layer.succeed(
          Transfers.TransferStore,
          Transfers.TransferStore.of({
            uploadUrl: (key, bytes) => this.transfers.uploadUrl(key, bytes),
            downloadUrl: (key, options) => this.transfers.downloadUrl(key, options),
            size: (key) => this.transfers.size(key),
            remove: (keys) => this.transfers.remove(keys),
            removePrefix: (prefix) => this.transfers.removePrefix(prefix),
          }),
        ),
      ),
      Layer.provide(
        Layer.succeed(
          Pool.StoragePool,
          "PLATFORM" in env
            ? Pool.StoragePool.of({ reserve: (reservation) => this.reserveStorage(reservation) })
            : Pool.unpooled,
        ),
      ),
      Layer.provide(
        Layer.succeed(
          Archive.ArchiveStore,
          Archive.ArchiveStore.of({
            put: (key, body) => (this.historyArchive() ?? Archive.unavailable).put(key, body),
            list: (prefix, after, limit) =>
              (this.historyArchive() ?? Archive.unavailable).list(prefix, after, limit),
            read: (key) => (this.historyArchive() ?? Archive.unavailable).read(key),
            remove: (keys) => (this.historyArchive() ?? Archive.unavailable).remove(keys),
          }),
        ),
      ),
      // Removing an agent deletes its wakes in the same transaction.
      Layer.provide(Layer.succeed(WakeStore.WakeStore, this.wakeStore)),
      Layer.provide(identifiers),
      Layer.merge(reads),
      Layer.merge(wakes),
    );
    this.application = application;
    this.web = Http.makeHandler(application);
    this.ready = ctx.blockConcurrencyWhile(() =>
      run(
        Effect.gen(
          function* (this: TalkToServer) {
            const settings = yield* MeterConfig.read(env).pipe(
              Effect.mapError(
                () =>
                  new Configuration.ConfigurationUnavailable({
                    message: "Metering configuration is unavailable.",
                  }),
              ),
            );
            if (settings.workspaces === "all" || settings.workspaces.length > 0) {
              this.meter = Metering.Meter.of({
                consume: () => Effect.fail(new Metering.CapacityRequired({})),
                refill: () => Effect.fail(Metering.unavailable("ownership")),
              });
            } else this.meteringReady = true;
            this.shareCost = MeterConfig.shareCost(settings);
            const origin = yield* Configuration.readOrigin(env);
            this.agentOwnership = yield* Configuration.readAgentOwnership(env);
            this.files = yield* this.configureFiles(env);
            this.transfers = FileBindings.configureTransfers(env);
            const readSettings = yield* Reads.read(env).pipe(
              Effect.mapError(
                () =>
                  new Configuration.ConfigurationUnavailable({
                    message: "Read limit configuration is unavailable.",
                  }),
              ),
            );
            this.reads = Reads.make({
              settings: readSettings,
              events: this.readEvents(env),
              organizationLimit: env.ORGANIZATION_READS,
              owner: () => Effect.promise(() => this.knownOwner()),
              budget: () => Effect.promise(() => this.budget()),
              now: Effect.suspend(() => this.limiterTime()),
            });
            // Only the explicit local entry point supplies a bootstrap configuration.
            if ("TALKTO_SERVER_ID" in env) {
              const config = yield* Configuration.read(env);
              yield* Sqlite.initialize(ctx.storage, {
                ...config,
                generalId: M.ConversationId.make(crypto.randomUUID()),
                now: M.Timestamp.make(DateTime.formatIso(DateTime.nowUnsafe())),
              });
            } else
              yield* Sqlite.upgrade(
                ctx.storage,
                M.Timestamp.make(DateTime.formatIso(DateTime.nowUnsafe())),
              );
            this.deleting =
              (yield* Effect.promise(() => ctx.storage.get<boolean>("deleting"))) === true;
            this.initialized =
              ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='server'").toArray()
                .length > 0;
            return origin;
          }.bind(this),
        ).pipe(Effect.result),
      ),
    );
  }
  /** The time read and admin rate limits refill by; verification subclasses may hold it still. */
  protected limiterTime(): Effect.Effect<number> {
    return Clock.currentTimeMillis;
  }
  /** Where read measurements go; verification subclasses substitute a recording dataset. */
  protected readEvents(env: Env): AnalyticsEngineDataset | undefined {
    return env.READ_EVENTS;
  }
  /**
   * The organization this server belongs to, from what provisioning already stored. Reads never
   * query D1 for it; a server that has not learned its owner yet is measured by server ID alone.
   */
  private async knownOwner(): Promise<Reads.Owner> {
    if (this.owner !== null) return this.owner;
    const stored = await this.ctx.storage.get(["metering-owner", "organization-id"]);
    const owner = Schema.decodeUnknownOption(
      Schema.Struct({ accountId: P.AccountId, serverId: M.ServerId }),
    )(stored.get("metering-owner"));
    const organization = Schema.decodeUnknownOption(P.OrganizationId)(
      stored.get("organization-id"),
    );
    const known = {
      accountId: owner._tag === "Some" ? owner.value.accountId : null,
      organizationId: organization._tag === "Some" ? organization.value : null,
    };
    if (known.accountId !== null && known.organizationId !== null) this.owner = known;
    return known;
  }
  /**
   * This server's view of its organization's read and admin budgets (docs/plan-limits.md). Built
   * once the server knows its owner from provisioning; until then, and for standalone servers,
   * owner-pilot and self-hosted organizations, nothing is budgeted. Reads never query D1 for it.
   */
  private async budget(): Promise<BudgetClient.Client | null> {
    if (this.budgets !== undefined) return this.budgets;
    if (!("PLATFORM" in this.env)) return (this.budgets = null);
    const owner = Schema.decodeUnknownOption(
      Schema.Struct({ accountId: P.AccountId, serverId: M.ServerId }),
    )(await this.ctx.storage.get("metering-owner"));
    if (owner._tag === "None") return null;
    const { accountId, serverId } = owner.value;
    if (Entitlements.covers(Pool.limits(this.env).unlimitedAccounts, accountId))
      return (this.budgets = null);
    this.budgets = BudgetClient.make(
      (lane, want, needed) =>
        this.env.QUOTAS.getByName(accountId).budget({ accountId, serverId, lane, want, needed }),
      () => DateTime.toEpochMillis(DateTime.nowUnsafe()),
    );
    return this.budgets;
  }
  /** The owning account, recorded at provisioning; older servers backfill it once from D1. */
  private async meteringOwner() {
    const stored = await this.ctx.storage.get("metering-owner");
    if (stored !== undefined)
      return Schema.decodeUnknownSync(
        Schema.Struct({ accountId: P.AccountId, serverId: M.ServerId }),
      )(stored);
    // Backfill once for existing servers. Normal message operations never query D1.
    const server = Schema.decodeUnknownSync(Schema.Struct({ id: M.ServerId }))(
      this.ctx.storage.sql.exec("SELECT id FROM server WHERE singleton=1").one(),
    );
    const row = await this.env.PLATFORM.prepare(
      "SELECT account_id AS accountId,id AS serverId FROM servers WHERE id=? AND status='ready'",
    )
      .bind(server.id)
      .first();
    const owner = Schema.decodeUnknownSync(
      Schema.Struct({ accountId: P.AccountId, serverId: M.ServerId }),
    )(row);
    await this.bindOwner(owner.accountId, owner.serverId);
    return owner;
  }
  /** Ask the organization's quota object for space; a full pool is a typed answer, not a fault. */
  private reserveStorage(reservation: Pool.Reservation) {
    return Effect.tryPromise({
      try: async () => {
        const owner = await this.meteringOwner();
        return this.env.QUOTAS.getByName(owner.accountId).reserveStorage({
          ...reservation,
          accountId: owner.accountId,
          serverId: owner.serverId,
        });
      },
      catch: Pool.unavailable,
    }).pipe(
      Effect.flatMap((outcome) =>
        outcome.kind === "reserved"
          ? Effect.void
          : Effect.fail(Pool.full(outcome, reservation.bytes)),
      ),
    );
  }
  /** Choose the file store from the environment; verification subclasses substitute a recording fake. */
  protected configureFiles(env: Env) {
    return FileBindings.configure(env);
  }
  /** The caller's current grant on this server; null where it has none or there is no server. */
  private resolveAccess(principal: Access.PrincipalKey) {
    return Sqlite.resolveAccess(this.ctx.storage, principal, this.initialized);
  }
  private async operation<A>(
    work: () => Promise<A>,
    unavailable: () => A,
    allowEmpty = false,
  ): Promise<A> {
    const ready = await this.ready;
    if (this.deleting || (!allowEmpty && !this.initialized && Result.isSuccess(ready)))
      return unavailable();
    this.activeOperations++;
    try {
      return await work();
    } finally {
      this.activeOperations--;
      if (this.activeOperations === 0) this.drained?.();
    }
  }
  /** Fence new requests, finish admitted work, settle quota, then erase storage. Retries share the same intent. */
  async erase(input: Platform.ServerDeletion): Promise<void> {
    if (Result.isFailure(await this.ready))
      throw new Error("Server storage must be readable before deletion");
    const deletion = Schema.decodeUnknownSync(Platform.ServerDeletion)(input);
    const current = await this.env.PLATFORM.withSession("first-primary")
      .prepare(
        "SELECT id FROM servers WHERE id=? AND account_id=? AND deletion_requested_at IS NOT NULL",
      )
      .bind(deletion.serverId, deletion.accountId)
      .first();
    if (current === null) throw new Error("Deletion has not been authorized");
    if (this.erasing !== null) return this.erasing;
    this.deleting = true;
    // End every open wait now: each Worker answers with what it already read.
    this.watches.close();
    this.erasing = this.eraseStorage(deletion);
    try {
      await this.erasing;
    } finally {
      this.erasing = null;
    }
  }
  private async eraseStorage(deletion: Platform.ServerDeletion) {
    const { serverId, accountId } = deletion;
    await this.ctx.storage.put("deleting", true);
    if (this.activeOperations > 0)
      await new Promise<void>((resolve) => {
        this.drained = resolve;
      });
    this.drained = null;
    if (this.initialized) {
      const actual = Schema.decodeUnknownSync(Schema.Struct({ id: M.ServerId }))(
        this.ctx.storage.sql.exec("SELECT id FROM server WHERE singleton=1").one(),
      );
      if (actual.id !== serverId) throw new Error("Deletion server identity mismatch");
      // Settle even if this workspace was made unlimited after acquiring its last allocation.
      await run(
        LocalMeter.make(this.ctx.storage, this.env.QUOTAS, accountId, serverId, () =>
          this.meteringTime(),
        ).settle(true),
      );
      await this.eraseActivity(serverId);
      await this.eraseRepository(serverId);
      await this.eraseTransfers(serverId);
      await this.eraseArchive(serverId);
      // The objects are gone, so the organization pool stops counting this server's transfers.
      await this.env.QUOTAS.getByName(accountId).releaseStorage({ accountId, serverId });
    }
    // deleteAll atomically clears SQLite, KV metadata, and the alarm. No message journal is erased before settlement.
    await this.ctx.storage.deleteAll();
    this.initialized = false;
  }
  /**
   * Remove the server's Git repository when one was ever ensured. A deployment with no Git store
   * at all has nothing it could remove: hosted TalkTo retired Git sharing on 2026-11-16, and the
   * repositories made before then are deleted with their namespace by the owner-run cleanup in
   * docs/production-deployment.md, so the row is erased with the rest of the ledger. A store that
   * is configured but failing still keeps the deletion pending.
   */
  private async eraseRepository(serverId: M.ServerId) {
    const ensured =
      this.ctx.storage.sql.exec("SELECT remote FROM file_repository WHERE singleton=1").toArray()
        .length > 0;
    if (!ensured) return;
    await this.removeFiles(
      serverId,
      "repository",
      this.files.remove(serverId).pipe(
        Effect.catchTag("FileStoreUnavailable", () =>
          Effect.sync(() =>
            console.warn("TalkTo server deletion found no Git store; repository left to cleanup", {
              serverId,
            }),
          ),
        ),
      ),
    );
  }
  /** Remove every object this server stored, when it ever sent a transfer. */
  private async eraseTransfers(serverId: M.ServerId) {
    const sent =
      this.ctx.storage.sql.exec("SELECT 1 FROM file_transfers LIMIT 1").toArray().length > 0;
    if (sent)
      await this.removeFiles(
        serverId,
        "transfers",
        this.transfers.removePrefix(Transfers.serverPrefix(serverId)),
      );
  }
  /**
   * Remove stored files, retrying a store failure briefly. Files this server's ledger records
   * must be removed before the ledger is: if the store fails, or (for transfers) is no longer
   * configured, the deletion stays pending. The platform keeps the deletion intent and retries it on every
   * scheduled run, and this server stays closed to every request until the files are gone.
   */
  private async removeFiles(
    serverId: M.ServerId,
    store: "repository" | "transfers",
    remove: Effect.Effect<void, Files.Failure>,
  ) {
    const removed = await run(
      remove.pipe(
        Effect.retry({
          while: (error) => error._tag === "FileStoreFailure",
          times: 2,
          schedule: Schedule.exponential("250 millis"),
        }),
        Effect.result,
      ),
    );
    if (Result.isSuccess(removed)) return;
    console.error("TalkTo server deletion is waiting for file cleanup", {
      serverId,
      store,
      failure: removed.failure._tag,
    });
    throw new Error("Server files remain; the deletion will be retried");
  }
  /**
   * Remove this server's message references from the shared database: IDs and times, no text.
   * Batches walk the UNIQUE(server_id,sequence) key.
   */
  private async eraseActivity(serverId: M.ServerId) {
    const db = this.env.PLATFORM.withSession("first-primary");
    for (let batch = 0; batch < 20; batch++) {
      const result = await db
        .prepare(
          "DELETE FROM activity_events WHERE id IN (SELECT id FROM activity_events WHERE server_id=? ORDER BY sequence LIMIT 1000)",
        )
        .bind(serverId)
        .run();
      if (result.meta.changes === 0) return;
    }
    const remaining = await db
      .prepare("SELECT id FROM activity_events WHERE server_id=? LIMIT 1")
      .bind(serverId)
      .first();
    if (remaining !== null) throw new Error("Activity deletion will continue on retry");
  }
  /** Private, idempotent provisioning; never exposed as an unauthenticated HTTP route. */
  async provision(input: Platform.ServerReservation) {
    return this.operation(
      () => this.provisionServer(input),
      () => ({ ok: false }),
      true,
    );
  }
  private async provisionServer(input: Platform.ServerReservation) {
    if (Result.isFailure(await this.ready)) return { ok: false };
    return run(
      Effect.gen(
        function* (this: TalkToServer) {
          const server = yield* Schema.decodeUnknownEffect(Platform.ServerReservation)(input);
          const current = yield* Effect.tryPromise({
            try: () =>
              this.env.PLATFORM.withSession("first-primary")
                .prepare(
                  "SELECT id FROM servers WHERE id=? AND account_id=? AND deletion_requested_at IS NULL",
                )
                .bind(server.id, server.accountId)
                .first(),
            catch: () =>
              new Platform.Failure({
                code: "storage_unavailable",
                message: "Server provisioning unavailable.",
              }),
          });
          if (current === null)
            return yield* new Platform.Failure({
              code: "not_found",
              message: "Server unavailable.",
            });
          yield* Sqlite.initialize(this.ctx.storage, {
            serverId: server.id,
            name: server.name,
            generalId: server.generalId,
            grantId: null,
            principalKey: null,
            now: server.createdAt,
          });
          this.initialized = true;
          const existing = yield* Effect.promise(() =>
            this.ctx.storage.get<string>("organization-id"),
          );
          if (existing !== undefined && existing !== server.organizationId)
            return yield* Effect.die("Server organization cannot change");
          yield* Effect.promise(() => this.bindOwner(server.accountId, server.id));
          yield* Effect.promise(() =>
            this.ctx.storage.put("organization-id", server.organizationId),
          );
        }.bind(this),
      ).pipe(Effect.match({ onFailure: () => ({ ok: false }), onSuccess: () => ({ ok: true }) })),
    );
  }
  private async bindOwner(accountId: P.AccountId, serverId: M.ServerId) {
    const previous = await this.ctx.storage.get("metering-owner");
    if (previous !== undefined) {
      const owner = Schema.decodeUnknownSync(
        Schema.Struct({ accountId: P.AccountId, serverId: M.ServerId }),
      )(previous);
      if (owner.accountId !== accountId || owner.serverId !== serverId)
        throw new Error("Server ownership cannot change");
    }
    await this.ctx.storage.put("metering-owner", { accountId, serverId });
  }
  private async configureMeter() {
    if (this.meteringReady) return;
    if (this.meterInitialization === null) {
      this.meterInitialization = this.initializeMeter().catch(() => {
        this.meterInitialization = null;
        throw new Error("Metering initialization unavailable");
      });
    }
    await this.meterInitialization;
  }
  private async initializeMeter() {
    const settings = await run(MeterConfig.read(this.env));
    const owner = await this.meteringOwner();
    if (MeterConfig.enabled(settings, owner.accountId)) {
      const local = LocalMeter.make(
        this.ctx.storage,
        this.env.QUOTAS,
        owner.accountId,
        owner.serverId,
        () => this.meteringTime(),
      );
      this.meter = local.meter;
      this.closeUsage = local.settle;
      this.usageDue = local.due;
    } else this.meter = Metering.unmetered;
    this.meteringReady = true;
  }
  /** Runtime clock; verification subclasses supply controlled time without altering paid records. */
  protected meteringTime() {
    return M.Timestamp.make(DateTime.formatIso(DateTime.nowUnsafe()));
  }
  /**
   * Messages committed against this server's current block that the quota authority has not been
   * told about yet, so an organization's usage count can be exact. Never refills or settles.
   */
  async unreportedUsage() {
    return this.operation(
      async () => LocalMeter.unreported(this.ctx.storage),
      () => null,
    );
  }
  /**
   * Metered messages this server committed in `[from, to)` and the UTC days they fell on, for
   * share-link qualification. Read-only; null while the server is unavailable.
   */
  async meteredActivity(input: {
    readonly from: M.Timestamp;
    readonly to: M.Timestamp;
  }): Promise<LocalMeter.Activity | null> {
    const range = Schema.decodeUnknownSync(Schema.Struct({ from: M.Timestamp, to: M.Timestamp }))(
      input,
    );
    return this.operation(
      async () => LocalMeter.activity(this.ctx.storage, range.from, range.to),
      () => null,
    );
  }
  /**
   * Close locally before releasing unused capacity; independent of the activity projection. Closes
   * a held block too: the quota object recalls one this way (docs/message-metering.md, "Held
   * blocks"), naming it (`id`), so a block that replaced it stays open. Without an ID, closes
   * whatever block the server holds.
   */
  async reportUsage(input?: { readonly id?: M.RequestKey }) {
    const { id } = Schema.decodeUnknownSync(
      Schema.Struct({ id: Schema.optionalKey(M.RequestKey) }),
    )(input ?? {});
    return this.operation(
      () => this.settleUsage(true, id),
      () => undefined,
    );
  }
  /**
   * `force` closes a held block; the alarm pass leaves it open until its hold ends. `only` closes
   * the block only if it is that allocation.
   */
  private async settleUsage(force: boolean, only?: M.RequestKey) {
    await this.ready;
    await this.scheduleWork(60000);
    await this.configureMeter();
    await run(this.closeUsage(force, only));
  }
  /** Persist an ordered access change before acknowledging a management request. */
  async applyAccess(input: Platform.AccessCommand) {
    return this.operation(
      () => this.applyCommand(input),
      () => ({ ok: false }),
    );
  }
  /** Take a new name from the platform directory (Platform.Servers.rename); stale ones are ignored. */
  async renameServer(input: Platform.ServerName) {
    return this.operation(
      async () => {
        if (Result.isFailure(await this.ready)) return { ok: false };
        return run(
          Schema.decodeUnknownEffect(Platform.ServerName)(input).pipe(
            Effect.flatMap((change) => Sqlite.renameServer(this.ctx.storage, change)),
            Effect.match({ onFailure: () => ({ ok: false }), onSuccess: () => ({ ok: true }) }),
          ),
        );
      },
      () => ({ ok: false }),
      true,
    );
  }
  /**
   * After a person deletes their account: rename their person participant here, if any, to a
   * neutral `former-person` name. The command is their revoked access to this server.
   */
  async forgetPerson(input: Platform.AccessCommand) {
    return this.operation(
      async () => {
        if (Result.isFailure(await this.ready)) return { ok: false };
        return run(
          Schema.decodeUnknownEffect(Platform.AccessCommand)(input).pipe(
            Effect.flatMap((command) => Sqlite.forgetPerson(this.ctx.storage, command)),
            Effect.match({ onFailure: () => ({ ok: false }), onSuccess: () => ({ ok: true }) }),
          ),
        );
      },
      () => ({ ok: false }),
    );
  }
  private async applyCommand(input: Platform.AccessCommand) {
    if (Result.isFailure(await this.ready)) return { ok: false };
    return run(
      Schema.decodeUnknownEffect(Platform.AccessCommand)(input).pipe(
        Effect.flatMap((command) => Sqlite.applyAccess(this.ctx.storage, command)),
        // A revoked grant must not keep waiting: every open wait re-reads under current access.
        Effect.tap(() => Effect.sync(() => this.watches.recheckAll())),
        // Tokens follow their grant: any delivery may have revoked one, including an older grant of the same principal.
        Effect.flatMap(() => this.revokeFileTokens()),
        // A token the store could not revoke is retried by the flush pass; keep a wake for it.
        Effect.flatMap((pending) =>
          pending > 0 ? Effect.promise(() => this.scheduleWork(60000)) : Effect.void,
        ),
        Effect.match({ onFailure: () => ({ ok: false }), onSuccess: () => ({ ok: true }) }),
      ),
    );
  }
  /**
   * The repository people are shown, ensured on first sight. Null when the store cannot answer,
   * so a management view never fails on the file store; the platform already knows the capability.
   */
  async fileRepository(): Promise<Files.Repository | null> {
    return this.operation(
      () => this.describeRepository(),
      () => null,
    );
  }
  private async describeRepository(): Promise<Files.Repository | null> {
    if (Result.isFailure(await this.ready)) return null;
    return run(
      Persistence.Persistence.pipe(
        Effect.flatMap((store) =>
          store.transaction("fileRepository.identity", (tx) => tx.serverIdentity()),
        ),
        Effect.flatMap((serverId) => FileRepository.describe(serverId)),
        Effect.provide(Sqlite.layer(this.ctx.storage)),
        Effect.provideService(Files.FileStore, this.files),
        Effect.match({ onFailure: () => null, onSuccess: (repository) => repository }),
      ),
    );
  }
  /** Revoke every token whose grant is gone; resolves to how many the store still holds. */
  private revokeFileTokens() {
    return Persistence.Persistence.pipe(
      Effect.flatMap((store) =>
        store.transaction("fileTokens.identity", (tx) => tx.serverIdentity()),
      ),
      Effect.flatMap((serverId) => FileRevocation.revokeForRevokedGrants(serverId)),
      Effect.provide(Sqlite.layer(this.ctx.storage)),
      Effect.provideService(Files.FileStore, this.files),
    );
  }
  /** Export one immutable-history batch; the enclosing pass owns quota settlement and wakeups. */
  protected async exportActivity() {
    if (Result.isFailure(await this.ready)) throw new Error("Server initialization unavailable");
    return run(
      Effect.gen(
        function* (this: TalkToServer) {
          const store = yield* Persistence.Persistence;
          const serverId = yield* store.transaction("projectionIdentity", (tx) =>
            tx.serverIdentity(),
          );
          const after = yield* Projection.position(this.env.PLATFORM, serverId);
          const batch = yield* store.transaction("projectionBatch", (tx) =>
            Effect.gen(function* () {
              const head = (yield* tx.latestMessage())?.sequence ?? 0;
              const rows = yield* tx.messages({
                conversationId: null,
                senderId: null,
                afterTime: null,
                beforeTime: null,
                boundary: after,
                ceiling: head,
                direction: "newer",
                search: null,
                limit: 51,
              });
              // The shared database receives each message's ID, sequence and time, never its text.
              const items = rows
                .slice(0, 50)
                .map(({ id, sequence, createdAt }) => ({ id, sequence, createdAt }));
              const through = items.at(-1)?.sequence ?? after;
              return Projection.Batch.make({
                serverId,
                items,
                through,
                caughtUp: through >= head,
                asOf: M.Timestamp.make(DateTime.formatIso(DateTime.nowUnsafe())),
              });
            }),
          );
          yield* Projection.publish(this.env.PLATFORM, batch, after);
          return batch;
        }.bind(this),
      ).pipe(Effect.provide(Sqlite.layer(this.ctx.storage))),
    );
  }
  /** Flush both durable obligations; concurrent repairs share one bounded pass. */
  async projectActivity() {
    return this.operation(
      () => this.project(),
      () => ({ caughtUp: true }),
    );
  }
  private async project() {
    if (this.projecting !== null) return this.projecting;
    this.projecting = this.flushWork();
    try {
      return await this.projecting;
    } finally {
      this.projecting = null;
    }
  }
  private async flushWork() {
    await this.ready;
    await this.watchStorage();
    // A remote failure or eviction retains a wake for both journals.
    await this.scheduleWork(60000);
    const [projection, usage, revocations] = await Promise.allSettled([
      this.exportActivity(),
      this.settleUsage(false),
      this.sweepFileTokens(),
    ]);
    if (projection.status === "rejected") throw projection.reason;
    if (usage.status === "rejected") throw usage.reason;
    const pendingRevocations = revocations.status === "fulfilled" ? revocations.value : 0;
    // After projection, so a removed message was already exported. It never fails the pass.
    const pruneBacklog = await this.pruneHistory();
    const nextWake = await this.nextWake();
    // A held block needs one pass, at its hold's end; a close or recovery still owed retries soon.
    const due = this.usageDue();
    const holdLeft = due === null ? null : Date.parse(due) - Date.parse(this.meteringTime());
    const holdEnd =
      holdLeft === null || holdLeft <= 0
        ? null
        : DateTime.toEpochMillis(DateTime.nowUnsafe()) + holdLeft;
    return this.ctx.storage.transaction(async (transaction) => {
      const { head } = Schema.decodeUnknownSync(Schema.Struct({ head: M.Count }))(
        this.ctx.storage.sql.exec("SELECT COALESCE(MAX(seq),0) AS head FROM messages").one(),
      );
      const caughtUp = projection.value.caughtUp && projection.value.through >= head;
      if (!caughtUp || (due !== null && holdEnd === null) || this.activeWrites > 0)
        await transaction.setAlarm(
          Math.min(
            DateTime.toEpochMillis(DateTime.nowUnsafe()) + (caughtUp ? 5000 : 1000),
            nextWake ?? Number.POSITIVE_INFINITY,
          ),
        );
      // Tokens the store could not revoke keep the wake taken above, so the next pass retries them.
      // The one alarm is shared with wakes: a due wake keeps it set.
      else if (pendingRevocations === 0) {
        // A history backlog keeps one pass a minute until it is gone, a held block one at its
        // hold's end, and a caught-up server none.
        const backlogAt = pruneBacklog
          ? DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60_000
          : null;
        const next = [nextWake, backlogAt, holdEnd].reduce<number | null>(
          (soonest, at) => (at === null ? soonest : soonest === null ? at : Math.min(soonest, at)),
          null,
        );
        await (next === null ? transaction.deleteAlarm() : transaction.setAlarm(next));
      }
      return { caughtUp };
    });
  }
  /** The Factory history archive, or null without a bucket; verification subclasses may substitute one. */
  protected historyArchive(): Archive.ArchiveStore["Service"] | null {
    return this.env.TRANSFERS === undefined ? null : Archive.fromBucket(this.env.TRANSFERS);
  }
  /**
   * Apply the organization's history window (docs/production-deployment.md, "History retention"). It runs on the pass
   * this object already makes after sends and on the hourly repair, so an idle server gets no
   * extra wakeup. The window is asked of the organization's quota object at most once an hour; a
   * shorter one applies only after its grace period. Each pass removes at most
   * `batchesPerPass` × `batchSize` of the oldest messages; on Factory each batch is written to the
   * archive first and nothing is removed if that fails. Once nothing is left, passes are spaced an
   * hour apart. Returns whether older messages remain. Never throws: retention is never a reason
   * for projection or quota closure to fail.
   */
  private async pruneHistory(): Promise<boolean> {
    if (!("PLATFORM" in this.env) || !this.initialized) return false;
    try {
      const now = DateTime.toEpochMillis(DateTime.makeUnsafe(this.meteringTime()));
      const stored = Schema.decodeUnknownOption(History.State)(
        await this.ctx.storage.get("history-retention"),
      );
      const remembered = Option.getOrNull(stored);
      // Nothing can be due while every message is younger than the shortest window, so a young
      // server never asks: one indexed row, and no call to the quota object.
      const oldest = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ at: M.Count })))(
        this.ctx.storage.sql
          .exec("SELECT created_at AS at FROM messages ORDER BY created_at LIMIT 1")
          .toArray(),
      )[0];
      // The storage caps apply to young servers too, once they hold more than a small floor.
      const caps = History.capsEnabled(this.env);
      const bytes = Prune.size(this.ctx.storage);
      if (
        (oldest === undefined || now - oldest.at < History.shortestWindow) &&
        remembered?.archiveUsed !== true &&
        (!caps || bytes < History.capFloorBytes)
      )
        return false;
      const stale = remembered === null || now - remembered.checkedAt >= hourMillis;
      if (remembered !== null && !stale && now < remembered.nextPruneAt) return false;
      let state = remembered;
      if (state === null || stale) {
        const owner = await this.meteringOwner();
        const quota = this.env.QUOTAS.getByName(owner.accountId);
        const fetched = Schema.decodeUnknownSync(History.Policy)(
          await quota.historyPolicy({ accountId: owner.accountId }),
        );
        const capBytes = caps
          ? Schema.decodeUnknownSync(Schema.Struct({ targetBytes: Schema.NullOr(Schema.Number) }))(
              await quota.historyCap({
                accountId: owner.accountId,
                serverId: owner.serverId,
                bytes,
              }),
            ).targetBytes
          : null;
        state = { ...History.advance(state, fetched, now), capBytes };
      }
      const outcome = await this.removeHistory(state, now);
      await this.ctx.storage.put("history-retention", {
        ...state,
        archiveUsed: outcome.archiveUsed,
        nextPruneAt: outcome.backlog ? 0 : now + hourMillis,
      });
      return outcome.backlog;
    } catch (cause) {
      console.warn("TalkTo history retention pass did not complete", {
        cause: cause instanceof Error ? cause.message : "unknown",
      });
      return false;
    }
  }
  private async removeHistory(state: History.State, now: number) {
    const { applied } = state;
    const idle = { backlog: false, archiveUsed: state.archiveUsed };
    if (applied.plan === null || applied.days === null) return idle;
    const serverId = Schema.decodeUnknownSync(Schema.Struct({ id: M.ServerId }))(
      this.ctx.storage.sql.exec("SELECT id FROM server WHERE singleton=1").one(),
    ).id;
    const archive = this.historyArchive();
    // Leaving Factory: after the grace period the archive goes too, a page at a time.
    if (!applied.archive && state.archiveUsed) {
      if (archive === null) return idle;
      const keys = await run(archive.list(Archive.serverPrefix(serverId), null, 1000));
      await run(archive.remove(keys));
      if (keys.length === 1000) return { backlog: true, archiveUsed: true };
      idle.archiveUsed = false;
    }
    // Factory never deletes what it could not archive first.
    if (applied.archive && archive === null) return idle;
    const cutoff = now - applied.days * History.day;
    let archiveUsed = idle.archiveUsed;
    // Past the storage cap, the oldest messages go before their window is up, down to a little
    // under the cap, in the same bounded batches (docs/plan-limits.md, "History storage").
    const cap = state.capBytes ?? null;
    const shedding = cap !== null && Prune.size(this.ctx.storage) > cap;
    const over = () => shedding && Prune.size(this.ctx.storage) > cap * History.capHeadroom;
    for (let pass = 0; pass < Prune.batchesPerPass; pass++) {
      let batch = Prune.select(this.ctx.storage, cutoff, now, Prune.batchSize);
      let capped = false;
      if (batch === null && over()) {
        batch = Prune.select(this.ctx.storage, now, now, Prune.batchSize);
        capped = true;
      }
      if (batch === null) return { backlog: false, archiveUsed };
      if (applied.archive && archive !== null) {
        const messages = await run(
          Persistence.Persistence.pipe(
            Effect.flatMap((store) =>
              store.transaction("historyArchive", (tx) => tx.messagesByIds(batch.ids)),
            ),
            Effect.provide(Sqlite.layer(this.ctx.storage)),
          ),
        );
        const lines = messages.map((message) => encodeArchived(message)).join("\n");
        const from = Math.min(...batch.sequences);
        await run(
          archive.put(Archive.chunkKey(serverId, from, batch.throughSequence), `${lines}\n`),
        );
        archiveUsed = true;
      }
      Prune.remove(this.ctx.storage, batch, applied, capped);
      if (batch.sequences.length < Prune.batchSize && !over())
        return { backlog: false, archiveUsed };
    }
    return { backlog: true, archiveUsed };
  }
  /** Remove this server's archived history, when it ever archived any. */
  private async eraseArchive(serverId: M.ServerId) {
    const archive = this.historyArchive();
    if (archive === null) return;
    for (;;) {
      const keys = await run(archive.list(Archive.serverPrefix(serverId), null, 1000));
      if (keys.length === 0) return;
      await run(archive.remove(keys));
    }
  }
  /** Retry revocations a delivery could not complete. Quiet: an unexpected failure waits for the next pass. */
  private async sweepFileTokens() {
    const swept = await run(this.revokeFileTokens().pipe(Effect.exit));
    return Exit.isSuccess(swept) ? swept.value : 0;
  }
  /** This server's SQLite database size in bytes; verification subclasses may substitute one. */
  protected databaseSize() {
    return this.ctx.storage.sql.databaseSize;
  }
  /**
   * Report a database past a size threshold, at most once per threshold per UTC day. It runs on
   * the projection pass this object already makes after sends (a database grows only through
   * them) and on the weekly repair sweep, so an idle server gets no extra wakeup. Below every
   * threshold it reads only the size. It never fails the pass.
   */
  private async watchStorage() {
    try {
      const bytes = this.databaseSize();
      const threshold = Telemetry.storageThreshold(bytes);
      if (threshold === null) return;
      const day = DateTime.formatIso(DateTime.nowUnsafe()).slice(0, 10);
      const key = `storage-alert:${threshold.label}`;
      if (this.storageAlerts.get(key) === day) return;
      const reported = await this.ctx.storage.get<string>(key);
      this.storageAlerts.set(key, day);
      if (reported === day) return;
      await this.ctx.storage.put(key, day);
      Telemetry.storageSize(threshold, bytes);
      const serverId = await run(
        Persistence.Persistence.pipe(
          Effect.flatMap((store) =>
            store.transaction("storageIdentity", (tx) => tx.serverIdentity()),
          ),
          Effect.provide(Sqlite.layer(this.ctx.storage)),
          Effect.match({ onFailure: () => null, onSuccess: (id) => id }),
        ),
      );
      console.warn("TalkTo server database is nearing its size limit", {
        serverId,
        bytes,
        threshold: threshold.label,
      });
    } catch {
      // Size reporting is advisory; projection and quota closure must still run.
    }
  }
  /** Alarm retries preserve quota closure independently of projection success. */
  override async alarm() {
    await this.deliverWakes();
    if ("PLATFORM" in this.env) await this.projectActivity();
  }
  /** Outbound wake requests; verification subclasses may substitute their own. */
  protected wakeTransport() {
    return WakeTransport.fromFetch((input, init) => fetch(input, init));
  }
  /** After a send commits: mark matching wake targets due and make sure the alarm will fire. */
  private async scheduleWake(arrival: WakeStore.Arrival) {
    if (!this.wakeSettings.events) return;
    const due = await run(
      this.wakeStore
        .markDue(arrival, DateTime.toEpochMillis(DateTime.nowUnsafe()), WakePolicy.debounceMs)
        // The send has already committed; a wake problem must never fail it.
        .pipe(
          Effect.orElseSucceed(() => null),
          Effect.catchDefect(() => Effect.succeed(null)),
        ),
    );
    if (due !== null) await this.armWake(due);
  }
  private async armWake(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
  /** When the next wake is due. A wake problem must never stop projection or quota closure. */
  private nextWake() {
    return run(
      this.wakeStore.nextDue().pipe(
        Effect.orElseSucceed(() => null),
        Effect.catchDefect(() => Effect.succeed(null)),
      ),
    );
  }
  /** Deliver due wakes, then keep the alarm set for the next one. Never throws. */
  protected async deliverWakes() {
    if (!this.wakeSettings.events) return;
    await this.operation(
      async () => {
        const next = await run(
          Wakes.Wakes.pipe(
            Effect.flatMap((wakes) => wakes.deliver()),
            Effect.provide(this.application),
            Effect.orElseSucceed(() => DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60_000),
          ),
        );
        if (next !== null) await this.armWake(next);
      },
      () => undefined,
    );
  }
  private async scheduleWork(delay: number) {
    if (!("PLATFORM" in this.env)) return;
    const at = DateTime.toEpochMillis(DateTime.nowUnsafe()) + delay;
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.getAlarm();
      if (current === null || current > at) await transaction.setAlarm(at);
    });
  }
  private async withMessageWork<A>(work: () => Promise<A>) {
    // Increment before waiting for the durable alarm. A concurrent flush cannot
    // clear it while a message is waiting on an ambiguous allocation response.
    this.activeWrites++;
    try {
      await this.scheduleWork(5000);
      return await work();
    } finally {
      this.activeWrites--;
    }
  }
  /** Hydrate a bounded aggregate page under the current server grant. */
  async readActivity(principal: Access.PrincipalKey, ids: ReadonlyArray<M.MessageId>) {
    return this.operation(
      () => this.hydrateActivity(principal, ids),
      () => null,
    );
  }
  private async hydrateActivity(principal: Access.PrincipalKey, ids: ReadonlyArray<M.MessageId>) {
    await this.ready;
    const parsed = Schema.decodeUnknownSync(
      Schema.Array(M.MessageId).check(Schema.isMaxLength(50)),
    )(ids);
    const access = await run(this.resolveAccess(principal));
    if (access === null) return null;
    return run(
      TalkTo.Service.pipe(
        Effect.flatMap((service) =>
          Reads.Reads.pipe(
            Effect.flatMap((reads) =>
              reads.admit(access, {
                operation: "dashboard.activity",
                transport: "dashboard",
                participantId: null,
              }),
            ),
            Effect.andThen(service.hydrateMessages(access, parsed)),
          ),
        ),
        Effect.catchTag("RateLimited", () => Effect.succeed(null)),
        Effect.catchTag("ServerAccessDenied", () => Effect.succeed(null)),
        Effect.provide(this.application),
      ),
    );
  }
  /** Search this server's own messages for an account search, under the current server grant. */
  async searchActivity(
    principal: Access.PrincipalKey,
    request: ActivitySearch.Request,
  ): Promise<ActivitySearch.Answer> {
    return this.operation(
      () => this.search(principal, request),
      (): ActivitySearch.Answer => ({ kind: "denied" }),
    );
  }
  private async search(
    principal: Access.PrincipalKey,
    input: ActivitySearch.Request,
  ): Promise<ActivitySearch.Answer> {
    if (Result.isFailure(await this.ready)) return { kind: "unavailable" };
    const request = Schema.decodeUnknownOption(ActivitySearch.Request)(input);
    if (request._tag === "None") return { kind: "unavailable" };
    const access = await run(this.resolveAccess(principal).pipe(Effect.result));
    if (Result.isFailure(access)) return { kind: "unavailable" };
    if (access.success === null) return { kind: "denied" };
    const resolved = access.success;
    return run(
      TalkTo.Service.pipe(
        Effect.flatMap((service) =>
          Reads.Reads.pipe(
            Effect.flatMap((reads) =>
              reads.admit(resolved, {
                operation: "dashboard.search",
                transport: "dashboard",
                participantId: null,
              }),
            ),
            Effect.andThen(service.searchActivity(resolved, request.value)),
          ),
        ),
        Effect.map(({ data, included }): ActivitySearch.Answer => ({
          kind: "results",
          ...data,
          included,
        })),
        Effect.catchTag("ServerAccessDenied", () =>
          Effect.succeed<ActivitySearch.Answer>({ kind: "denied" }),
        ),
        // A limited, unreadable or invalid search is reported as this server not answering.
        Effect.catch(() => Effect.succeed<ActivitySearch.Answer>({ kind: "unavailable" })),
        Effect.provide(this.application),
      ),
    );
  }
  /** Read one card only after resolving the current local server grant. */
  async readSummary(principal: Access.PrincipalKey) {
    return this.operation(
      () => this.summary(principal),
      () => null,
    );
  }
  private async summary(principal: Access.PrincipalKey) {
    await this.ready;
    const access = await run(this.resolveAccess(principal));
    if (access === null) return null;
    return run(
      TalkTo.Service.pipe(
        Effect.flatMap((service) =>
          Reads.Reads.pipe(
            Effect.flatMap((reads) =>
              reads.admit(access, {
                operation: "dashboard.summary",
                transport: "dashboard",
                participantId: null,
              }),
            ),
            Effect.andThen(service.serverSummary(access)),
          ),
        ),
        Effect.catchTag("RateLimited", () => Effect.succeed(null)),
        Effect.catchTag("ServerAccessDenied", () => Effect.succeed(null)),
        Effect.provide(this.application),
      ),
    );
  }
  /** Observe two participants through the current server grant; saved onboarding is not authority. */
  async readOnboarding(
    principal: Access.PrincipalKey,
    names: readonly [M.Name, M.Name],
    agents?: O.AgentLookups,
    more?: O.MoreLookups,
    since?: M.Timestamp,
  ) {
    return this.operation(
      () => this.onboarding(principal, names, agents, more, since),
      () => null,
    );
  }
  private async onboarding(
    principal: Access.PrincipalKey,
    names: readonly [M.Name, M.Name],
    agents?: O.AgentLookups,
    more?: O.MoreLookups,
    since?: M.Timestamp,
  ) {
    await this.ready;
    const parsedNames = Schema.decodeUnknownSync(Schema.Tuple([M.Name, M.Name]))(names);
    const parsedAgents = Schema.decodeUnknownSync(Schema.UndefinedOr(O.AgentLookups))(agents);
    const parsedMore = Schema.decodeUnknownSync(Schema.UndefinedOr(O.MoreLookups))(more);
    const parsedSince = Schema.decodeUnknownSync(Schema.UndefinedOr(M.Timestamp))(since);
    const access = await run(this.resolveAccess(principal));
    if (access === null) return null;
    return run(
      TalkTo.Service.pipe(
        Effect.flatMap((service) =>
          Reads.Reads.pipe(
            Effect.flatMap((reads) =>
              reads.admit(access, {
                operation: "onboarding.progress",
                transport: "dashboard",
                participantId: null,
              }),
            ),
            Effect.andThen(
              service.onboarding(access, parsedNames, parsedAgents, parsedMore, parsedSince),
            ),
          ),
        ),
        Effect.catchTag("RateLimited", () => Effect.succeed(null)),
        Effect.catchTag("ServerAccessDenied", () => Effect.succeed(null)),
        Effect.provide(this.application),
      ),
    );
  }
  /**
   * Answer a hook's signal link check. The Worker routes these without a credential; the link's
   * secret is checked here, against its stored hash, and its grant is re-checked on every read.
   */
  async checkSignal(request: Signals.Request): Promise<Signals.Answer> {
    return this.operation(
      () => this.signal(request),
      (): Signals.Answer => ({ kind: "unavailable" }),
    );
  }
  private async signal(input: Signals.Request): Promise<Signals.Answer> {
    if (Result.isFailure(await this.ready)) return { kind: "storage_unavailable" };
    const request = Schema.decodeUnknownOption(Signals.RequestSchema)(input);
    if (request._tag === "None") return { kind: "unavailable" };
    return run(
      Signals.answer(SignalCheck.check(request.value).pipe(Effect.provide(this.application))),
    );
  }
  /**
   * Resolve the caller's current local grant. The same check guards tools and MCP events. Current
   * Workers pass no organization: server access is the boundary. One that does, from an older
   * Worker during a deploy, still narrows the call to this server's organization.
   */
  private async authorize(
    principalKey: Access.PrincipalKey,
    organizationId: P.OrganizationId | null,
  ): Promise<
    | { readonly access: Access.AccessContext }
    | {
        readonly error: {
          readonly code: "storage_unavailable" | "server_unavailable";
          readonly message: string;
        };
      }
  > {
    const unavailable = {
      error: { code: "server_unavailable", message: "The server is unavailable." },
    } as const;
    const access = await run(this.resolveAccess(principalKey).pipe(Effect.result));
    if (Result.isFailure(access))
      return { error: { code: "storage_unavailable", message: access.failure.message } };
    if (access.success === null) return unavailable;
    if (organizationId !== null) {
      let owner = await this.ctx.storage.get<string>("organization-id");
      if (owner === undefined) {
        // One-time metadata backfill for servers provisioned before MCP. New servers persist this in provision().
        const row = await this.env.PLATFORM.prepare(
          "SELECT a.organization_id AS organizationId FROM servers s JOIN accounts a ON a.id=s.account_id WHERE s.id=? AND s.status='ready'",
        )
          .bind(access.success.serverId)
          .first();
        const identity = Schema.decodeUnknownResult(
          Schema.Struct({ organizationId: P.OrganizationId }),
        )(row);
        if (Result.isFailure(identity)) return unavailable;
        owner = identity.success.organizationId;
        await this.ctx.storage.put("organization-id", owner);
      }
      if (owner !== organizationId) return unavailable;
    }
    return { access: access.success };
  }
  /**
   * Private MCP events entry point: subscribe or unsubscribe a webhook for an explicitly named
   * participant under the caller's current grant. The callback is verified before anything is kept.
   */
  async invokeEvents(
    principalKey: Access.PrincipalKey,
    organizationId: P.OrganizationId | null,
    command: McpEvents.Command,
  ): Promise<McpEvents.Answer> {
    return this.operation(
      () => this.events(principalKey, organizationId, command),
      () => ({
        error: {
          code: McpEvents.codes.forbidden,
          message: "The server is unavailable.",
          diagnostic: { failure: "ServerUninitialized" },
        },
      }),
    );
  }
  private async events(
    principalKey: Access.PrincipalKey,
    organizationId: P.OrganizationId | null,
    command: McpEvents.Command,
  ): Promise<McpEvents.Answer> {
    if (Result.isFailure(await this.ready))
      return {
        error: {
          code: McpEvents.codes.internal,
          message: "The server is unavailable.",
          diagnostic: { failure: "ServerNotReady" },
        },
      };
    const parsed = Schema.decodeUnknownResult(McpEvents.Command)(command);
    if (Result.isFailure(parsed))
      return {
        error: {
          code: McpEvents.codes.invalidParams,
          message: "Invalid arguments.",
          diagnostic: { failure: "InvalidCommand" },
        },
      };
    const authorized = await this.authorize(principalKey, organizationId);
    if ("error" in authorized)
      return {
        error: {
          code:
            authorized.error.code === "storage_unavailable"
              ? McpEvents.codes.internal
              : McpEvents.codes.forbidden,
          message: authorized.error.message,
          diagnostic: { failure: authorized.error.code },
        },
      };
    const input = parsed.success;
    return run(
      Wakes.Wakes.pipe(
        Effect.flatMap((wakes) =>
          input.op === "subscribe"
            ? wakes.subscribe(authorized.access, input)
            : wakes.unsubscribe(authorized.access, input).pipe(Effect.as({})),
        ),
        Effect.map((ok): McpEvents.Answer => ({ ok })),
        Effect.catch((error) => Effect.succeed(McpEvents.failure(error))),
        Effect.provide(this.application),
      ),
    );
  }
  /** Private MCP application entry point. Every invocation resolves the current local access grant. */
  /**
   * For `send_feedback`: whether the caller can open this server, and whether the named agent was
   * registered here through the caller's own person's access (the rename check). The connection
   * never names the agent; an agent the caller did not register is simply not recorded.
   */
  async feedbackAttribution(
    principalKey: Access.PrincipalKey,
    organizationId: P.OrganizationId | null,
    participantId: string | null,
  ): Promise<{ readonly server: boolean; readonly participant: boolean }> {
    const none = { server: false, participant: false };
    return this.operation(
      async () => {
        if (Result.isFailure(await this.ready)) return none;
        const authorized = await this.authorize(principalKey, organizationId);
        if ("error" in authorized) return none;
        const id = Schema.decodeUnknownOption(M.ParticipantId)(participantId);
        if (Option.isNone(id)) return { server: true, participant: false };
        const registered = this.ctx.storage.sql
          .exec(
            `SELECT 1 FROM participants p JOIN server_grants g ON g.id=p.created_by_grant_id
           WHERE p.id=? AND g.principal_key=?`,
            id.value,
            authorized.access.principalKey,
          )
          .toArray();
        return { server: true, participant: registered.length > 0 };
      },
      () => none,
    );
  }
  async invokeAgent(
    principalKey: Access.PrincipalKey,
    organizationId: P.OrganizationId | null,
    command: A.Command,
    meta: A.Meta,
    reread = false,
  ): Promise<A.Reply> {
    return this.operation(
      () => this.agent(principalKey, organizationId, command, meta, reread === true),
      () => ({
        error: { code: "server_unavailable", message: "The server is unavailable." },
        meta,
      }),
    );
  }
  private async agent(
    principalKey: Access.PrincipalKey,
    organizationId: P.OrganizationId | null,
    command: A.Command,
    meta: A.Meta,
    reread: boolean,
  ): Promise<A.Reply> {
    const ready = await this.ready;
    if (Result.isFailure(ready))
      return { error: { code: "configuration_unavailable", message: ready.failure.message }, meta };
    const parsed = Schema.decodeUnknownResult(A.Command)(command);
    if (Result.isFailure(parsed))
      return { error: { code: "invalid_input", message: "Invalid application command." }, meta };
    const access = await this.authorize(principalKey, organizationId);
    if ("error" in access) return { error: access.error, meta };
    const resolvedAccess = access.access;
    const execute = () =>
      run(
        Agent.execute(resolvedAccess, parsed.success, meta, capabilities(this.env), reread).pipe(
          Effect.provide(this.application),
          Effect.catch((error) => Effect.succeed(Agent.failure(error, meta))),
        ),
      );
    const decoded = parsed.success;
    if (decoded.tool === "get_updates" && !reread) {
      const reply = await execute();
      this.watchReader(decoded.input, reply);
      return reply;
    }
    return decoded.tool === "send_message" ||
      decoded.tool === "share_file" ||
      decoded.tool === "complete_transfer"
      ? this.withMessageWork(execute)
      : execute();
  }
  /** Report a reader stuck at one checkpoint while messages wait. Advisory: never fails the call. */
  private watchReader(input: typeof A.GetUpdates.Type, reply: A.Reply) {
    try {
      const stuck = this.stuckReaders.observe(input, reply);
      if (stuck === null) return;
      Telemetry.stuckReader(stuck.plugin, stuck.polls);
      console.warn("TalkTo reader keeps asking get_updates from one checkpoint", stuck);
    } catch {
      // Reporting is advisory; the reader still gets its answer.
    }
  }
  /**
   * Open a hibernatable watch for a waiting get_updates call that a Worker holds. Only Workers
   * reach this route: they forward only `/v1/` paths from the network. A Worker sends the call's
   * first read with it: the watch is registered, then the read runs, in this one request, and the
   * route answers with the reply or opens the watch holding the empty page. The principal is
   * resolved as for any invocation. The handler returns at once; the watch keeps nothing running.
   */
  private async watch(request: Request): Promise<Response> {
    const refused = new Response(null, { status: 503 });
    if (Result.isFailure(await this.ready)) return refused;
    const principal = Schema.decodeUnknownResult(Access.PrincipalKey)(
      request.headers.get(Signal.principalHeader),
    );
    const organizationHeader = request.headers.get(Signal.organizationHeader);
    const organization =
      organizationHeader === null
        ? Result.succeed(null)
        : Schema.decodeUnknownResult(P.OrganizationId)(organizationHeader);
    const watch = Schema.decodeUnknownResult(Schema.fromJsonString(Signal.Watch))(
      request.headers.get(Signal.watchHeader),
    );
    const firstHeader = request.headers.get(Signal.firstReadHeader);
    const first =
      firstHeader === null ? null : Schema.decodeUnknownResult(Signal.FirstRead)(firstHeader);
    if (
      Result.isFailure(principal) ||
      Result.isFailure(organization) ||
      Result.isFailure(watch) ||
      (first !== null && Result.isFailure(first))
    )
      return new Response(null, { status: 400 });
    if (first === null) {
      // A Worker from before first reads: it reads separately once the watch is open.
      const authorized = await this.authorize(principal.success, organization.success);
      if ("error" in authorized) return new Response(null, { status: 403 });
      return (
        this.watches.accept(watch.success, DateTime.toEpochMillis(DateTime.nowUnsafe())) ?? refused
      );
    }
    const registration = this.watches.register(watch.success);
    try {
      const read = await this.firstRead(principal.success, organization.success, first.success);
      const opened =
        read.page === null
          ? null
          : registration.open(DateTime.toEpochMillis(DateTime.nowUnsafe()), read.page);
      if (opened !== null) return opened;
      read.reply.headers.set(Signal.answeredHeader, "1");
      return read.reply;
    } finally {
      registration.end();
    }
  }
  /**
   * A held call's first read, run once its watch is registered: the reply, and the page to hold
   * when it is empty. The MCP read is a tool invocation, the HTTP read the request a Worker would
   * have forwarded. Verification subclasses pause after it.
   */
  protected async firstRead(
    principal: Access.PrincipalKey,
    organization: P.OrganizationId | null,
    read: Signal.FirstRead,
  ): Promise<{ readonly reply: Response; readonly page: string | null }> {
    if (read.kind === "agent") {
      const reply = await this.agent(principal, organization, read.command, read.meta, false);
      const page = Schema.decodeUnknownOption(Signal.Page)(reply);
      return {
        reply: Response.json(reply),
        page:
          Option.isSome(page) && Signal.summary(page.value).empty
            ? Schema.encodeSync(Signal.AgentPage)(reply)
            : null,
      };
    }
    const headers = new Headers(read.headers);
    headers.delete("content-length");
    const response = await this.handle(
      new Request(read.url, { method: "POST", headers, body: read.body }),
    );
    const body = await response.text();
    const page =
      response.status === 200 ? decodeJsonPage(body) : Option.none<typeof Signal.Page.Type>();
    return {
      reply: new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      page:
        Option.isSome(page) && Signal.summary(page.value).empty
          ? Schema.encodeSync(Signal.HttpPage)({ headers: [...response.headers], body })
          : null,
    };
  }
  /** Workers never write to a watch; a stray frame changes nothing. */
  override webSocketMessage() {}
  /** A Worker closed its watch at its deadline or answer; the runtime completes the close. */
  override webSocketClose() {}
  /** A broken watch ends with its Worker's deadline or final read. */
  override webSocketError() {}
  /** Translate an already-authenticated internal request to the shared HTTP adapter. */
  override async fetch(request: Request): Promise<Response> {
    if (
      new URL(request.url).pathname === Signal.watchPath &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    )
      return this.operation(
        () => this.watch(request),
        () => new Response(null, { status: 503 }),
      );
    return this.operation(
      () => this.handle(request),
      () =>
        Responses.failure(
          404,
          "server_unavailable",
          "The server is unavailable.",
          Responses.metadata(new URL(request.url).origin),
        ),
    );
  }
  private async handle(request: Request): Promise<Response> {
    const ready = await this.ready;
    if (Result.isFailure(ready))
      return Responses.failure(
        503,
        "configuration_unavailable",
        ready.failure.message,
        Responses.metadata(new URL(request.url).origin),
      );
    const origin = ready.success;
    const suppliedRequestId = request.headers.get("x-talkto-request-id");
    const requestId = Schema.decodeUnknownOption(Envelope.Meta.fields.requestId)(suppliedRequestId);
    const meta = Responses.metadata(
      origin,
      requestId._tag === "Some" ? requestId.value : crypto.randomUUID(),
    );
    // The public Worker overwrites all authority headers after verifying credentials.
    let parsed = Schema.decodeUnknownResult(Schema.fromJsonString(Access.AccessContext))(
      request.headers.get("x-talkto-access"),
    );
    const principal = Schema.decodeUnknownResult(Access.PrincipalKey)(
      request.headers.get("x-talkto-principal"),
    );
    if (Result.isSuccess(principal)) {
      const access = await run(this.resolveAccess(principal.success).pipe(Effect.result));
      if (Result.isFailure(access))
        return Responses.failure(503, "storage_unavailable", access.failure.message, meta);
      if (access.success === null)
        return Responses.failure(404, "server_unavailable", "The server is unavailable.", meta);
      parsed = Result.succeed(access.success);
    }
    if (Result.isFailure(parsed))
      return Responses.failure(401, "unauthenticated", "Authenticated access is required.", meta);
    // Only the hosted Worker sets this, after verifying the website's session cookie; it removes
    // any copy a caller sent. It travels with x-talkto-principal, never with a local credential.
    const website =
      Result.isSuccess(principal) &&
      request.headers.get(Access.websiteHeader) === Access.websiteSession;
    // Likewise set only by the hosted Worker, from the verified WorkOS profile. Local access has no
    // profile, so a person there gets the generic name.
    const person = {
      name: Persons.fromHeader(
        Result.isSuccess(principal) ? request.headers.get(Persons.nameHeader) : null,
      ),
    };
    try {
      const access = parsed.success;
      const execute = () =>
        this.web.handler(
          request,
          Context.make(Http.RequestContext, {
            access,
            meta,
            website,
            person,
            // Every ingress removes a caller's copy; only a Worker holding a wait sets it.
            reread: request.headers.get(Signal.rereadHeader) === "1",
          }),
        );
      const pathname = new URL(request.url).pathname;
      const sendsMessage =
        request.method === "POST" &&
        (/^\/v1\/servers\/[^/]+\/conversations\/[^/]+\/messages$/.test(pathname) ||
          /^\/v1\/servers\/[^/]+\/people\/me\/messages$/.test(pathname));
      const response = await (sendsMessage ? this.withMessageWork(execute) : execute());
      response.headers.set("cache-control", "no-store");
      response.headers.set("x-request-id", meta.requestId);
      if (response.status < 400) return response;
      const text = await response.text();
      const publicError = Schema.decodeUnknownResult(Schema.fromJsonString(Envelope.Failure))(text);
      if (Result.isSuccess(publicError)) {
        const error = publicError.success.error;
        if (error.code === "rate_limited")
          response.headers.set("retry-after", String(error.retryAfterSeconds));
        return Response.json(publicError.success, {
          status: response.status,
          headers: response.headers,
        });
      }
      if (response.status >= 500) {
        console.error("TalkTo request failed", {
          requestId: meta.requestId,
          serverId: loggedServerId(request),
        });
        return Responses.failure(
          500,
          "internal_error",
          "An internal error occurred. Use the request ID for diagnosis.",
          meta,
        );
      }
      if (response.status === 404)
        return Responses.failure(404, "not_found", "The API route does not exist.", meta);
      return Responses.failure(
        response.status,
        "invalid_input",
        "The request does not match the API contract. Check its fields, types, and content type in /openapi.json.",
        meta,
      );
    } catch (cause) {
      console.error("TalkTo request failed", {
        requestId: meta.requestId,
        serverId: loggedServerId(request),
      });
      return Responses.failure(
        500,
        "internal_error",
        "An internal error occurred. Use the request ID for diagnosis.",
        meta,
        cause,
      );
    }
  }
}
