import { DateTime, Effect, Schema } from "effect";
import * as M from "@talkto/api/models";
import { InvalidInput } from "@talkto/api/errors";
import local from "../src/local.js";
import { TalkToServer } from "../src/server-object.js";
import * as Store from "../src/persistence.js";
import * as Sqlite from "../src/storage/sqlite.js";
import * as Configuration from "../src/configuration.js";

const UpdatesSeed = Schema.Struct({
  participantId: M.ParticipantId,
  conversationId: M.ConversationId,
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 })),
});

/** Test-only control surface. This class is never exported by either application entry point. */
export class TestServer extends TalkToServer {
  /** Seed large immutable histories through real SQLite constraints and triggers. */
  async seedUpdates(value: typeof UpdatesSeed.Type) {
    const config = await Effect.runPromise(Configuration.read(this.env));
    const at = DateTime.toEpochMillis(DateTime.nowUnsafe());
    this.ctx.storage.transactionSync(() => {
      for (let index = 0; index < value.count; index++) {
        this.ctx.storage.sql.exec(
          "INSERT INTO messages(id,conversation_id,sender_id,created_by_grant_id,request_key,body,created_at) VALUES(?,?,?,?,?,?,?)",
          crypto.randomUUID(),
          value.conversationId,
          value.participantId,
          config.grantId,
          crypto.randomUUID(),
          "unrelated history",
          at,
        );
      }
    });
    return { ok: true };
  }
  /** Exercise old checkpoint rejection after a storage-generation change. */
  async rotateUpdatesGeneration() {
    this.ctx.storage.sql.exec(
      "UPDATE updates_identity SET generation=lower(hex(randomblob(16))) WHERE singleton=1",
    );
    return { ok: true };
  }
  /** Reopen a version-two database to verify the upgrade path retains history. */
  async beforeUpdatesMigration() {
    this.ctx.storage.sql.exec(
      "DROP TABLE updates_identity; DELETE FROM schema_migrations WHERE version=3",
    );
    return { ok: true };
  }
  /** Emulate a pre-normalization registration for upgrade/retry compatibility checks. */
  async legacyAgentType() {
    this.ctx.storage.sql.exec(
      "UPDATE participants SET agent_type = 'claude_code' WHERE name = 'LegacyIcon'",
    );
    return { ok: true };
  }
  /** Wake every open wait without changing its access, as a grant to someone else does. */
  async recheck() {
    this.watches.recheckAll();
    return { ok: true };
  }
  /** How many waiting calls hold a hibernatable watch on this object right now. */
  async watching() {
    return { open: this.watches.size };
  }
  /** Exercise persisted revocation through the real transaction adapter. */
  async revoke() {
    return Effect.runPromise(
      Effect.gen(
        function* (this: TestServer) {
          const config = yield* Configuration.read(this.env);
          const store = yield* Store.Persistence;
          yield* store.transaction("test.revoke", (tx) =>
            tx.revokeGrant(config.grantId, M.Timestamp.make("2099-01-01T00:00:00.000Z")),
          );
          // Mirror applyAccess: open get_updates waits re-read under the revoked grant.
          this.watches.recheckAll();
        }.bind(this),
      ).pipe(
        Effect.provide(Sqlite.layer(this.ctx.storage)),
        Effect.match({
          onFailure: (error) => ({ ok: false, error: error._tag }),
          onSuccess: () => ({ ok: true }),
        }),
      ),
    );
  }
  /** Force an application failure after an insert to verify transaction rollback of all derived state. */
  async rollback(participantId: string, conversationId: string) {
    return Effect.runPromise(
      Effect.gen(
        function* (this: TestServer) {
          const config = yield* Configuration.read(this.env);
          const senderId = yield* Schema.decodeUnknownEffect(M.ParticipantId)(participantId);
          const target = yield* Schema.decodeUnknownEffect(M.ConversationId)(conversationId);
          const store = yield* Store.Persistence;
          yield* store.transaction("test.rollback", (tx) =>
            Effect.gen(function* () {
              yield* tx.append({
                id: M.MessageId.make(crypto.randomUUID()),
                senderId,
                conversationId: target,
                body: M.MessageBody.make("rollback sentinel"),
                requestKey: M.RequestKey.make("rollback"),
                grantId: config.grantId,
                createdAt: M.Timestamp.make("2099-01-01T00:00:00.000Z"),
              });
              return yield* new InvalidInput({ message: "Deliberate failure after writing" });
            }),
          );
        }.bind(this),
      ).pipe(
        Effect.provide(Sqlite.layer(this.ctx.storage)),
        Effect.match({
          onFailure: (error) => ({ ok: false, error: error._tag }),
          onSuccess: () => ({ ok: true }),
        }),
      ),
    );
  }
}
interface TestEnv extends Env {
  readonly SERVERS: DurableObjectNamespace<TestServer>;
}
/** Local-only test harness, built separately from deployable application bundles. */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__control/")) {
      const config = await Effect.runPromise(Configuration.read(env));
      const server = env.SERVERS.getByName(config.serverId);
      if (url.pathname === "/__control/updates-seed")
        return Response.json(
          await server.seedUpdates(Schema.decodeUnknownSync(UpdatesSeed)(await request.json())),
        );
      if (url.pathname === "/__control/updates-rotate")
        return Response.json(await server.rotateUpdatesGeneration());
      if (url.pathname === "/__control/updates-upgrade")
        return Response.json(await server.beforeUpdatesMigration());
      if (url.pathname === "/__control/legacy-agent-type")
        return Response.json(await server.legacyAgentType());
      if (url.pathname === "/__control/recheck") return Response.json(await server.recheck());
      if (url.pathname === "/__control/watching") return Response.json(await server.watching());
      if (url.pathname === "/__control/revoke") return Response.json(await server.revoke());
      if (url.pathname === "/__control/rollback")
        return Response.json(
          await server.rollback(
            url.searchParams.get("participantId") ?? "",
            url.searchParams.get("conversationId") ?? "",
          ),
        );
    }
    if (local.fetch === undefined) throw new Error("Missing fixture fetch entry point");
    return local.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<TestEnv>;
