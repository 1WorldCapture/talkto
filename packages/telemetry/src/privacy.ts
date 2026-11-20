import type { DataCollection, ErrorEvent, SpanJSON, TransactionEvent } from "@sentry/core";
import { Schema } from "effect";

const SafeText = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.: -]{1,120}$/));
const SafeAttribute = Schema.Union([SafeText, Schema.Number, Schema.Boolean]);

/** Disable sensitive collection before capture, with export scrubbing as a second boundary. */
export const dataCollection: DataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: false, response: false },
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  stackFrameVariables: false,
  genAI: { inputs: false, outputs: false },
};

const segments = new Set([
  "v1",
  "app",
  "auth",
  "login",
  "logout",
  "callback",
  "me",
  "accounts",
  "servers",
  "access",
  "candidates",
  "members",
  "invitations",
  "resend",
  "cancel",
  "resume",
  "delete",
  "dashboard",
  "activity",
  "summary",
  "onboarding",
  "progress",
  "feed",
  "participants",
  "wakes",
  "channels",
  "conversations",
  "messages",
  "direct",
  "home",
  "agents",
  "connect",
  "health",
  "mcp",
  "instructions",
  "openapi.json",
  ".well-known",
  "oauth-protected-resource",
  "webhooks",
  "workos",
  "stripe",
  "billing",
  "checkout",
  "portal",
  "renewal",
  "trial",
  "convert",
  "confirm",
  "keep",
  "plan",
  "context",
  "deletion",
  "direct-chats",
  "email",
  "unsubscribe",
  "files",
  "offers",
  "starter",
  "people",
  "rename",
  "renames",
  "search",
  "senders",
  "shares",
  "transfers",
  "download",
  "signals",
  "updates",
  "wake-cadence",
  "stripe-selfhost",
  "feedback",
  "shared",
  "join",
  "accept",
]);

/** Keep route structure; omit query strings, fragments, identifiers and arbitrary path text. */
export function routeName(value: string): string {
  try {
    return new URL(value, "https://talkto.invalid").pathname
      .split("/")
      .map((part) => (part === "" || segments.has(part) ? part : ":id"))
      .join("/");
  } catch {
    return "/unknown";
  }
}

const safeAttributes = new Set([
  "sentry.op",
  "sentry.origin",
  "sentry.source",
  "sentry.sample_rate",
  "http.request.method",
  "http.response.status_code",
  "http.status_code",
  "db.system",
  "db.system.name",
  "db.operation",
  "db.operation.name",
  "db.rows_returned",
  "db.rows_affected",
  "talkto.outcome",
  "talkto.code",
  "talkto.request_id",
  "talkto.failure_kind",
  "talkto.stage",
  "talkto.selected",
  "talkto.succeeded",
  "talkto.failed",
  "talkto.busy",
  "talkto.unobserved",
  "talkto.selected_oldest_check_age_ms",
  "talkto.selected_oldest_attempt_age_ms",
]);

/** Durable Object RPC methods (TalkToServer, WorkspaceQuota) and handlers, kept as span names. */
const internalOperations = new Set([
  "provision",
  "erase",
  "unreportedUsage",
  "reportUsage",
  "applyAccess",
  "forgetPerson",
  "fileRepository",
  "projectActivity",
  "readActivity",
  "searchActivity",
  "readSummary",
  "readOnboarding",
  "checkSignal",
  "invokeEvents",
  "invokeAgent",
  "reserveStorage",
  "releaseStorage",
  "publishStoragePlan",
  "readStorage",
  "publish",
  "allocate",
  "close",
  "starter",
  "read",
  "alarm",
]);

function operationName(value: string): string {
  if (internalOperations.has(value)) return value;
  if (/^Scheduled Cron /.test(value)) return "scheduled";
  return routeName(value);
}

function sanitizeAttributes(data: NonNullable<SpanJSON["data"]>) {
  const safe: Record<string, typeof SafeAttribute.Type> = {};
  for (const [key, value] of Object.entries(data))
    if (safeAttributes.has(key) && Schema.is(SafeAttribute)(value)) safe[key] = value;
  return safe;
}

/** Export timings and known diagnostic fields, never SQL text, bindings, URLs or RPC payloads. */
export function sanitizeSpan(span: SpanJSON): SpanJSON {
  const op = span.op ?? "operation";
  const description = span.description ?? op;
  span.description =
    op.startsWith("http") || op === "pageload" || op === "navigation"
      ? routeName(description.replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /, ""))
      : op.startsWith("db")
        ? "database operation"
        : (op === "rpc" || op === "function") && internalOperations.has(description)
          ? description
          : span.origin?.endsWith(".effect") && /^[A-Za-z][A-Za-z0-9_.]+$/.test(description)
            ? description
            : op;
  span.data = sanitizeAttributes(span.data ?? {});
  return span;
}

function sanitizeEvent<T extends ErrorEvent | TransactionEvent>(event: T): T {
  if (event.request) {
    const request: NonNullable<ErrorEvent["request"]> = {};
    if (event.request.method) request.method = event.request.method;
    if (event.request.url) request.url = routeName(event.request.url);
    event.request = request;
  }
  delete event.user;
  delete event.extra;
  delete event.breadcrumbs;
  delete event.server_name;
  delete event.message;
  delete event.logentry;
  event.contexts = event.contexts?.trace ? { trace: event.contexts.trace } : {};
  if (event.contexts.trace) {
    if (event.contexts.trace.data)
      event.contexts.trace.data = sanitizeAttributes(event.contexts.trace.data);
    delete event.contexts.trace.status_message;
  }
  event.tags = Object.fromEntries(
    Object.entries(event.tags ?? {}).flatMap(([key, value]) => {
      if (key === "talkto.route" && Schema.is(Schema.String)(value))
        return [[key, routeName(value)]];
      return key.startsWith("talkto.") && Schema.is(SafeText)(value) ? [[key, value]] : [];
    }),
  );
  if (event.transaction) event.transaction = operationName(event.transaction);
  return event;
}

/** Preserve exception types and stack locations while excluding runtime values. */
export function sanitizeError(event: ErrorEvent): ErrorEvent {
  sanitizeEvent(event);
  for (const exception of event.exception?.values ?? []) {
    exception.value = "Unexpected application failure";
    if (exception.mechanism) delete exception.mechanism.data;
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
      delete frame.pre_context;
      delete frame.post_context;
      delete frame.context_line;
      if (frame.filename) frame.filename = frame.filename.split(/[?#]/)[0] ?? "";
      if (frame.abs_path) frame.abs_path = frame.abs_path.split(/[?#]/)[0] ?? "";
    }
  }
  return event;
}

/** Apply the same privacy policy to full transactions and individually exported spans. */
export function sanitizeTransaction(event: TransactionEvent): TransactionEvent {
  sanitizeEvent(event);
  if (event.spans) event.spans = event.spans.map(sanitizeSpan);
  return event;
}
