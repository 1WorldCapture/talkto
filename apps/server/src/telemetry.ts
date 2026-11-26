import * as Sentry from "@sentry/cloudflare";
import { Predicate, Schema } from "effect";
import { ProviderFailure } from "./billing/model.js";
import { runtimeFlags, stepOf, type RuntimeFlags, type Step } from "./failure-log.js";
import { sample } from "@talkto/telemetry/sampling";
import {
  dataCollection,
  sanitizeError,
  sanitizeSpan,
  sanitizeTransaction,
} from "@talkto/telemetry/privacy";

declare global {
  /**
   * The deploy's release, `talkto@<commit>`, which `pnpm build:production` substitutes into the
   * Worker bundle and gives the web build too (tools/production-build.mjs). Otherwise undefined.
   */
  var __TALKTO_RELEASE__: string | undefined;
}

const Release = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9@._+-]{1,200}$/));
const Configuration = Schema.Struct({
  SENTRY_DSN: Schema.String.check(Schema.isPattern(/^https:\/\/[^/]+@[^/]+\/\d+$/)),
  SENTRY_ENVIRONMENT: Schema.Literals(["staging", "production", "test", "self-hosted"]),
  CF_VERSION_METADATA: Schema.optional(Schema.Struct({ id: Schema.String })),
});

/** Optional observability never supplies application authority or prevents serving requests. */
export function options(env: Env): Sentry.CloudflareOptions {
  const parsed = Schema.decodeUnknownOption(Configuration)(env);
  const options: Sentry.CloudflareOptions = {
    tracesSampler: sample,
    sampleRate: 1,
    sendDefaultPii: false,
    dataCollection,
    maxBreadcrumbs: 0,
    enableLogs: false,
    enableRpcTracePropagation: true,
    rpcTracePropagationBindings: ["SERVERS", "QUOTAS"],
    beforeSend: (event, hint) => sanitizeError(annotate(event, hint)),
    beforeSendSpan: sanitizeSpan,
    beforeSendTransaction: sanitizeTransaction,
  };
  if (parsed._tag === "None") options.enabled = false;
  else {
    options.dsn = parsed.value.SENTRY_DSN;
    options.environment = parsed.value.SENTRY_ENVIRONMENT;
    const build = Schema.decodeUnknownOption(Release)(globalThis.__TALKTO_RELEASE__);
    const version = parsed.value.CF_VERSION_METADATA?.id;
    // The commit release is shared with the web build; the Cloudflare version stays searchable.
    if (build._tag === "Some") options.release = build.value;
    else if (version !== undefined) options.release = version;
    if (version !== undefined)
      options.initialScope = { tags: { "talkto.cf_version": version.slice(0, 36) } };
  }
  return options;
}

/** Where a reported failure happened: fixed words, never caller data. */
export type Stage =
  | "access"
  | "activity"
  | "billing"
  | "downgrades"
  | "starter"
  | "email"
  | "signins"
  | "share"
  | "guests"
  | "files"
  | "memory"
  | "mcp";

const Operation = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.]{0,100}$/));
const RuntimeFailure = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
  overloaded: Schema.optionalKey(Schema.Boolean),
  remote: Schema.optionalKey(Schema.Boolean),
});
const runtimeKinds: ReadonlyArray<readonly [RegExp, string]> = [
  [/exceeded (?:its )?CPU time limit|CPU time limit exceeded/i, "cpu_limit"],
  [/exceeded (?:its )?memory limit/i, "memory_limit"],
  [/overloaded/i, "overloaded"],
  [/code (?:was|has been) updated/i, "code_updated"],
  [/storage operation exceeded timeout/i, "storage_timeout"],
  [/network connection lost/i, "connection_lost"],
  [/caused object to be reset|was reset/i, "object_reset"],
  // A query the database refused is a code or migration fault, not a transient outage.
  [/SQLITE_CONSTRAINT|constraint failed/i, "sql_constraint"],
  [/SQLITE_ERROR|no such (?:table|column)|syntax error/i, "sql_error"],
];

/** Provider errors behind safe failures; read only to name their failure kind. */
const causes = new WeakMap<Error, Error>();

/**
 * Keep the provider error (a D1 rejection) behind the safe failure a store returns, so `failure`
 * can tag its fixed failure kind. The cause's message and stack never leave the Worker.
 */
export function withCause<E extends Error>(failure: E, cause: unknown): E {
  if (Predicate.isError(cause)) causes.set(failure, cause);
  return failure;
}

