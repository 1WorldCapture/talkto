import * as Sentry from "@sentry/react";
import type { RootOptions } from "react-dom/client";
import { Schema } from "effect";
import { isApiRequest, RequestDiagnostic, RequestTrace } from "./api.js";
import { sample } from "@talkto/telemetry/sampling";
import {
  dataCollection,
  routeName,
  sanitizeError,
  sanitizeSpan,
  sanitizeTransaction,
} from "@talkto/telemetry/privacy";

/** Initialize once at browser bootstrap. Local previews remain disconnected unless explicitly configured. */
export function initialize(transport?: Sentry.BrowserOptions["transport"], localTraceRate?: 0 | 1) {
  const config = Schema.decodeUnknownOption(
    Schema.Struct({
      VITE_SENTRY_DSN: Schema.String.check(Schema.isPattern(/^https:\/\/[^/]+@[^/]+\/\d+$/)),
      MODE: Schema.String,
    }),
  )(
    transport
      ? { ...import.meta.env, VITE_SENTRY_DSN: "https://test@sentry.test/1" }
      : import.meta.env,
  );
  if (config._tag === "None") return;
  const options: Sentry.BrowserOptions = {
    dsn: config.value.VITE_SENTRY_DSN,
    environment: config.value.MODE,
    release: __TALKTO_WEB_RELEASE__,
    tracesSampler: sample,
    sampleRate: 1,
    sendDefaultPii: false,
    dataCollection,
    maxBreadcrumbs: 0,
    enableLogs: false,
    integrations: [
      Sentry.browserTracingIntegration({
        enableInp: false,
        enableLongTask: false,
        shouldCreateSpanForRequest: (url) => !isApiRequest(url),
        beforeStartSpan: (span) => ({ ...span, name: routeName(span.name ?? location.pathname) }),
      }),
    ],
    tracePropagationTargets: [
      new RegExp(`^${location.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/(v1|auth)(/|$)`),
    ],
    beforeSend: sanitizeError,
    beforeSendSpan: sanitizeSpan,
    beforeSendTransaction: sanitizeTransaction,
  };
  if (transport) {
    options.transport = transport;
    if (localTraceRate !== undefined)
      options.tracesSampler = (context) =>
        context.parentSampled !== undefined ? Number(context.parentSampled) : localTraceRate;
  }
  Sentry.init(options);
}

const reportReactError: NonNullable<RootOptions["onUncaughtError"]> = (error, info) => {
  Sentry.reactErrorHandler()(error, { componentStack: info.componentStack ?? null });
};

/** Adapt React's optional stack field at the SDK boundary without weakening root types. */
export const reactErrors = {
  onUncaughtError: reportReactError,
  onCaughtError: reportReactError,
  onRecoverableError: reportReactError,
};

/** Identify startup failures without presenting a module-load rejection as an API outage. */
export function bootstrapFailure(error: Error, stage: "module_load" | "mount") {
  Sentry.captureException(error, {
    tags: { "talkto.operation": "app.bootstrap", "talkto.stage": stage },
  });
}

interface RequestTags {
  "talkto.operation": "api.request";
  "talkto.code"?: string;
  "talkto.request_id"?: string;
  "talkto.failure_kind"?: string;
  "talkto.http_method"?: string;
  "talkto.http_status"?: string;
  "talkto.route"?: string;
  "talkto.query"?: string;
}

const workspaceQueries = Schema.Literals([
  "account",
  "home",
  "servers",
  "members",
  "invitations",
  "grant-members",
  "starter",
]);
const serverQueries = Schema.Literals([
  "feed",
  "summary",
  "agents",
  "channels",
  "direct-chats",
  "conversation",
  "management",
  "grants",
]);

function queryName(key: ReadonlyArray<unknown>): string {
  if (key[0] === "session") return "session";
  if (key[0] !== "human") return "unknown";
  if (key[2] === "accounts") return "workspaces";
  if (Schema.is(workspaceQueries)(key[3])) return `workspace.${key[3]}`;
  if (Schema.is(serverQueries)(key[4]))
    return `${key[3] === "aggregate" ? "workspace" : "server"}.${key[4]}`;
  return "unknown";
}

/** Report final Query failures only, excluding validation, permission responses and canceled reads. */
export function requestFailure(error: Error, queryKey?: ReadonlyArray<unknown>) {
  if (error.name === "AbortError" || error.name === "CancelledError") return;
  const metadata = Schema.decodeUnknownOption(
    Schema.Struct({
      code: Schema.String,
      requestId: Schema.NullOr(Schema.String),
      diagnostic: Schema.optional(Schema.NullOr(RequestDiagnostic)),
      trace: Schema.optional(Schema.NullOr(RequestTrace)),
    }),
  )(error);
  const tags: RequestTags = { "talkto.operation": "api.request" };
  if (queryKey) tags["talkto.query"] = queryName(queryKey);
  if (metadata._tag === "Some") {
    if (
      ![
        "connection_unavailable",
        "storage_unavailable",
        "identity_unavailable",
        "internal_error",
        "configuration_unavailable",
        "billing_unavailable",
        "sending_unavailable",
      ].includes(metadata.value.code)
    )
      return;
    tags["talkto.code"] = metadata.value.code;
    if (metadata.value.requestId) tags["talkto.request_id"] = metadata.value.requestId;
    const diagnostic = metadata.value.diagnostic;
    if (diagnostic) {
      tags["talkto.failure_kind"] = diagnostic.kind;
      if (diagnostic.method) tags["talkto.http_method"] = diagnostic.method;
      if (diagnostic.status !== null) tags["talkto.http_status"] = String(diagnostic.status);
      if (diagnostic.route) tags["talkto.route"] = routeName(diagnostic.route);
    }
  }
  const trace = metadata._tag === "Some" ? metadata.value.trace : null;
  const context: Sentry.CaptureContext = { tags: { ...tags } };
  if (trace) context.contexts = { trace };
  Sentry.captureException(error, context);
}
