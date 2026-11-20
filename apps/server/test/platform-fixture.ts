import * as Metering from "../src/metering/model.js";
import { TestQuota } from "./metering-fixture.js";
export { TestQuota };
import { DateTime, Effect, Encoding, Layer, Result, Schema } from "effect";
import { createLocalJWKSet } from "jose";
import type * as A from "@talkto/api/agent";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as O from "@talkto/api/onboarding";
import type * as Access from "../src/access.js";
import * as Signal from "../src/update-signal.js";
import * as McpAuth from "../src/mcp-auth.js";
import * as Hosted from "../src/hosted.js";
import * as Model from "../src/platform/model.js";
import * as Platform from "../src/platform/service.js";
import * as WorkOS from "../src/platform/workos.js";
import * as Browser from "../src/browser-auth.js";
import { TalkToServer } from "../src/server-object.js";
import * as LocalMeter from "../src/metering/local.js";
import * as MeterConfig from "../src/metering/configuration.js";
import * as Activity from "../src/platform/activity.js";
import * as ActivityD1 from "../src/platform/activity-d1.js";
import * as Projection from "../src/platform/activity-projection.js";
import * as FilesFake from "./files-fake.js";
import * as EmailFake from "../src/email/fake.js";
import * as SignIns from "../src/sign-ins/service.js";

// Every read measurement any server object wrote in this isolate, in order.
const readEvents: AnalyticsEngineDataPoint[] = [];
const recordingDataset: AnalyticsEngineDataset = {
  writeDataPoint: (point) => {
    if (point !== undefined) readEvents.push(point);
  },
};
// Keyed by instance because the store is chosen inside the base constructor, before subclass fields exist.
const fakeStores = new WeakMap<TalkToServer, ReturnType<typeof FilesFake.make>>();
const FilesControl = Schema.Struct({
  remote: Schema.optionalKey(Schema.NullOr(Schema.String)),
  failRevocations: Schema.optionalKey(Schema.Int),
  failRemovals: Schema.optionalKey(Schema.Int),
  /** Overwrite the recorded `file_repository` remote as a stringified provider stub once did on staging. */
  recordedRemote: Schema.optionalKey(Schema.String),
  /** Attach a Git share reference to an existing message, as `share_file` did before retirement. */
  shareMessageId: Schema.optionalKey(Schema.String),
});

export interface TestEnv extends Env {
  readonly QUOTAS: DurableObjectNamespace<TestQuota>;
  readonly TEST_JWKS: string;
  readonly TEST_ALIAS_JWKS: string;
  readonly SERVERS: DurableObjectNamespace<PlatformTestServer>;
}
const members = new Map<string, P.Member>();
const memberPage = (items: ReadonlyArray<P.Member>, after: string | undefined, limit: number) => {
  const ordered = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const start = after === undefined ? 0 : ordered.findIndex((item) => item.id === after) + 1;
  const page = ordered.slice(start, start + limit);
  return {
    items: page,
    nextCursor: start + limit < ordered.length ? (page.at(-1)?.id ?? null) : null,
  };
};
const events: Model.IdentityEvent[] = [];
const invitations = new Map<P.InvitationId, P.Invitation>();
const acceptedInvitations = new Map<P.InvitationId, P.UserId>();
let resent = 0;
const timestamp = () => M.Timestamp.make(DateTime.formatIso(DateTime.nowUnsafe()));
const missing = () => new Model.Failure({ code: "not_found", message: "Invitation unavailable." });
/** Fixed addresses: a recreated identity, and Gmail and `+tag` spellings of one inbox. */
const emails = new Map([
  ["user_recreated", "user_alice@example.com"],
  ["user_gmaildots", "Jane.Doe@gmail.com"],
  ["user_gmailplus", "janedoe+agents@googlemail.com"],
  ["user_companyplus", "jane.doe+agents@example.com"],
  // `+tag` spellings of one company inbox, and addresses claimed under the earlier rules.
  ["user_tagone", "Sam+one@example.com"],
  ["user_tagbare", "sam@example.com"],
  ["user_tagtwo", "sam+two@Example.com"],
  ["user_legacytag", "lee+old@example.com"],
  ["user_trialtag", "kim+trial@example.com"],
  ["user_trialcanonical", "pat+x@example.com"],
  // Share links: a colleague at the sharer's company domain, and people at one public mail domain.
  ["user_colleague", "cal@sharer.test"],
  ["user_gmailann", "ann@gmail.com"],
  ["user_gmailbea", "bea@gmail.com"],
]);
/**
 * `user_far<name>` has its own company domain (`<name>@far<name>.test`), so share-link tests can
 * make many unrelated people; `user_sharer` is `sam@sharer.test`.
 */
const emailOf = (id: string) => {
  const far = /^user_far([a-z0-9]+)$/.exec(id)?.[1];
  if (far !== undefined) return `${far}@far${far}.test`;
  if (id === "user_sharer") return "sam@sharer.test";
  return emails.get(id) ?? `${id}@example.com`;
};
/** What account deletion asked the provider to delete, and injected provider failures. */
const deletedUsers = new Set<string>();
const deletedOrganizations = new Set<string>();
const identityFaults = { deleteUser: 0, deleteOrganization: 0 };
const IdentityFaults = Schema.Struct({
  deleteUser: Schema.optionalKey(Schema.Int),
  deleteOrganization: Schema.optionalKey(Schema.Int),
});
/** Authorized Connect applications per user, what sign-out revoked, and injected failures. */
const authorizedApps = new Map<string, Model.AuthorizedApplication[]>();
const revokedApps: Array<{ readonly userId: string; readonly clientId: string }> = [];
const authorizedFaults = { list: 0, revoke: 0 };
const AuthorizedControl = Schema.Struct({
  userId: Schema.optionalKey(Schema.String),
  apps: Schema.optionalKey(Schema.Array(Model.AuthorizedApplication)),
  faults: Schema.optionalKey(
    Schema.Struct({ list: Schema.optionalKey(Schema.Int), revoke: Schema.optionalKey(Schema.Int) }),
  ),
});
const injected = () =>
  new Model.Failure({ code: "identity_unavailable", message: "Injected identity failure." });