/**
 * Name the Cloudflare runtime failure class (CPU or memory limit, an overloaded or reset Durable
 * Object) with a fixed word. The message is read here only; the sanitizer still removes it.
 */
function runtimeKind(error: Error | undefined): string | undefined {
  const runtime = Schema.decodeUnknownOption(RuntimeFailure)(error);
  if (runtime._tag === "None") return undefined;
  const { message = "", overloaded, retryable, remote } = runtime.value;
  for (const [pattern, kind] of runtimeKinds) if (pattern.test(message)) return kind;
  if (overloaded === true) return "overloaded";
  if (retryable === true) return "retryable";
  if (remote === true) return "remote";
  if (/^D1_/.test(message)) return "d1";
  return undefined;
}

/**
 * The fixed failure class of a provider rejection, for a store's safe failure to carry as its
 * own `failureKind`. Never the rejection's message.
 */
export function rejectionKind(cause: unknown): string | undefined {
  return Predicate.isError(cause) ? runtimeKind(cause) : undefined;
}

/** A failure class a safe failure carries itself: one fixed lower-case word. */
const CarriedKind = Schema.Struct({
  failureKind: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,40}$/)),
});

/**
 * An error and the errors kept behind it with `withCause`, nearest first: a public failure, the
 * store's safe failure behind it, and the provider rejection behind that.
 */
function chain(error: Error | undefined): ReadonlyArray<Error> {
  const links: Array<Error> = [];
  for (let link = error; link !== undefined && links.length < 3; link = causes.get(link))
    links.push(link);
  return links;
}

/** The nearest failure class along an error's chain: one carried, or named from the runtime's. */
function failureKind(error: Error | undefined): string | undefined {
  for (const link of chain(error)) {
    const carried = Schema.decodeUnknownOption(CarriedKind)(link);
    const kind = carried._tag === "Some" ? carried.value.failureKind : runtimeKind(link);
    if (kind !== undefined) return kind;
  }
  return undefined;
}

/** Cloudflare's runtime flags, each its own tag, and the server-object call step that failed. */
interface RuntimeTags {
  "talkto.cf_retryable"?: "true" | "false";
  "talkto.cf_overloaded"?: "true" | "false";
  "talkto.cf_remote"?: "true" | "false";
  "talkto.step"?: Step;
}
const runtimeTagNames = [
  "talkto.cf_retryable",
  "talkto.cf_overloaded",
  "talkto.cf_remote",
  "talkto.step",
] as const;
const flagTag = (value: boolean) => (value ? "true" : "false");

/**
 * The flags Cloudflare set on an error, or on the errors kept behind it with `withCause` (the
 * nearest wins), which `failure_kind` reports only one of, and the step `atStep` recorded.
 * Booleans and fixed words only, never the message.
 */
function runtimeTags(error: Error | undefined): RuntimeTags {
  const tags: RuntimeTags = {};
  if (error === undefined) return tags;
  const { retryable, overloaded, remote } = chain(error).reduceRight<RuntimeFlags>(
    (flags, link) => ({ ...flags, ...runtimeFlags(link) }),
    {},
  );
  if (retryable !== undefined) tags["talkto.cf_retryable"] = flagTag(retryable);
  if (overloaded !== undefined) tags["talkto.cf_overloaded"] = flagTag(overloaded);
  if (remote !== undefined) tags["talkto.cf_remote"] = flagTag(remote);
  const step = stepOf(error);
  if (step !== null) tags["talkto.step"] = step;
  return tags;
}

/**
 * Give every exception the SDK captures on its own (Durable Object fetch, RPC and alarm handlers,
 * the cron) the same safe tags `failure` sets: the failing operation, the runtime failure class,
 * Cloudflare's runtime flags and the failed step.
 */
function annotate(event: Sentry.ErrorEvent, hint: Sentry.EventHint): Sentry.ErrorEvent {
  const tags = { ...event.tags };
  const operation = Schema.decodeUnknownOption(Schema.Struct({ operation: Operation }))(
    hint.originalException,
  );
  if (tags["talkto.operation"] === undefined && operation._tag === "Some")
    tags["talkto.operation"] = operation.value.operation;
  const error = Predicate.isError(hint.originalException) ? hint.originalException : undefined;
  const kind = failureKind(error);
  if (tags["talkto.failure_kind"] === undefined && kind !== undefined)
    tags["talkto.failure_kind"] = kind;
  const runtime = runtimeTags(error);
  for (const name of runtimeTagNames) {
    const value = runtime[name];
    if (tags[name] === undefined && value !== undefined) tags[name] = value;
  }
  event.tags = tags;
  return event;
}

