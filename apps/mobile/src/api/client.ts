import { Cause, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Api } from "@talkto/api/api";
import * as P from "@talkto/api/platform";
import * as Envelope from "@talkto/api/envelope";

/** Safe request failure; raw transport errors can contain URLs, headers or response bodies. */
export class ApiError extends Error {
  /** Stable public error code from the envelope, or a transport failure. */
  readonly code: Envelope.FailureCode | "connection_unavailable";
  /** Diagnostic correlation, without payloads. */
  readonly requestId: string | null;
  /** HTTP status when the server answered. */
  readonly status: number | null;
  constructor(
    code: ApiError["code"],
    message: string,
    requestId: string | null = null,
    status: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.requestId = requestId;
    this.status = status;
  }
}

/** Generate every client from the shared contracts, exactly as apps/web does. */
export function createApi(baseUrl: string) {
  const clients = Effect.runSync(
    Effect.all({
      platform: HttpApiClient.make(P.Api, { baseUrl }),
      server: HttpApiClient.make(Api, { baseUrl }),
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  return {
    platform: clients.platform.platform,
    server: clients.server.server,
  };
}
/** Client shape comes from the API declaration rather than handwritten DTOs. */
export type Client = ReturnType<typeof createApi>;

/** How requests get a credential: the session owns refresh and sign-out. */
export interface Credentials {
  /** Origin the credential belongs to; it is never sent anywhere else. */
  readonly origin: string;
  /** A credential that is valid now, refreshing first when it is about to expire. */
  readonly current: () => Promise<string>;
  /** Replace a credential the server refused; null when it cannot be renewed. */
  readonly renew: () => Promise<string | null>;
}

const attempt = async <A, E>(
  operation: Effect.Effect<A, E>,
  credentials: Credentials,
  token: string,
  signal: AbortSignal | undefined,
) => {
  let status: number | null = null;
  const authorized: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    if (url.startsWith(`${credentials.origin}/`)) headers.set("authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers }).then((response) => {
      status = response.status;
      return response;
    });
  };
  const result = await Effect.runPromise(
    operation.pipe(
      Effect.provideService(FetchHttpClient.Fetch, authorized),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.timeout("15 seconds"),
      Effect.result,
    ),
    { signal },
  );
  return { result, status };
};

/** Run one generated request with the session's credential; a refused credential is renewed once. */
export async function request<A, E>(
  credentials: Credentials,
  operation: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  let outcome = await attempt(operation, credentials, await credentials.current(), signal);
  if (outcome.status === 401) {
    const renewed = await credentials.renew();
    if (renewed !== null) outcome = await attempt(operation, credentials, renewed, signal);
  }
  const { result, status } = outcome;
  if (result._tag === "Success") return result.success;
  if (Schema.is(Envelope.Failure)(result.failure)) {
    const failure = result.failure;
    throw new ApiError(failure.error.code, failure.error.message, failure.meta.requestId, status);
  }
  if (HttpClientError.isHttpClientError(result.failure) && status === 404)
    throw new ApiError("not_found", "This server does not offer that yet.", null, status);
  throw new ApiError(
    "connection_unavailable",
    Cause.isTimeoutError(result.failure)
      ? "The server took too long to answer. Try again."
      : "TalkTo could not be reached. Check your connection and try again.",
    null,
    status,
  );
}

/** Denied data must leave the screen immediately, including cached copies. */
export const denied = (error: Error | null) =>
  error instanceof ApiError &&
  ["unauthenticated", "forbidden", "server_unavailable", "not_found"].includes(error.code);

/** Retry transient reads only; sends keep explicit, user-controlled retry. */
export const retryRead = (count: number, error: Error) =>
  count < 2 &&
  error instanceof ApiError &&
  [
    "connection_unavailable",
    "storage_unavailable",
    "identity_unavailable",
    "internal_error",
  ].includes(error.code);

/**
 * Words for an error a person can act on; unknown failures never show raw details. A limit
 * names what was limited: a send (a person may send 30 messages a minute on a server) or, by
 * default, how often the app reads the server.
 */
export function describeError(error: Error | null, attempt: "read" | "send" = "read") {
  if (!(error instanceof ApiError)) return "Something went wrong. Try again.";
  if (error.code === "rate_limited")
    return attempt === "send"
      ? "You're sending quickly. Wait a moment and try again."
      : "TalkTo is limiting how often this server can be loaded right now. Wait a moment and try again.";
  if (error.code === "unauthenticated") return "Your sign-in has ended. Sign in again.";
  if (error.code === "forbidden" || error.code === "server_unavailable")
    return "You no longer have access to this server.";
  return error.message;
}