let databaseDown = false;
/** Worker variables a test changed after start (`/__control/env`). */
const envOverrides: Record<string, string> = {};
let authenticationDown = false;
/** Server object names the Worker looked up for requests it served, so tests can see wakes. */
const serverLookups: string[] = [];
const recordLookups = (servers: TestEnv["SERVERS"]): TestEnv["SERVERS"] => ({
  newUniqueId: (options) => servers.newUniqueId(options),
  idFromName: (name) => servers.idFromName(name),
  idFromString: (id) => servers.idFromString(id),
  get: (id, options) => servers.get(id, options),
  getByName: (name, options) => {
    serverLookups.push(name);
    return servers.getByName(name, options);
  },
  jurisdiction: (jurisdiction) => servers.jurisdiction(jurisdiction),
});
const keyset = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      kty: Schema.String,
      n: Schema.String,
      e: Schema.String,
      kid: Schema.String,
      alg: Schema.String,
    }),
  ),
});
const identity = Layer.succeed(
  Platform.Identity,
  Platform.Identity.of({
    user: (id) =>
      deletedUsers.has(id)
        ? Effect.fail(new Model.Failure({ code: "not_found", message: "User unavailable." }))
        : Effect.succeed({
            id,
            email: emailOf(id),
            emailVerified: id !== "user_unverified",
            firstName: id.slice(5),
            lastName: null,
          }),
    invitations: (organizationId) =>
      Effect.succeed({
        items: [...invitations.values()].filter((i) => i.organizationId === organizationId),
        nextCursor: null,
      }),
    invitation: (id) => {
      const value = invitations.get(id);
      return value === undefined ? Effect.fail(missing()) : Effect.succeed(value);
    },
    acceptedInvitee: (id) => Effect.succeed(acceptedInvitations.get(id) ?? null),
    findInvitations: (organizationId, email) =>
      Effect.succeed({
        items: [...invitations.values()].filter(
          (i) => i.organizationId === organizationId && i.email === email,
        ),
        nextCursor: null,
      }),
    invite: (organizationId, _inviter, input) =>
      Effect.gen(function* () {
        if (
          [...invitations.values()].some(
            (i) =>
              i.organizationId === organizationId &&
              i.email === input.email &&
              i.state === "pending",
          )
        )
          return yield* new Model.Failure({
            code: "invalid_input",
            message: "Email already invited.",
          });
        const value: P.Invitation = {
          id: P.InvitationId.make(`invitation_${crypto.randomUUID().replaceAll("-", "")}`),
          organizationId,
          email: input.email,
          state: "pending",
          createdAt: timestamp(),
          expiresAt: M.Timestamp.make("2099-01-01T00:00:00.000Z"),
        };
        invitations.set(value.id, value);
        return value;
      }),
    resend: (id) =>
      Effect.gen(function* () {
        const value = invitations.get(id);
        if (value === undefined) return yield* missing();
        resent++;
        return value;
      }),
    cancel: (id) =>
      Effect.gen(function* () {
        const value = invitations.get(id);
        if (value === undefined) return yield* missing();
        const next: P.Invitation = { ...value, state: "revoked" };
        invitations.set(id, next);
        return next;
      }),
    deactivate: (member) =>
      Effect.sync(() => {
        const next: P.Member = { ...member, status: "inactive", updatedAt: timestamp() };
        members.set(member.id, next);
        events.push({ kind: "membership", id: `event_${events.length}`, member: next });
        return next;
      }),
    createAccount: (reservation) =>
      Effect.sync(() => {
        const organizationId = P.OrganizationId.make(`org_${reservation.id.replaceAll("-", "")}`);
        const id = P.MembershipId.make(`om_${reservation.id.replaceAll("-", "")}`);
        if (!members.has(id))
          members.set(id, {
            id,
            organizationId,
            userId: reservation.createdBy,
            role: "member",
            status: "active",
            updatedAt: reservation.createdAt,
          });
        return organizationId;
      }),
    membership: (organizationId, userId) =>
      Effect.sync(
        () =>
          [...members.values()].find(
            (member) => member.organizationId === organizationId && member.userId === userId,
          ) ?? null,
      ),
    memberships: (userId, after, limit) =>
      Effect.sync(() =>
        memberPage(
          [...members.values()].filter((member) => member.userId === userId),
          after,
          limit,
        ),
      ),
    members: (organizationId, after, limit) =>
      Effect.sync(() =>
        memberPage(
          [...members.values()].filter(
            (member) => member.organizationId === organizationId && member.status === "active",
          ),
          after,
          limit,
        ),
      ),
    events: (cursor) =>
      Effect.sync(() =>
        events.slice(
          cursor === null ? 0 : events.findIndex((event) => event.id === cursor) + 1,
          100,
        ),
      ),
    authorizedApplications: (userId) =>
      Effect.gen(function* () {
        if (authorizedFaults.list > 0) {
          authorizedFaults.list--;
          return yield* injected();
        }
        return authorizedApps.get(userId) ?? [];
      }),
    // Like WorkOS: revoking removes the user's authorization of that client.
    revokeAuthorizedApplication: (userId, clientId) =>
      Effect.gen(function* () {
        if (authorizedFaults.revoke > 0) {
          authorizedFaults.revoke--;
          return yield* injected();
        }
        revokedApps.push({ userId, clientId });
        authorizedApps.set(
          userId,
          (authorizedApps.get(userId) ?? []).filter((app) => app.clientId !== clientId),
        );
      }),
    // Like WorkOS: deleting a user or organization also removes its memberships and invitations.
    deleteUser: (userId) =>
      Effect.gen(function* () {
        if (identityFaults.deleteUser > 0) {
          identityFaults.deleteUser--;
          return yield* injected();
        }
        deletedUsers.add(userId);
        for (const [id, member] of members) if (member.userId === userId) members.delete(id);
        events.push({
          kind: "user_deleted",
          id: `event_${events.length}`,
          userId,
          at: timestamp(),
        });
      }),
    deleteOrganization: (account) =>
      Effect.gen(function* () {
        if (identityFaults.deleteOrganization > 0) {
          identityFaults.deleteOrganization--;
          return yield* injected();
        }
        const organizationId =
          account.organizationId ?? P.OrganizationId.make(`org_${account.id.replaceAll("-", "")}`);
        deletedOrganizations.add(organizationId);
        for (const [id, member] of members) {
          if (member.organizationId !== organizationId) continue;
          members.delete(id);
          // WorkOS reports each removed membership; late events must not restore D1 rows.
          events.push({
            kind: "membership",
            id: `event_${events.length}`,
            member: { ...member, status: "deleted", updatedAt: timestamp() },
          });
        }
        for (const [id, invite] of invitations)
          if (invite.organizationId === organizationId) invitations.delete(id);
      }),
  }),
);
const mcpIssuer = "https://auth.talkto.test";
const worker = Hosted.makeWorker((env) =>
  Effect.gen(function* () {
    if (authenticationDown)
      return yield* new Model.Failure({
        code: "identity_unavailable",
        message: "Injected authentication failure.",
      });
    // A self-hosted copy that signs people in with Cloudflare Access: production's own builder.
    if ("TEST_ACCESS" in env && env.TEST_ACCESS === "true")
      return yield* Hosted.accessAuthentication(env);
    const testEnv = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        TEST_JWKS: Schema.fromJsonString(keyset),
        TEST_ALIAS_JWKS: Schema.fromJsonString(keyset),
        WORKOS_MCP_ISSUER_ALIASES: Schema.optionalKey(Schema.String),
      }),
    )(env).pipe(Effect.orDie);
    const keys = testEnv.TEST_JWKS;
    const configEnv = {
      ...env,
      WORKOS_CLIENT_ID: "client_test",
      WORKOS_API_KEY: "unused",
    };
    const config = yield* WorkOS.configuration(configEnv);
    const browser = yield* Browser.make(configEnv, config, "https://talkto.test");
    if (browser === undefined) return yield* Effect.die("Browser test configuration missing");
    return {
      verify: WorkOS.verifier(config, createLocalJWKSet({ keys: [...keys.keys] })),
      identity:
        "TEST_REAL_IDENTITY" in env && env.TEST_REAL_IDENTITY === "true"
          ? WorkOS.layer(config)
          : identity,
      browser,
      mcp: {
        issuer: mcpIssuer,
        // The same alias parsing as production; each issuer verifies with its own key set.
        verify: McpAuth.verifier(
          mcpIssuer,
          McpAuth.issuerAliases(testEnv.WORKOS_MCP_ISSUER_ALIASES, mcpIssuer),
          "https://talkto.test/mcp",
          "TEST_REMOTE_MCP_JWKS" in env && env.TEST_REMOTE_MCP_JWKS === "true"
            ? undefined
            : (issuer) =>
                createLocalJWKSet({
                  keys: [...(issuer === mcpIssuer ? keys : testEnv.TEST_ALIAS_JWKS).keys],
                }),
        ),
      },
    };
  }),
);