/** Sentry Cron Monitor slug for the Worker's minute cron. */
export const cronMonitor = "talkto-cron";

/**
 * Check the scheduled run in and out, so a cron that stops running or hangs alerts even when no
 * stage reports an error. A thrown run checks in as an error and is rethrown unchanged.
 */
export function monitorCron<A>(schedule: string, run: () => Promise<A>): Promise<A> {
  return Sentry.withMonitor(cronMonitor, run, {
    schedule: { type: "crontab", value: schedule },
    // Cloudflare may start a minute trigger late; three minutes absorbs that without paging.
    checkinMargin: 3,
    // Cloudflare ends a scheduled invocation after 15 minutes; a run past 10 is stuck.
    maxRuntime: 10,
    timezone: "Etc/UTC",
    // Stage failures already open their own issues; the monitor speaks for a run that is
    // missing, timed out, or failing three times in a row.
    failureIssueThreshold: 3,
    recoveryThreshold: 2,
  });
}

/** Cloudflare's location code for the data center that ran a request, like `TBS` or `EWR`. */
const Colo = Schema.Struct({ colo: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)) });

/**
 * The Worker with its cron checked in to `cronMonitor`, and every event a request reports tagged
 * `talkto.colo` with the Cloudflare location that ran it, so a failure confined to some locations
 * shows where. A location code is public infrastructure, not personal data.
 */
export function monitored<E>(handler: ExportedHandler<E>): ExportedHandler<E> {
  const { fetch, scheduled } = handler;
  const wrapped: ExportedHandler<E> = { ...handler };
  if (fetch !== undefined)
    wrapped.fetch = (request, env, context) => {
      const location = Schema.decodeUnknownOption(Colo)(request.cf);
      if (location._tag === "Some")
        Sentry.getIsolationScope().setTag("talkto.colo", location.value.colo);
      return fetch.call(handler, request, env, context);
    };
  if (scheduled !== undefined)
    wrapped.scheduled = (controller, env, context) =>
      monitorCron(controller.cron, async () => scheduled.call(handler, controller, env, context));
  return wrapped;
}

interface FailureTags extends RuntimeTags {
  readonly "talkto.code": string;
  readonly "talkto.request_id": string;
  "talkto.operation"?: string;
  "talkto.stage"?: Stage;
  "talkto.failure_kind"?: string;
  "talkto.provider_type"?: string;
  "talkto.provider_status"?: string;
  "talkto.provider_code"?: string;
  "talkto.provider_request_id"?: string;
  "talkto.recovery_operation"?: string;
  "talkto.recovery_type"?: string;
  "talkto.recovery_status"?: string;
  "talkto.recovery_request_id"?: string;
}

/** Retain the failing transaction operation; the DO wrapper deduplicates this same Error instance. */
export function storageDefect(operation: string, error: Error): void {
  const safeOperation = Schema.decodeUnknownOption(Operation)(operation);
  if (safeOperation._tag === "None") return;
  Sentry.captureException(error, {
    tags: { "talkto.code": "internal_error", "talkto.operation": safeOperation.value },
  });
}

/**
 * Report safe infrastructure failures that HTTP/MCP deliberately translate into ordinary responses.
 * `warning` is for expected outcomes worth seeing that must not page (email delivery).
 * `operation` names the boundary when the error carries no operation of its own (an MCP tool).
 */
