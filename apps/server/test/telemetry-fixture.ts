import * as Sentry from "@sentry/cloudflare";
import * as Telemetry from "../src/telemetry.js";
import { Cause, Effect, Exit, Schema } from "effect";
import { run } from "@talkto/telemetry/effect";
import * as Sqlite from "../src/storage/sqlite.js";
import * as Signal from "../src/update-signal.js";
import { Persistence } from "../src/persistence.js";
import { StorageUnavailable } from "@talkto/api/errors";
import { classify, sample } from "@talkto/telemetry/sampling";
import worker, { PlatformTestServer as Server } from "./platform-fixture.js";
import { TestQuota as Quota } from "./metering-fixture.js";

/** This entry point only accepts the in-process collector, regardless of ambient DSNs. */
function options(env: Env): Sentry.CloudflareOptions {
  const rate = Schema.decodeUnknownOption(
    Schema.Struct({ TEST_TRACE_RATE: Schema.Literals(["0", "1", "policy"]) }),
  )(env);
  const localEnv = { ...env, SENTRY_DSN: "https://test@sentry.test/1", SENTRY_ENVIRONMENT: "test" };
  return {
    ...Telemetry.options(localEnv),
    tracesSampler: (context) => {
      if (context.parentSampled !== undefined || classify(context) !== "routine")
        return sample(context);
      return rate._tag === "Some" && rate.value.TEST_TRACE_RATE !== "policy"
        ? Number(rate.value.TEST_TRACE_RATE)
        : sample(context);
    },
  };
}

/** The get_updates step a server object fails at, set by `/__telemetry/server-fault`. */
const ServerFault = Schema.Literals(["invoke", "watch", "first_read", "reset"]);
const serverFaultKey = "telemetry-server-fault";
class Unserializable {}

class TelemetryTestServer extends Server {
  private async fault(step: typeof ServerFault.Type) {
    return (await this.ctx.storage.get(serverFaultKey)) === step;
  }
  override async invokeAgent(
    ...args: Parameters<Server["invokeAgent"]>
  ): ReturnType<Server["invokeAgent"]> {
    const reply = await super.invokeAgent(...args);
    // A reply RPC cannot serialize fails in the runtime, after this method returned.
    if (await this.fault("invoke")) return Object.assign(new Unserializable(), reply);
    return reply;
  }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__telemetry/server-fault") {
      const step = Schema.decodeUnknownOption(ServerFault)(
        new URL(request.url).searchParams.get("step"),
      );
      if (step._tag === "Some") await this.ctx.storage.put(serverFaultKey, step.value);
      else await this.ctx.storage.delete(serverFaultKey);
      return Response.json({ step: step._tag === "Some" ? step.value : null });
    }
    // The runtime resets this object while the watch is opening, as a failed Durable Object does.
    if (path === Signal.watchPath && (await this.fault("watch")))
      return new Promise<Response>(() => {
        setTimeout(() => this.ctx.abort("PRIVATE_WATCH_FAILURE"), 0);
      });
    // The watch opens, then the runtime resets this object once while the Worker holds the call.
    if (path === Signal.watchPath && (await this.fault("reset"))) {
      await this.ctx.storage.delete(serverFaultKey);
      const opened = await super.fetch(request);
      setTimeout(() => this.ctx.abort("PRIVATE_RESET"), 200);
      return opened;
    }
    // The first read answered at once, but its body fails while the Worker reads it.
    if (path === Signal.watchPath && (await this.fault("first_read")))
      return new Response(
        new ReadableStream({
          pull: (controller) => controller.error(new Error("PRIVATE_FIRST_READ_FAILURE")),
        }),
        { headers: { [Signal.answeredHeader]: "1" } },
      );
    if (path === "/__telemetry/sqlite-result")
      return Response.json(await this.ctx.storage.get("telemetry-sqlite-result"));
    if (path === "/__telemetry/sqlite-error") {
      const storage = this.ctx.storage;
      storage.sql.exec("CREATE TABLE IF NOT EXISTS telemetry_rollback (value INTEGER UNIQUE)");
      const mode = new URL(request.url).searchParams.get("mode");
      const fault = new Error(mode === "busy" ? "SQLITE_BUSY PRIVATE_STORAGE" : "PRIVATE_STORAGE");
      // Cloudflare marks a transient storage error `retryable` without a recognizable message.
      if (mode === "retryable") Object.assign(fault, { retryable: true });
      const injected = new Proxy(storage, {
        get(target, property) {
          if (property === "transactionSync")
            return <A>(body: () => A): A =>
              target.transactionSync(() => {
                const value = body();
                if (mode === "success") return value;
                throw fault;
              });
          if (property === "sql") return target.sql;
          throw new Error("Unexpected SQLite fixture storage operation");
        },
      });
      const domain = new StorageUnavailable({
        operation: "fixtureDomain",
        message: "PRIVATE_DOMAIN",
      });
      const outcome = await run(
        Effect.gen(function* () {
          const store = yield* Persistence;
          return yield* store.transaction("fixtureTransaction", () =>
            Effect.gen(function* () {
              storage.sql.exec("INSERT INTO telemetry_rollback VALUES(1)");
              if (mode === "domain") return yield* domain;
              if (mode === "callback") return yield* Effect.die(fault);
              if (mode === "constraint")
                storage.sql.exec("INSERT INTO telemetry_rollback VALUES(1)");
            }),
          );
        }).pipe(Effect.provide(Sqlite.layer(injected)), Effect.exit),
      );
      const defect = Exit.isFailure(outcome) ? Cause.findDefect(outcome.cause) : undefined;
      const failure = Exit.isFailure(outcome) ? Cause.findError(outcome.cause) : undefined;
      await storage.put("telemetry-sqlite-result", {
        rows: storage.sql.exec("SELECT * FROM telemetry_rollback").toArray().length,
        sameDefect: defect?._tag === "Success" && defect.success === fault,
        sameDomainFailure: failure?._tag === "Success" && failure.success === domain,
        failure: failure?._tag === "Success" ? failure.success : null,
      });
      if (defect?._tag === "Success") throw defect.success;
      return Response.json({ ok: true });
    }
    if (path === "/__telemetry/inheritance") {
      const server = traceContext();
      const quota = await this.env.QUOTAS.getByName("telemetry-inheritance").read();
      const evidence = Schema.decodeUnknownSync(
        Schema.Struct({
          telemetry: Schema.Struct({ sampled: Schema.Boolean, traceId: Schema.String }),
        }),
      )(quota);
      return Response.json({ server, quota: evidence.telemetry });
    }
    if (path === "/__telemetry/alarm") {
      await this.ctx.storage.put("telemetry-alarm", true);
      await this.ctx.storage.setAlarm(Date.now());
      return Response.json({ scheduled: true });
    }
    if (path === "/__telemetry/error") {
      Sentry.setTag("talkto.stage", "fixture.durable_object");
      throw new Error("PRIVATE_DO_FAILURE");
    }
    // The shape Cloudflare gives a Durable Object that hit its CPU limit, with a private suffix.
    if (path === "/__telemetry/cpu-limit") {
      Sentry.setTag("talkto.stage", "fixture.cpu_limit");
      throw Object.assign(
        new Error(
          "Durable Object's isolate exceeded its CPU time limit and was reset. PRIVATE_CPU",
        ),
        { retryable: false },
      );
    }
    return super.fetch(request);
  }
  override async alarm() {
    if (await this.ctx.storage.get("telemetry-alarm")) {
      await this.ctx.storage.delete("telemetry-alarm");
      Sentry.setTag("talkto.stage", "fixture.alarm");
      throw new Error("PRIVATE_ALARM_FAILURE");
    }
    await super.alarm();
  }
}