const ActivitySeed = Schema.Struct({
  serverId: M.ServerId,
  messages: Schema.Array(
    Schema.Struct({
      participantId: M.ParticipantId,
      conversationId: M.ConversationId,
      at: M.Timestamp,
      body: M.MessageBody,
    }),
  ).check(Schema.isMaxLength(1000)),
});

/** What one server object did while a test measured it (`/__control/cost`). */
interface Measured {
  readonly statements: Array<{
    readonly query: string;
    readonly rowsRead: () => number;
    readonly rowsWritten: () => number;
  }>;
  readonly requests: { fetch: number; invokeAgent: number };
  /** `setAlarm` calls, which Cloudflare bills as one row written each. */
  alarms: number;
}
const measuring = new WeakMap<DurableObjectStorage, Measured>();
/**
 * Note each statement a server object runs, and the rows it read, while a test measures it. The
 * object's own SqlStorage is wrapped before the server is built, so every caller is seen.
 */
const measureStatements = (storage: DurableObjectStorage) => {
  const sql = storage.sql;
  const exec = sql.exec.bind(sql);
  sql.exec = <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) => {
    const cursor = exec<T>(query, ...bindings);
    measuring.get(storage)?.statements.push({
      query,
      rowsRead: () => cursor.rowsRead,
      rowsWritten: () => cursor.rowsWritten,
    });
    return cursor;
  };
  const setAlarm = storage.setAlarm.bind(storage);
  const count = () => {
    const measured = measuring.get(storage);
    if (measured !== undefined) measured.alarms++;
  };
  storage.setAlarm = (time, options) => {
    count();
    return setAlarm(time, options);
  };
  const transaction = storage.transaction.bind(storage);
  storage.transaction = (closure) =>
    transaction((txn) => {
      const set = txn.setAlarm.bind(txn);
      txn.setAlarm = (time, options) => {
        count();
        return set(time, options);
      };
      return closure(txn);
    });
};