export function failure(
  code: string,
  requestId: string,
  error?: Error,
  stage?: Stage,
  level: "error" | "warning" = "error",
  operation?: string,
) {
  if (
    ![
      "internal_error",
      "storage_unavailable",
      "identity_unavailable",
      "configuration_unavailable",
      "billing_unavailable",
      "sending_unavailable",
      "files_unavailable",
      "memory_unavailable",
      "email_unavailable",
    ].includes(code)
  )
    return;
  const carried = Schema.decodeUnknownOption(Schema.Struct({ operation: Operation }))(error);
  const named = Schema.decodeUnknownOption(Operation)(operation);
  const tags: FailureTags = {
    "talkto.code": code,
    "talkto.request_id": requestId,
    ...runtimeTags(error),
  };
  if (stage !== undefined) tags["talkto.stage"] = stage;
  if (carried._tag === "Some") tags["talkto.operation"] = carried.value.operation;
  else if (named._tag === "Some") tags["talkto.operation"] = named.value;
  const kind = failureKind(error);
  if (kind !== undefined) tags["talkto.failure_kind"] = kind;
  // A non-Stripe provider's HTTP status (email delivery's Resend calls).
  const httpStatus = Schema.decodeUnknownOption(
    Schema.Struct({
      httpStatus: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
    }),
  )(error);
  if (httpStatus._tag === "Some")
    tags["talkto.provider_status"] = String(httpStatus.value.httpStatus);
  const diagnostic = Schema.decodeUnknownOption(
    Schema.Struct({
      provider: Schema.optionalKey(ProviderFailure),
      recovery: Schema.optionalKey(
        Schema.Struct({
          operation: Operation,
          provider: Schema.optionalKey(ProviderFailure),
        }),
      ),
    }),
  )(error);
  if (diagnostic._tag === "Some") {
    const { provider, recovery } = diagnostic.value;
    if (provider !== undefined) {
      tags["talkto.provider_type"] = provider.type;
      if (provider.status !== null) tags["talkto.provider_status"] = String(provider.status);
      if (provider.code !== null) tags["talkto.provider_code"] = provider.code;
      if (provider.requestId !== null) tags["talkto.provider_request_id"] = provider.requestId;
    }
    if (recovery !== undefined) {
      tags["talkto.recovery_operation"] = recovery.operation;
      if (recovery.provider !== undefined) {
        tags["talkto.recovery_type"] = recovery.provider.type;
        if (recovery.provider.status !== null)
          tags["talkto.recovery_status"] = String(recovery.provider.status);
        if (recovery.provider.requestId !== null)
          tags["talkto.recovery_request_id"] = recovery.provider.requestId;
      }
    }
  }
  Sentry.captureException(error ?? new Error(`TalkTo ${code}`), { level, tags: { ...tags } });
}

/**
 * A server's SQLite database stops accepting writes at 10 GB and its history cannot be deleted,
 * so a server object reports the largest threshold its database has crossed. Decimal gigabytes
 * keep the alert ahead of the limit whichever unit Cloudflare means.
 */
export const storageThresholds = [
  { bytes: 8_000_000_000, label: "8GB", level: "error" },
  { bytes: 5_000_000_000, label: "5GB", level: "warning" },
] as const;
/** One entry of `storageThresholds`. */
export type StorageThreshold = (typeof storageThresholds)[number];

/** The largest threshold a database of `bytes` has crossed, or null below every threshold. */
export function storageThreshold(bytes: number): StorageThreshold | null {
  return storageThresholds.find((threshold) => bytes >= threshold.bytes) ?? null;
}

/** Thrown nowhere: names the Sentry issue for a server database nearing its size limit. */
class ServerStorageSize extends Error {
  override readonly name = "ServerStorageSize";
}

/**
 * Report one server database past a size threshold: a warning at 5 GB, an error at 8 GB, one
 * issue per threshold. Tags carry the threshold and the size in tenths of a gigabyte, never the
 * server's ID; the server object logs that alongside.
 */
export function storageSize(threshold: StorageThreshold, bytes: number) {
  Sentry.captureException(new ServerStorageSize(`Server database past ${threshold.label}`), {
    level: threshold.level,
    fingerprint: ["talkto-server-storage-size", threshold.label],
    tags: {
      "talkto.code": "storage_size",
      "talkto.operation": "ServerStorage.size",
      "talkto.storage_threshold": threshold.label,
      "talkto.storage_gb": (bytes / 1_000_000_000).toFixed(1),
    },
  });
}

/** Thrown nowhere: names the Sentry issue for a reader stuck at one get_updates checkpoint. */
class StuckReader extends Error {
  override readonly name = "StuckReader";
}

/**
 * Report a reader that keeps asking get_updates from one checkpoint while messages wait: its
 * plugin or client cannot take the page, so its agent receives nothing. Tags carry the plugin the
 * calls named and the count, never the server's or participant's ID; the server object logs those.
 */
export function stuckReader(plugin: string | null, polls: number) {
  Sentry.captureException(new StuckReader("A reader keeps asking from one checkpoint"), {
    level: "warning",
    fingerprint: ["talkto-stuck-reader"],
    tags: {
      "talkto.code": "stuck_reader",
      "talkto.operation": "TalkTo.getUpdates",
      // "claude-code 0.2.0": Sentry tags keep no slash.
      "talkto.plugin": plugin === null ? "none" : plugin.replace("/", " "),
      "talkto.polls": String(polls),
    },
  });
}

/** Thrown nowhere: names the Sentry issue for a memory store call that failed. */
class MemoryStoreFailed extends Error {
  override readonly name = "MemoryStoreFailed";
}
const StoreTag = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.: -]{1,120}$/));
const storeTag = (value: string | number | undefined | null) =>
  value === undefined || value === null
    ? "none"
    : Schema.is(StoreTag)(String(value))
      ? String(value)
      : "unsafe";