function traceContext() {
  const span = Sentry.getActiveSpan();
  return { sampled: span?.isRecording() ?? false, traceId: span?.spanContext().traceId ?? "" };
}

class TelemetryTestQuota extends Quota {
  override async read() {
    const telemetry = traceContext();
    return { ...(await super.read()), telemetry };
  }
}

/** Exercise the production wrappers with the existing real service/SQLite test fixture. */
export const PlatformTestServer = Sentry.instrumentDurableObjectWithSentry(
  options,
  TelemetryTestServer,
);

/** The provider fixture retains its own extra configuration at this test-only entry point. */
export default Sentry.withSentry(
  (env: Parameters<typeof worker.fetch>[1]) => options(env),
  Telemetry.monitored<Parameters<typeof worker.fetch>[1]>({
    ...worker,
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/__telemetry/")) {
        const server = url.searchParams.get("server");
        if (server) {
          // The SQLite probe isolates the real DO capture boundary from a second RPC caller capture.
          if (url.pathname === "/__telemetry/sqlite-error")
            return env.SERVERS.getByName(server)
              .fetch(request)
              .catch(() => new Response(null, { status: 500 }));
          return env.SERVERS.getByName(server).fetch(request);
        }
        if (url.pathname === "/__telemetry/runtime-flags") {
          // Cloudflare's runtime flags are each a tag; failure_kind still names one of them.
          const runtime = Object.assign(new Error("PRIVATE_RUNTIME_FAILURE"), {
            retryable: true,
            overloaded: true,
            remote: false,
          });
          Telemetry.failure("internal_error", "fixture-flags", runtime, "mcp");
          // A store's safe failure reports the flags of the provider error kept behind it.
          const kept = Telemetry.withCause(
            new StorageUnavailable({ operation: "fixture.flags", message: "PRIVATE_SAFE" }),
            Object.assign(new Error("PRIVATE_KEPT_FAILURE"), { retryable: true }),
          );
          Telemetry.failure("storage_unavailable", "fixture-kept-flags", kept, "access");
          return Response.json({ reported: true });
        }
        if (url.pathname === "/__telemetry/d1-cause") {
          // A store's safe failure names its D1 rejection's class; the rejection never leaves.
          const failure = Telemetry.withCause(
            new StorageUnavailable({
              operation: "fixture.d1",
              message: "Server storage is temporarily unavailable.",
            }),
            new Error("D1_ERROR: Network connection lost. PRIVATE_D1_FAILURE"),
          );
          Telemetry.failure("storage_unavailable", "fixture-d1", failure, "access");
          return Response.json({ reported: true });
        }
        // An identifier-shaped operation on an uncaught error is kept as a tag; its message is not.
        Sentry.setTag("talkto.stage", "fixture.worker");
        throw Object.assign(new Error("PRIVATE_WORKER_FAILURE"), { operation: "fixture.uncaught" });
      }
      const response = await worker.fetch(request, env, ctx);
      const result = new Response(response.body, response);
      result.headers.set(
        "x-test-trace-sampled",
        String(Sentry.getActiveSpan()?.isRecording() ?? false),
      );
      return result;
    },
  }),
);

export const TestQuota = Sentry.instrumentDurableObjectWithSentry(options, TelemetryTestQuota);