/** Fault injection is confined to this test-only Durable Object export. */
export class PlatformTestServer extends TalkToServer {
  constructor(ctx: DurableObjectState, env: Env) {
    measureStatements(ctx.storage);
    super(ctx, env);
  }
  /** Start measuring this object's requests and SQL, or return what it did since and stop. */
  async cost(action: "start" | "take") {
    if (action === "start") {
      measuring.set(this.ctx.storage, {
        statements: [],
        requests: { fetch: 0, invokeAgent: 0 },
        alarms: 0,
      });
      return null;
    }
    const measured = measuring.get(this.ctx.storage);
    measuring.delete(this.ctx.storage);
    if (measured === undefined) return null;
    const statements = measured.statements.map(({ query, rowsRead, rowsWritten }) => ({
      query,
      rowsRead: rowsRead(),
      rowsWritten: rowsWritten(),
    }));
    return {
      requests: measured.requests,
      rowsRead: statements.reduce((total, statement) => total + statement.rowsRead, 0),
      rowsWritten: statements.reduce((total, statement) => total + statement.rowsWritten, 0),
      alarms: measured.alarms,
      statements,
    };
  }
  override async fetch(request: Request) {
    const measured = measuring.get(this.ctx.storage);
    if (measured !== undefined) measured.requests.fetch++;
    if (!this.legacyWatches || !request.headers.has(Signal.firstReadHeader))
      return super.fetch(request);
    // An object from before first reads never sees the header: it only opens the watch.
    const headers = new Headers(request.headers);
    headers.delete(Signal.firstReadHeader);
    return super.fetch(new Request(request.url, { headers }));
  }
  override async invokeAgent(
    principalKey: Access.PrincipalKey,
    organizationId: P.OrganizationId | null,
    command: A.Command,
    meta: A.Meta,
    reread = false,
  ) {
    const measured = measuring.get(this.ctx.storage);
    if (measured !== undefined) measured.requests.invokeAgent++;
    return super.invokeAgent(principalKey, organizationId, command, this.replyMeta(meta), reread);
  }
  private malformedReplies = false;
  /** Replies start from this metadata; a broken request ID breaks the reply's contract. */
  private replyMeta(meta: A.Meta): A.Meta {
    return this.malformedReplies ? { ...meta, requestId: "not-a-request-id" } : meta;
  }
  private legacyWatches = false;
  private firstReadPaused = false;
  private firstReadReached = Promise.withResolvers<void>();
  private firstReadReleased = Promise.withResolvers<void>();
  /** Pause a held call after its first read, before its watch opens, so a send can land there. */
  protected override async firstRead(
    principal: Access.PrincipalKey,
    organization: P.OrganizationId | null,
    read: Signal.FirstRead,
  ) {
    const result = await super.firstRead(
      principal,
      organization,
      read.kind === "agent" ? { ...read, meta: this.replyMeta(read.meta) } : read,
    );
    if (this.firstReadPaused) {
      this.firstReadReached.resolve();
      await this.firstReadReleased.promise;
    }
    return result;
  }
  async firstReadControl(action: "pause" | "reached" | "release" | "legacy" | "malformed") {
    if (action === "legacy") this.legacyWatches = true;
    if (action === "malformed") this.malformedReplies = true;
    if (action === "pause") {
      this.firstReadPaused = true;
      this.firstReadReached = Promise.withResolvers<void>();
      this.firstReadReleased = Promise.withResolvers<void>();
    }
    if (action === "reached") await this.firstReadReached.promise;
    if (action === "release") {
      this.firstReadPaused = false;
      this.firstReadReleased.resolve();
    }
    return { ok: true };
  }
  private limiterHeldAt: number | null = null;
  /**
   * Hold the read and admin rate-limit clock where it is now, move a held clock forward, or let
   * it run again. Held, a bucket refills only when the test says so, never by machine speed.
   */
  async limiterClock(input: { readonly hold?: boolean; readonly advanceMillis?: number }) {
    if (input.hold === true) this.limiterHeldAt ??= Date.now();
    if (input.hold === false) this.limiterHeldAt = null;
    if (input.advanceMillis !== undefined && this.limiterHeldAt !== null)
      this.limiterHeldAt += input.advanceMillis;
    return { heldAt: this.limiterHeldAt };
  }
  protected override limiterTime() {
    return this.limiterHeldAt === null ? super.limiterTime() : Effect.succeed(this.limiterHeldAt);
  }
  /** Seed dated immutable messages for timeline and scroll verification using real constraints. */
  async seedActivity(input: typeof ActivitySeed.Type) {
    this.ctx.storage.transactionSync(() => {
      // Move fixture creation times before its dated history; all message triggers stay enabled.
      const first = input.messages[0];
      if (first) {
        const at = DateTime.toEpochMillis(DateTime.makeUnsafe(first.at));
        this.ctx.storage.sql.exec("UPDATE participants SET created_at=MIN(created_at,?)", at);
        this.ctx.storage.sql.exec("UPDATE conversations SET created_at=MIN(created_at,?)", at);
      }
      for (const message of input.messages)
        this.ctx.storage.sql.exec(
          `INSERT INTO messages(id,conversation_id,sender_id,created_by_grant_id,request_key,body,created_at)
         SELECT ?,?,p.id,p.created_by_grant_id,?,?,? FROM participants p WHERE p.id=?`,
          crypto.randomUUID(),
          message.conversationId,
          crypto.randomUUID(),
          message.body,
          DateTime.toEpochMillis(DateTime.makeUnsafe(message.at)),
          message.participantId,
        );
    });
    return { ok: true };
  }
  /**
   * Inspect history retention, or try an ordinary DELETE of the newest message, which the
   * retention guard must still refuse.
   */
  async historyControl(action: "inspect" | "delete") {
    if (action === "delete")
      try {
        this.ctx.storage.sql.exec("DELETE FROM messages WHERE seq=(SELECT MAX(seq) FROM messages)");
        return { deleted: true, error: null };
      } catch (cause) {
        return { deleted: false, error: cause instanceof Error ? cause.message : "unknown" };
      }
    const rows = (query: string) => this.ctx.storage.sql.exec(query).toArray();
    return {
      messages: rows("SELECT seq, id, body, created_at AS createdAt FROM messages ORDER BY seq"),
      search: rows(
        "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'ancient' ORDER BY rowid",
      ),
      retention: rows("SELECT * FROM history_retention")[0] ?? null,
      size: rows("SELECT * FROM history_size")[0] ?? null,
      state: (await this.ctx.storage.get("history-retention")) ?? null,
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
  /** Substitute the recording fake when the harness asks; the local remote still advertises the capability. */
  protected override configureFiles(env: Env) {
    if (!("TEST_FAKE_FILES" in env && env.TEST_FAKE_FILES === "true"))
      return super.configureFiles(env);
    const fake = FilesFake.make(() => this.meteringTime());
    fakeStores.set(this, fake);
    return Effect.succeed(fake.store);
  }
  /** Record read measurements in memory so tests can inspect what the dataset would receive. */
  protected override readEvents(env: Env) {
    return "TEST_RECORD_READS" in env ? recordingDataset : super.readEvents(env);
  }
  /** Make this server's own search fail, as a storage fault would, while it stays readable. */
  async breakSearch() {
    this.ctx.storage.sql.exec("ALTER TABLE messages_fts RENAME TO messages_fts_broken");
    return { ok: true };
  }
  /** Age every upload link on this server, as if each reservation had been abandoned. */
  async expireTransferLinks() {
    this.ctx.storage.sql.exec("UPDATE file_transfers SET upload_expires_at=created_at");
    return { ok: true };
  }
  /** Age every transfer on this server past its retention, as if 30 days had gone by. */
  async expireTransfers() {
    this.ctx.storage.sql.exec(
      "UPDATE file_transfers SET upload_expires_at=created_at, expires_at=created_at",
    );
    return { ok: true };
  }
  /** Age every signal link past its expiry, or start a new history lineage, as a restore would. */
  async signalsControl(action: "expire" | "new-generation" | "legacy") {
    if (action === "legacy") {
      // Replace every link's secret with a fully random one, as links minted before signal keys.
      const secret = Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
      const hash = Encoding.encodeHex(new Uint8Array(digest));
      this.ctx.storage.sql.exec("UPDATE participant_signals SET secret_hash=?", hash);
      return { ok: true, secret };
    }
    if (action === "expire")
      this.ctx.storage.sql.exec("UPDATE participant_signals SET expires_at=created_at+1");
    else
      this.ctx.storage.sql.exec(
        "UPDATE updates_identity SET generation=lower(hex(randomblob(16))) WHERE singleton=1",
      );
    return { ok: true };
  }
  /**
   * Inspect wake rows, deliver what is due as if its time had come, or spend a participant's
   * hourly wake budget. Delivery runs the real alarm body for wakes only.
   */
  async wakesControl(input: {
    readonly action: "inspect" | "deliver" | "exhaust";
    readonly participantId?: string;
  }) {
    const now = Date.now();
    if (input.action === "deliver") {
      this.ctx.storage.sql.exec(
        "UPDATE wake_targets SET due_at=? WHERE due_at IS NOT NULL AND due_at>?",
        now,
        now,
      );
      await this.deliverWakes();
    }
    if (input.action === "exhaust" && input.participantId !== undefined)
      this.ctx.storage.sql.exec(
        "INSERT INTO wake_sends(participant_id,hour,sent) VALUES(?,?,60) ON CONFLICT DO UPDATE SET sent=60",
        input.participantId,
        Math.floor(now / 3_600_000),
      );
    return {
      now,
      targets: this.ctx.storage.sql
        .exec("SELECT * FROM wake_targets ORDER BY created_at")
        .toArray(),
      sends: this.ctx.storage.sql.exec("SELECT * FROM wake_sends").toArray(),
      cadences: this.ctx.storage.sql.exec("SELECT * FROM participant_wake_cadence").toArray(),
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
  /** Steer the fake store between calls: relocate its remote, make revocations fail, or corrupt the recorded row. */
  async controlFiles(
    input: FilesFake.Control & {
      readonly recordedRemote?: string;
      readonly shareMessageId?: string;
    },
  ) {
    fakeStores.get(this)?.control(input);
    if (input.recordedRemote !== undefined)
      this.ctx.storage.sql.exec(
        "INSERT INTO file_repository(singleton,remote,default_branch,created_at) VALUES(1,?,'main',0) ON CONFLICT(singleton) DO UPDATE SET remote=excluded.remote",
        input.recordedRemote,
      );
    if (input.shareMessageId !== undefined)
      this.ctx.storage.sql.exec(
        "INSERT INTO message_shares(message_id,seq,path,commit_hash,ref,bytes) SELECT id,seq,'specs/billing-rewrite/api.md','9f3c2ab4d1e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0','main',18432 FROM messages WHERE id=?",
        input.shareMessageId,
      );
    return { ok: true };
  }
  /** What the fake observed plus the ledger rows; tables may already be erased. */
  async inspectFiles() {
    const rows = (table: string) =>
      this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table)
        .toArray().length === 0
        ? []
        : this.ctx.storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid`).toArray();
    return {
      recorded: fakeStores.get(this)?.recorded() ?? null,
      repository: rows("file_repository"),
      tokens: rows("file_tokens"),
      shares: rows("message_shares"),
    };
  }
  /** Inspect only fixture storage structure after irreversible deletion. */
  async inspectDeletion() {
    return {
      tables: this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table'")
        .toArray(),
      keys: [...(await this.ctx.storage.list()).keys()],
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
  /** Emulate the deployed v1 RPC receiver, which ignores the added optional argument. */
  override async readOnboarding(
    principal: Access.PrincipalKey,
    names: readonly [M.Name, M.Name],
    agents?: O.AgentLookups,
    more?: O.MoreLookups,
    since?: M.Timestamp,
  ) {
    const legacy =
      "TEST_LEGACY_ONBOARDING" in this.env && this.env.TEST_LEGACY_ONBOARDING === "true";
    return super.readOnboarding(
      principal,
      names,
      legacy ? undefined : agents,
      legacy ? undefined : more,
      legacy ? undefined : since,
    );
  }
  private projectionPaused = false;
  private projectionReached = Promise.withResolvers<void>();
  private projectionReleased = Promise.withResolvers<void>();
  /** Deterministic pause after D1 acknowledgment exercises a concurrent message at shutdown. */
  protected override async exportActivity() {
    const batch = await super.exportActivity();
    if (this.projectionPaused) {
      this.projectionReached.resolve();
      await this.projectionReleased.promise;
    }
    return batch;
  }
  /** Count actual projection passes and expose only test-local interruption controls. */
  override async projectActivity() {
    const passes = (await this.ctx.storage.get<number>("test-projection-passes")) ?? 0;
    await this.ctx.storage.put("test-projection-passes", passes + 1);
    return super.projectActivity();
  }
  private testDatabaseSize: number | null = null;
  /** Stand in for a database past a size threshold; null restores the real size. */
  async setDatabaseSize(bytes: number | null) {
    this.testDatabaseSize = bytes;
  }
  protected override databaseSize() {
    return this.testDatabaseSize ?? super.databaseSize();
  }
  /** Run the real alarm body explicitly when automatic fixture alarms are disabled. */
  async resourceControl(
    action: "inspect" | "flush" | "pause" | "reached" | "release" | "restart" | "clear-alarm",
  ) {
    if (action === "pause") {
      this.projectionPaused = true;
      this.projectionReached = Promise.withResolvers<void>();
      this.projectionReleased = Promise.withResolvers<void>();
    }
    if (action === "reached") await this.projectionReached.promise;
    if (action === "release") {
      this.projectionPaused = false;
      this.projectionReleased.resolve();
    }
    if (action === "restart") this.ctx.abort("Test resource restart");
    if (action === "clear-alarm" || action === "flush") await this.ctx.storage.deleteAlarm();
    if (action === "flush") await super.alarm();
    return {
      alarm: await this.ctx.storage.getAlarm(),
      passes: (await this.ctx.storage.get<number>("test-projection-passes")) ?? 0,
      messages: this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM messages").one().n,
    };
  }
  /** Exercise upgrades and quiet polling on the hosted object, without production control routes. */
  async updatesControl(action: "downgrade" | "clear-alarm" | "inspect") {
    if (action === "downgrade") {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("DROP TABLE updates_identity");
        this.ctx.storage.sql.exec("DELETE FROM schema_migrations WHERE version=3");
      });
      this.ctx.abort("Test upgrade from version 2");
    }
    if (action === "clear-alarm") await this.ctx.storage.deleteAlarm();
    return {
      alarm: await this.ctx.storage.getAlarm(),
      version: this.ctx.storage.sql
        .exec("SELECT MAX(version) AS version FROM schema_migrations")
        .one().version,
    };
  }
  override async alarm() {
    if ("TEST_MANUAL_ALARMS" in this.env && this.env.TEST_MANUAL_ALARMS === "true") return;
    await super.alarm();
  }
  async meterControl(input: {
    at?: M.Timestamp;
    failWrite?: boolean;
    restart?: boolean;
    failReports?: number;
    failUnreported?: boolean;
  }) {
    if (input.failReports !== undefined)
      await this.ctx.storage.put("test-fail-reports", input.failReports);
    if (input.failUnreported !== undefined)
      await this.ctx.storage.put("test-fail-unreported", input.failUnreported);
    if (input.at !== undefined) await this.ctx.storage.put("test-clock", input.at);
    if (input.at !== undefined) this.testTime = input.at;
    if (input.failWrite === true)
      this.ctx.storage.sql.exec(
        "CREATE TRIGGER fail_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected write failure'); END",
      );
    if (input.failWrite === false) this.ctx.storage.sql.exec("DROP TRIGGER IF EXISTS fail_message");
    if (input.restart === true) this.ctx.abort("Test eviction");
  }
  /** The quota object's requests to close a held block, failing the next `failReports` of them. */
  override async reportUsage(input?: { readonly id?: M.RequestKey }) {
    const failing = (await this.ctx.storage.get<number>("test-fail-reports")) ?? 0;
    if (failing > 0) {
      await this.ctx.storage.put("test-fail-reports", failing - 1);
      throw new Error("Injected server outage");
    }
    return super.reportUsage(input);
  }
  /** The read-only ask for unreported usage, failing while `failUnreported` is set. */
  override async unreportedUsage() {
    if ((await this.ctx.storage.get<boolean>("test-fail-unreported")) === true)
      throw new Error("Injected server outage");
    return super.unreportedUsage();
  }
  private testTime: M.Timestamp | null = null;
  protected override meteringTime() {
    return this.testTime ?? super.meteringTime();
  }
  async inspectMeter() {
    return {
      usage: this.ctx.storage.sql.exec("SELECT * FROM message_usage").toArray(),
      allocation: this.ctx.storage.sql.exec("SELECT * FROM message_allocation").toArray(),
    };
  }
  /** Spend more than one unit through the real local meter, refill, and retry protocol. */
  async spendUnits(input: {
    accountId: P.AccountId;
    serverId: M.ServerId;
    units: number;
    kind?: "message" | "share";
  }) {
    const value = Schema.decodeUnknownSync(
      Schema.Struct({
        accountId: P.AccountId,
        serverId: M.ServerId,
        units: Metering.Units,
        kind: Schema.optionalKey(Metering.UsageKind),
      }),
    )(input);
    const local = LocalMeter.make(
      this.ctx.storage,
      this.env.QUOTAS,
      value.accountId,
      value.serverId,
      () => this.meteringTime(),
    );
    return await Effect.runPromise(
      Metering.withCapacity(
        local.meter,
        value.units,
      )(
        local.meter.consume(
          M.MessageId.make(crypto.randomUUID()),
          value.units,
          value.kind ?? "message",
        ),
      ).pipe(
        Effect.match({
          onSuccess: () => ({ ok: true, failure: null }),
          onFailure: (error) => ({ ok: false, failure: error._tag }),
        }),
      ),
    );
  }
  /** Reopen a journal written before metered units, to verify the guarded column upgrade. */
  async legacyUsageTable() {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("ALTER TABLE message_usage RENAME TO message_usage_legacy");
      this.ctx.storage.sql.exec(
        "CREATE TABLE message_usage(message_id TEXT PRIMARY KEY,allocation_id TEXT NOT NULL,period_start TEXT NOT NULL,committed_at TEXT NOT NULL) STRICT",
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO message_usage SELECT message_id,allocation_id,period_start,committed_at FROM message_usage_legacy",
      );
      this.ctx.storage.sql.exec("DROP TABLE message_usage_legacy");
    });
    return this.inspectMeter();
  }
  /** Fail provisioning after the platform reservation has been committed. */
  async failNextProvision() {
    await this.ctx.storage.put("fail-provision", true);
  }
  /** Simulate a temporary unavailable object without altering production code. */
  override async provision(server: Model.ServerReservation) {
    if (await this.ctx.storage.get("fail-provision")) {
      await this.ctx.storage.delete("fail-provision");
      return { ok: false };
    }
    return super.provision(server);
  }
  /** Fail the next access delivery across a real RPC boundary. */
  async failNextAccess() {
    await this.ctx.storage.put("fail-access", true);
  }
  /** Exercise recovery after the directory write but before the server acknowledgment. */
  override async applyAccess(command: Model.AccessCommand) {
    if (await this.ctx.storage.get("fail-access")) {
      await this.ctx.storage.delete("fail-access");
      return { ok: false };
    }
    return super.applyAccess(command);
  }
}
/** Separate build with fake provider state and real JWT, D1, DO, and HTTP implementations. */
export default {
  async scheduled(event, env, ctx) {
    if (worker.scheduled === undefined) throw new Error("Missing scheduled handler");
    await worker.scheduled(event, env, ctx);
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__control/")) {
      if (url.pathname === "/__control/break-search")
        return Response.json(
          await env.SERVERS.getByName(url.searchParams.get("server") ?? "").breakSearch(),
        );
      if (url.pathname === "/__control/deletion")
        return Response.json(
          await env.SERVERS.getByName(url.searchParams.get("server") ?? "").inspectDeletion(),
        );
      if (url.pathname === "/__control/provision") {
        const value = Schema.decodeUnknownSync(Model.ServerReservation)(await request.json());
        return Response.json(await env.SERVERS.getByName(value.id).provision(value));
      }
      if (url.pathname === "/__control/activity-seed") {
        const value = Schema.decodeUnknownSync(ActivitySeed)(await request.json());
        return Response.json(await env.SERVERS.getByName(value.serverId).seedActivity(value));
      }
      if (url.pathname === "/__control/onboarding-v1") {
        const value = Schema.decodeUnknownSync(
          Schema.Struct({
            serverId: M.ServerId,
            userId: P.UserId,
            names: Schema.Tuple([M.Name, M.Name]),
          }),
        )(await request.json());
        return Response.json(
          await env.SERVERS.getByName(value.serverId).readOnboarding(
            Model.actor(value.userId).principalKey,
            value.names,
          ),
        );
      }
      if (url.pathname === "/__control/resources") {
        const action = Schema.decodeUnknownSync(
          Schema.Literals([
            "inspect",
            "flush",
            "pause",
            "reached",
            "release",
            "restart",
            "clear-alarm",
          ]),
        )(await request.json());
        try {
          return Response.json(
            await env.SERVERS.getByName(url.searchParams.get("server") ?? "").resourceControl(
              action,
            ),
          );
        } catch {
          return Response.json({ error: "Resource work interrupted" }, { status: 503 });
        }
      }
      if (url.pathname === "/__control/resource-repair") {
        const result = await Effect.runPromise(
          Projection.repair(env.PLATFORM, env.SERVERS).pipe(Effect.result),
        );
        return Response.json(result, { status: result._tag === "Success" ? 200 : 503 });
      }
      if (url.pathname === "/__control/activity-prune") {
        const limits = Schema.decodeUnknownSync(
          Schema.Struct({ rows: Schema.Int, statements: Schema.Int }),
        )(await request.json());
        const result = await Effect.runPromise(
          Projection.prune(env.PLATFORM, limits).pipe(Effect.result),
        );
        return Result.isSuccess(result)
          ? Response.json({ deleted: result.success })
          : Response.json({ error: "Prune failed" }, { status: 503 });
      }
      if (url.pathname === "/__control/history") {
        const action = Schema.decodeUnknownSync(Schema.Literals(["inspect", "delete"]))(
          await request.json(),
        );
        return Response.json(
          await env.SERVERS.getByName(url.searchParams.get("server") ?? "").historyControl(action),
        );
      }
      if (url.pathname === "/__control/database-size") {
        const input = Schema.decodeUnknownSync(Schema.Struct({ bytes: Schema.NullOr(Schema.Int) }))(
          await request.json(),
        );
        await env.SERVERS.getByName(url.searchParams.get("server") ?? "").setDatabaseSize(
          input.bytes,
        );
        return Response.json({ ok: true });
      }
      if (url.pathname === "/__control/updates") {
        const action = Schema.decodeUnknownSync(
          Schema.Literals(["downgrade", "clear-alarm", "inspect"]),
        )(await request.json());
        return Response.json(
          await env.SERVERS.getByName(url.searchParams.get("server") ?? "").updatesControl(action),
        );
      }
      if (url.pathname === "/__control/signals") {
        const action = Schema.decodeUnknownSync(
          Schema.Literals(["expire", "new-generation", "legacy"]),
        )(await request.json());
        return Response.json(
          await env.SERVERS.getByName(url.searchParams.get("server") ?? "").signalsControl(action),
        );
      }
      if (url.pathname === "/__control/wakes") {
        const input = Schema.decodeUnknownSync(
          Schema.Struct({
            action: Schema.Literals(["inspect", "deliver", "exhaust"]),
            participantId: Schema.optionalKey(Schema.String),
          }),
        )(await request.json());
        return Response.json(
          await env.SERVERS.getByName(url.searchParams.get("server") ?? "").wakesControl(input),
        );
      }
      if (url.pathname === "/__control/cost") {
        const action = Schema.decodeUnknownSync(Schema.Literals(["start", "take"]))(
          await request.json(),
        );
        return Response.json(
          await env.SERVERS.getByName(url.searchParams.get("server") ?? "").cost(action),
        );
      }
      if (url.pathname === "/__control/limiter-clock") {
        const input = Schema.decodeUnknownSync(
          Schema.Struct({
            hold: Schema.optionalKey(Schema.Boolean),
            advanceMillis: Schema.optionalKey(Schema.Int),
          }),
        )(await request.json());
        return Response.json(
          await env.SERVERS.getByName(url.searchParams.get("server") ?? "").limiterClock(input),
        );
      }
      if (url.pathname === "/__control/first-read") {
        const action = Schema.decodeUnknownSync(
          Schema.Literals(["pause", "reached", "release", "legacy", "malformed"]),
        )(await request.json());
        return Response.json(
          await env.SERVERS.getByName(url.searchParams.get("server") ?? "").firstReadControl(
            action,
          ),
        );
      }
      if (url.pathname === "/__control/server-lookups")
        return Response.json({ names: serverLookups.splice(0) });
      if (url.pathname === "/__control/read-events") {
        const taken = readEvents.splice(0);
        return Response.json({ events: taken.map((point) => point.blobs) });
      }
      if (url.pathname.startsWith("/__control/storage")) {
        const account = Schema.decodeUnknownSync(P.AccountId)(url.searchParams.get("account"));
        const quota = env.QUOTAS.getByName(account);
        if (url.pathname.endsWith("/plan"))
          return Response.json(await quota.publishStoragePlan(await request.json()));
        // Reserve with an explicit expiry, so pool tests can run on the quota object's test clock.
        if (url.pathname.endsWith("/reserve"))
          return Response.json(await quota.reserveStorage(await request.json()));
        return Response.json(await quota.readStorage(account));
      }
      if (url.pathname.startsWith("/__control/quota")) {
        const quota = env.QUOTAS.getByName(url.searchParams.get("account") ?? "");
        if (url.pathname.endsWith("/history"))
          return Response.json(await quota.consumeHistory(await request.json()));
        if (url.pathname.endsWith("/bonus"))
          return Response.json(await quota.addBonus(await request.json()));
        if (url.pathname.endsWith("/history-cap"))
          return Response.json(await quota.historyCap(await request.json()));
        if (url.pathname.endsWith("/history-policy"))
          return Response.json(await quota.historyPolicy(await request.json()));
        if (url.pathname.endsWith("/publish"))
          return Response.json(
            await quota.publish(Schema.decodeUnknownSync(Metering.Period)(await request.json())),
          );
        if (url.pathname.endsWith("/configure")) {
          await quota.configure(await request.json());
          return Response.json({ ok: true });
        }
        if (url.pathname.endsWith("/restart")) {
          await quota.restart();
          return Response.json({ ok: true });
        }
        if (url.pathname.endsWith("/legacy"))
          return Response.json(await quota.legacySchema(await request.json()));
        if (url.pathname.endsWith("/schema")) return Response.json(await quota.endRequired());
        if (url.pathname.endsWith("/budget-rows")) return Response.json(await quota.budgetRows());
        if (url.pathname.endsWith("/alarm")) return Response.json(await quota.runAlarm());
        if (url.pathname.endsWith("/budget-due")) return Response.json(await quota.budgetDue());
        if (url.pathname.endsWith("/cost")) return Response.json(await quota.takeCost());
        if (url.pathname.endsWith("/revoke"))
          return Response.json(await quota.revoke(await request.json()));
        if (url.pathname.endsWith("/recalls")) return Response.json(await quota.recallQueue());
        if (url.pathname.endsWith("/free-month")) return Response.json(await quota.free());
        if (url.pathname.endsWith("/starter")) return Response.json(await quota.starter());
        if (url.pathname.endsWith("/budgets"))
          return Response.json({
            usage: await quota.budgetUsage(),
            calls: await quota.budgetCalls(),
          });
        return Response.json(await quota.read());
      }
      // Stands in for the agent's signed upload: the real R2 binding then sees the object.
      if (url.pathname === "/__control/transfer-object") {
        const key = url.searchParams.get("key") ?? "";
        const bytes = Number(url.searchParams.get("bytes"));
        await env.TRANSFERS?.put(key, new Uint8Array(bytes));
        return Response.json({ ok: true });
      }
      if (url.pathname === "/__control/transfer-links-expired")
        return Response.json(
          await env.SERVERS.getByName(url.searchParams.get("server") ?? "").expireTransferLinks(),
        );
      if (url.pathname === "/__control/transfers-expired")
        return Response.json(
          await env.SERVERS.getByName(url.searchParams.get("server") ?? "").expireTransfers(),
        );
      if (url.pathname === "/__control/transfer-objects") {
        const listed = await env.TRANSFERS?.list();
        return Response.json({ keys: listed?.objects.map((object) => object.key) ?? [] });
      }
      if (url.pathname === "/__control/files") {
        const server = env.SERVERS.getByName(url.searchParams.get("server") ?? "");
        const body = await request.text();
        if (body !== "")
          await server.controlFiles(Schema.decodeUnknownSync(FilesControl)(JSON.parse(body)));
        return Response.json(await server.inspectFiles());
      }
      if (url.pathname === "/__control/metering-settings")
        return Response.json(
          await Effect.runPromise(
            MeterConfig.read(env).pipe(
              Effect.match({
                onSuccess: (settings) => ({ ok: true, shareUnits: settings.shareUnits }),
                onFailure: (error) => ({ ok: false, operation: error.operation }),
              }),
            ),
          ),
        );
      if (url.pathname.startsWith("/__control/meter")) {
        const server = env.SERVERS.getByName(url.searchParams.get("server") ?? "");
        if (url.pathname.endsWith("/spend"))
          return Response.json(await server.spendUnits(await request.json()));
        if (url.pathname.endsWith("/legacy-usage"))
          return Response.json(await server.legacyUsageTable());
        // A body names the block to close, as the quota object's recall does.
        if (url.pathname.endsWith("/report")) {
          const body = await request.text();
          await server.reportUsage(
            body === ""
              ? undefined
              : Schema.decodeUnknownSync(Schema.Struct({ id: M.RequestKey }))(JSON.parse(body)),
          );
          return Response.json({ ok: true });
        }
        if (url.pathname.endsWith("/configure")) {
          await server.meterControl(await request.json());
          return Response.json({ ok: true });
        }
        return Response.json(await server.inspectMeter());
      }
      if (url.pathname === "/__control/member") {
        const member = Schema.decodeUnknownSync(P.Member)(await request.json());
        members.set(member.id, member);
        events.push({ kind: "membership", id: `event_${events.length}`, member });
      }
      if (url.pathname === "/__control/accept-invitation") {
        const input = Schema.decodeUnknownSync(
          Schema.Struct({ id: P.InvitationId, userId: P.UserId }),
        )(await request.json());
        const value = invitations.get(input.id);
        if (value === undefined || value.state !== "pending")
          return Response.json({ error: "Invitation unavailable" }, { status: 400 });
        invitations.set(input.id, { ...value, state: "accepted" });
        acceptedInvitations.set(input.id, input.userId);
        const member: P.Member = {
          id: P.MembershipId.make(`om_${crypto.randomUUID().replaceAll("-", "")}`),
          organizationId: value.organizationId,
          userId: input.userId,
          status: "active",
          role: "member",
          updatedAt: timestamp(),
        };
        members.set(member.id, member);
        events.push({ kind: "membership", id: `event_${events.length}`, member });
      }
      if (url.pathname === "/__control/identity-deletions") {
        const body = await request.text();
        if (body !== "")
          Object.assign(identityFaults, Schema.decodeUnknownSync(IdentityFaults)(JSON.parse(body)));
        return Response.json({
          users: [...deletedUsers],
          organizations: [...deletedOrganizations],
          members: [...members.values()],
          invitations: [...invitations.values()],
        });
      }
      if (url.pathname === "/__control/authorized-applications") {
        const body = await request.text();
        if (body !== "") {
          const input = Schema.decodeUnknownSync(AuthorizedControl)(JSON.parse(body));
          if (input.userId !== undefined && input.apps !== undefined)
            authorizedApps.set(input.userId, [...input.apps]);
          if (input.faults !== undefined) Object.assign(authorizedFaults, input.faults);
        }
        return Response.json({ apps: Object.fromEntries(authorizedApps), revoked: revokedApps });
      }
      if (url.pathname === "/__control/sign-in-caches") SignIns.resetCaches();
      if (url.pathname === "/__control/invitation-deliveries")
        return Response.json({ sent: invitations.size, resent });
      if (url.pathname === "/__control/project") {
        try {
          const result = await env.SERVERS.getByName(
            url.searchParams.get("server") ?? "",
          ).projectActivity();
          return Response.json(result, {
            status: url.searchParams.has("lose-response") ? 503 : 200,
          });
        } catch {
          return Response.json({ error: "Projection unavailable" }, { status: 503 });
        }
      }
      if (url.pathname === "/__control/publish") {
        const input = Schema.decodeUnknownSync(
          Schema.Struct({ batch: Projection.Batch, after: M.Count }),
        )(await request.json());
        await Effect.runPromise(Projection.publish(env.PLATFORM, input.batch, input.after));
      }
      if (url.pathname === "/__control/rank") {
        const input = Schema.decodeUnknownSync(
          Schema.Struct({ accountId: P.AccountId, start: M.Timestamp, end: M.Timestamp }),
        )(await request.json());
        return Response.json(
          await Effect.runPromise(
            Activity.Index.pipe(
              Effect.flatMap((index) =>
                index
                  .rank(
                    Model.actor(P.UserId.make("user_alice")),
                    input.accountId,
                    input.start,
                    input.end,
                  )
                  .pipe(Effect.map((result) => result.servers)),
              ),
              Effect.provide(ActivityD1.layer(env.PLATFORM)),
            ),
          ),
        );
      }
      if (url.pathname === "/__control/fail")
        await env.SERVERS.getByName(url.searchParams.get("server") ?? "").failNextAccess();
      if (url.pathname === "/__control/fail-provision")
        await env.SERVERS.getByName(url.searchParams.get("server") ?? "").failNextProvision();
      if (url.pathname === "/__control/apply")
        await env.SERVERS.getByName(url.searchParams.get("server") ?? "").applyAccess(
          Schema.decodeUnknownSync(Model.AccessCommand)(await request.json()),
        );
      if (url.pathname === "/__control/database-down")
        databaseDown = url.searchParams.get("value") === "true";
      if (url.pathname === "/__control/authentication-down")
        authenticationDown = url.searchParams.get("value") === "true";
      if (url.pathname === "/__control/email-sent") return Response.json(EmailFake.outbox());
      if (url.pathname === "/__control/email-fake") {
        const input = Schema.decodeUnknownSync(
          Schema.Struct({
            clear: Schema.optionalKey(Schema.Boolean),
            fail: Schema.optionalKey(Schema.Int),
          }),
        )(await request.json());
        if (input.clear === true) EmailFake.clear();
        if (input.fail !== undefined) EmailFake.failNext(input.fail);
      }
      // Change Worker variables for later requests, as a redeploy with new configuration would.
      if (url.pathname === "/__control/env") {
        Object.assign(
          envOverrides,
          Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
            await request.json(),
          ),
        );
        return Response.json({ ok: true });
      }
      if (url.pathname === "/__control/sync") {
        if (worker.scheduled === undefined) throw new Error("Missing scheduled handler");
        await worker.scheduled({ cron: "* * * * *", scheduledTime: 0, noRetry() {} }, env, ctx);
      }
      return Response.json({ ok: true });
    }
    if (worker.fetch === undefined) throw new Error("Missing HTTP handler");
    const platform = databaseDown
      ? new Proxy(env.PLATFORM, {
          get() {
            throw new Error("D1 unavailable");
          },
        })
      : env.PLATFORM;
    return worker.fetch(
      request,
      { ...env, ...envOverrides, PLATFORM: platform, SERVERS: recordLookups(env.SERVERS) },
      ctx,
    );
  },
} satisfies ExportedHandler<TestEnv>;