/**
 * Report one failed call to the memory store (Cloudflare Artifacts) with the step that made it
 * ("seed push", "read file"), the store's operation, and the provider's code, HTTP status and
 * message as memory/model.ts `safeDetail` cut them: never a token, a URL or a repository name.
 */
export function memoryStore(
  step: string,
  failure: {
    readonly operation: string;
    readonly code?: string | null;
    readonly status?: number;
    readonly detail?: string;
  },
) {
  Sentry.captureException(new MemoryStoreFailed("A memory store call failed"), {
    level: "error",
    fingerprint: ["talkto-memory-store", storeTag(step), storeTag(failure.operation)],
    tags: {
      "talkto.code": "memory_store_failed",
      "talkto.operation": `memory.${storeTag(failure.operation)}`,
      "talkto.memory_step": storeTag(step),
      "talkto.provider_code": storeTag(failure.code),
      "talkto.provider_status": storeTag(failure.status),
      "talkto.provider_message": storeTag(failure.detail),
    },
  });
}

/** Thrown nowhere: names the Sentry issue for a get_updates watch that failed to open. */
class WatchFallback extends Error {
  override readonly name = "WatchFallback";
}

/**
 * Report a waiting get_updates whose watch failed to open, so the call polled instead of failing.
 * A warning: the caller still got its answer. Tags carry the runtime flags and step only.
 */
export function watchFallback(cause: unknown) {
  const error = new WatchFallback("A get_updates watch failed to open");
  Sentry.captureException(error, {
    level: "warning",
    fingerprint: ["talkto-watch-fallback"],
    tags: {
      "talkto.code": "watch_fallback",
      "talkto.operation": "TalkTo.getUpdates",
      ...runtimeTags(Predicate.isError(cause) ? cause : undefined),
      "talkto.step": "watch",
    },
  });
}

/** Thrown nowhere: names the Sentry issue for a read that failed transiently twice. */
class ReadUnavailable extends Error {
  override readonly name = "ReadUnavailable";
}

/**
 * Report a read whose server-object call failed transiently twice (read-retry.ts). A warning: the
 * agent was told to call again, and nothing was lost. Tags carry the tool and runtime flags only.
 */
export function readUnavailable(cause: unknown, tool: string) {
  Sentry.captureException(new ReadUnavailable("A read failed transiently twice"), {
    level: "warning",
    fingerprint: ["talkto-read-unavailable"],
    tags: {
      "talkto.code": "storage_unavailable",
      "talkto.operation": `mcp.${tool}`,
      ...runtimeTags(Predicate.isError(cause) ? cause : undefined),
      "talkto.step": "invoke",
    },
  });
}

/** Thrown nowhere: names the Sentry issue for an agent operation acting as another person's agent. */
class AgentNotOwned extends Error {
  override readonly name = "AgentNotOwned";
}

/**
 * Report, in watch mode, an agent operation that acted as an agent another person's access
 * registered: enforce mode refuses it. A warning, since the call went ahead. Tags carry the
 * operation only, never a participant, person, server or message; the caller limits repeats.
 */
export function agentNotOwned(operation: string) {
  Sentry.captureException(new AgentNotOwned("An agent operation acted as another person's agent"), {
    level: "warning",
    fingerprint: ["talkto-agent-not-owned"],
    tags: {
      "talkto.code": "agent_not_owned",
      "talkto.operation": Schema.is(Operation)(operation) ? operation : "unknown",
    },
  });
}

/** What failed in the MCP adapter itself: a thrown invocation or a reply that broke its contract. */
export interface ToolFault {
  readonly cause: unknown;
}

/** Codes `Responses.projectFailure` reports where they happen, or deliberately does not. */
const applicationReported = new Set([
  "storage_unavailable",
  "files_unavailable",
  "memory_unavailable",
  "sending_unavailable",
]);

/**
 * Report an MCP tool or events failure once, tagged `mcp.<tool>`. A failure the application
 * already reported, or chose not to (a pending allocation, an absent file store), is not repeated;
 * a thrown cause or a broken reply contract always is.
 */
export function toolFailure(code: string, requestId: string, tool: string, fault?: ToolFault) {
  if (fault === undefined && applicationReported.has(code)) return;
  failure(
    code,
    requestId,
    Predicate.isError(fault?.cause) ? fault.cause : undefined,
    "mcp",
    "error",
    `mcp.${tool}`,
  );
}
