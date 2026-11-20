import { Cause, Duration, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";
import * as Sentry from "@sentry/react";
import { HttpApiClient } from "effect/unstable/httpapi";
import { routeName } from "@talkto/telemetry/privacy";
import type { Work } from "@talkto/telemetry/sampling";
import { Api } from "@talkto/api/api";
import * as P from "@talkto/api/platform";
import * as B from "@talkto/api/billing";
import * as O from "@talkto/api/onboarding";
import * as S from "@talkto/api/starter";
import * as A from "@talkto/api/account";
import * as E from "@talkto/api/email";
import * as SignIns from "@talkto/api/sign-ins";
import * as Share from "@talkto/api/share";
import * as Feedback from "@talkto/api/feedback";
import * as Guests from "@talkto/api/guests";
import * as Envelope from "@talkto/api/envelope";
import { takeEarlyResponse } from "./early-requests.js";

/** Allowlisted diagnostics; raw Effect failures may contain URLs, cookies or response bodies. */
export const RequestDiagnostic = Schema.Struct({
  kind: Schema.Literals([
    "TransportError",
    "TimeoutError",
    "StatusCodeError",
    "DecodeError",
    "SchemaError",
    "EncodeError",
    "InvalidUrlError",
    "EmptyBodyError",
    "UnknownError",
  ]),
  method: Schema.NullOr(
    Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"]),
  ),
  route: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
});
/** Safe evidence retained when an API request cannot produce a declared response. */
export interface RequestDiagnostic extends Schema.Schema.Type<typeof RequestDiagnostic> {}

/** Correlate the final Query error with the exact request, without sharing mutable browser scope. */
export const RequestTrace = Schema.Struct({
  trace_id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  span_id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
});

/** Every declared failure: the shared envelope's and those only the guest endpoints answer. */
const KnownFailure = Schema.Union([Envelope.Failure, Guests.Failure]);

/** Safe request failure; raw transport errors can contain private request data. */
export class ApiError extends Error {
  /** Stable public error code. */
  readonly code: Envelope.FailureCode | Guests.Failure["error"]["code"] | "connection_unavailable";
  /** Diagnostic correlation, without payloads. */
  readonly requestId: string | null;
  /** Diagnostics are separate from the public error code and retry policy. */
  readonly diagnostic: RequestDiagnostic | null;
  /** Request span retained after it ends, including across Query retries. */
  readonly trace: typeof RequestTrace.Type | null;
  /** When a refused action may be tried again, if the server said so. */
  readonly retryAt: string | null;
  /** The invited address, masked (`c***@e***.com`), when the signed-in address is another. */
  readonly sentTo: string | null;
  constructor(
    code: ApiError["code"],
    message: string,
    requestId: string | null = null,
    diagnostic: RequestDiagnostic | null = null,
    trace: typeof RequestTrace.Type | null = null,
    retryAt: string | null = null,
    sentTo: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.requestId = requestId;
    this.diagnostic = diagnostic;
    this.trace = trace;
    this.retryAt = retryAt;
    this.sentTo = sentTo;
  }
}

/** Generate both clients from the shared contracts; the browser owns its HttpOnly cookie. */
export function createApi(baseUrl: string) {
  const clients = Effect.runSync(
    Effect.all({
      platform: HttpApiClient.make(P.Api, { baseUrl }),
      server: HttpApiClient.make(Api, { baseUrl }),
      billing: HttpApiClient.make(B.Api, { baseUrl }),
      onboarding: HttpApiClient.make(O.Api, { baseUrl }),
      starter: HttpApiClient.make(S.Api, { baseUrl }),
      account: HttpApiClient.make(A.Api, { baseUrl }),
      email: HttpApiClient.make(E.Api, { baseUrl }),
      signIns: HttpApiClient.make(SignIns.Api, { baseUrl }),
      share: HttpApiClient.make(Share.Api, { baseUrl }),
      feedback: HttpApiClient.make(Feedback.Api, { baseUrl }),
      guests: HttpApiClient.make(Guests.Api, { baseUrl }),
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  return {
    platform: clients.platform.platform,
    server: clients.server.server,
    billing: clients.billing.billing,
    onboarding: clients.onboarding.onboarding,
    starter: clients.starter.starter,
    account: clients.account.account,
    email: clients.email.email,
    signIns: clients.signIns.signIns,
    share: clients.share.share,
    feedback: clients.feedback.feedback,
    guests: clients.guests.guests,
  };
}
/** Client shape comes from the API declaration rather than handwritten DTOs. */
export type Client = ReturnType<typeof createApi>;

/** The shared client owns tracing for same-origin API requests; other fetches keep SDK instrumentation. */
export function isApiRequest(value: string): boolean {
  try {
    const url = new URL(
      value,
      typeof location === "undefined" ? "http://localhost" : location.href,
    );
    return (
      (typeof location === "undefined" || url.origin === location.origin) &&
      /^\/(v1|auth)(\/|$)/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/** Adapt the single Effect boundary to Query; abort reaches the underlying HTTP request. */
export async function request<A, E>(
  operation: Effect.Effect<A, E>,
  signal?: AbortSignal,
  work: Exclude<Work, "health"> = "routine",
  // Most requests answer in well under a second; a step that creates real resources passes more.
  limit: Duration.Input = "15 seconds",
): Promise<A> {
  // An independent span survives page-load completion. Never keep a global active
  // Sentry scope across await: browser requests can overlap and finish out of order.
  // parentSpan:null alone still inherits the page's propagation decision.
  // Reset that context only for synchronous creation, then retain this span explicitly.
  const span = Sentry.startNewTrace(() =>
    Sentry.startInactiveSpan({
      name: "/v1",
      op: "http.client",
      parentSpan: null,
      forceTransaction: true,
      attributes: { "talkto.work": work },
    }),
  );
  const context = span.spanContext();
  const trace = { trace_id: context.traceId, span_id: context.spanId };
  const transport = fetch;
  let observed: Omit<RequestDiagnostic, "kind"> = { method: null, route: null, status: null };
  const tracedFetch: typeof fetch = (input, options) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = options?.method ?? (input instanceof Request ? input.method : "GET");
    const parsedMethod = Schema.decodeUnknownOption(RequestDiagnostic.fields.method)(method);
    observed = {
      ...observed,
      method: parsedMethod._tag === "Some" ? parsedMethod.value : null,
      route: routeName(url),
    };
    span.updateName(routeName(url));
    if (observed.method) span.setAttribute("http.request.method", observed.method);
    const headers = new Headers(
      options?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (isApiRequest(url)) {
      for (const [name, value] of Object.entries(Sentry.getTraceData({ span }))) {
        if (value) headers.set(name, value);
      }
    }
    // A read the page started before the dashboard loaded answers its first matching request.
    const early = takeEarlyResponse(url, method);
    return (early ?? transport(input, { ...options, headers })).then((response) => {
      observed = { ...observed, status: response.status };
      span.setAttribute("http.response.status_code", response.status);
      return response;
    });
  };
  try {
    const result = await Effect.runPromise(
      operation.pipe(
        Effect.provideService(FetchHttpClient.Fetch, tracedFetch),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.timeout(limit),
        Effect.result,
      ),
      { signal },
    );
    if (result._tag === "Success") {
      span.setStatus({ code: 1 });
      return result.success;
    }
    if (Schema.is(KnownFailure)(result.failure)) {
      const failure = result.failure;
      throw new ApiError(
        failure.error.code,
        failure.error.message,
        failure.meta.requestId,
        { kind: "StatusCodeError", ...observed },
        trace,
        failure.error.code === "invitation_limited" || failure.error.code === "feedback_limited"
          ? failure.error.retryAt
          : null,
        failure.error.code === "invitation_email_mismatch" ? failure.error.sentTo : null,
      );
    }
    const http = HttpClientError.isHttpClientError(result.failure) ? result.failure : null;
    const diagnostic: RequestDiagnostic = {
      kind: http
        ? http.reason._tag
        : Cause.isTimeoutError(result.failure)
          ? "TimeoutError"
          : Schema.isSchemaError(result.failure)
            ? "SchemaError"
            : "UnknownError",
      method: http?.request.method ?? observed.method,
      route: http ? routeName(http.request.url) : observed.route,
      status: http?.response?.status ?? observed.status,
    };
    throw new ApiError(
      "connection_unavailable",
      "The request could not be confirmed. Check your connection and try again.",
      null,
      diagnostic,
      trace,
    );
  } catch (error) {
    span.setStatus({
      code: 2,
      message: signal?.aborted
        ? "cancelled"
        : error instanceof ApiError && error.diagnostic?.kind === "TimeoutError"
          ? "deadline_exceeded"
          : "internal_error",
    });
    if (error instanceof ApiError) {
      span.setAttribute("talkto.code", error.code);
      if (error.requestId) span.setAttribute("talkto.request_id", error.requestId);
      if (error.diagnostic) span.setAttribute("talkto.failure_kind", error.diagnostic.kind);
    }
    throw error;
  } finally {
    span.end();
  }
}

/** Denied data must leave the UI immediately, including stale cached copies. */
export const denied = (error: Error | null) =>
  error instanceof ApiError &&
  ["unauthenticated", "forbidden", "server_unavailable", "not_found"].includes(error.code);

/** Retry transient reads only; mutations retain explicit user-controlled reconciliation. */
export const retryRead = (count: number, error: Error) =>
  count < 2 &&
  error instanceof ApiError &&
  [
    "connection_unavailable",
    "storage_unavailable",
    "identity_unavailable",
    "billing_unavailable",
    "internal_error",
  ].includes(error.code);

/** Omit empty browser controls, then validate and brand values at the request boundary. */
export function input<S extends Schema.ConstraintDecoder<unknown, never>, T extends object>(
  schema: S,
  values: T,
): S["Type"] {
  const parsed = Schema.decodeUnknownResult(schema)(
    Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== undefined && value !== ""),
    ),
  );
  if (parsed._tag === "Failure")
    throw new ApiError(
      "invalid_input",
      "The search or selection is invalid. Shorten the search or reopen this page.",
    );
  return parsed.success;
}
