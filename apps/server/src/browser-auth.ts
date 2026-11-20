import { WorkOS, OauthException, BadRequestException } from "@workos-inc/node";
import { Clock, Config, ConfigProvider, Effect, Option, Redacted, Schema } from "effect";
import { Cookies } from "effect/unstable/http";
import { EncryptJWT, jwtDecrypt, decodeJwt } from "jose";
import * as Model from "./platform/model.js";
import type * as WorkOSIdentity from "./platform/workos.js";
import * as Responses from "./responses.js";

const loginCookie = "__Host-talkto-login";
/** Host-only browser credential. MCP continues to require its own bearer token. */
export const sessionCookie = "__Host-talkto-session";
const invalid = () =>
  new Model.Failure({
    code: "unauthenticated",
    message: "The browser session or sign-in attempt expired. Sign in again.",
  });
const unavailable = () =>
  new Model.Failure({
    code: "identity_unavailable",
    message: "Browser authentication is temporarily unavailable. Retry without signing out.",
  });
const ReturnPath = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^\/(?:app(?:\/[A-Za-z0-9/_-]*)?|onboarding)(?:\?[^\\\r\n#]*)?$/),
);
const Login = Schema.Struct({
  state: Schema.NonEmptyString,
  codeVerifier: Schema.NonEmptyString,
  returnTo: ReturnPath,
});
const Callback = Schema.Struct({
  code: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  state: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
});
const LoginQuery = Schema.Struct({
  invitation_token: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(2048))),
  return_to: Schema.optionalKey(ReturnPath),
});
const Secret = Schema.RedactedFromValue(Schema.NonEmptyString);
const cookie = (
  name: string,
  value: string,
  maxAge: `${number} ${"seconds" | "minutes" | "days"}`,
) =>
  Cookies.serializeCookie(
    Cookies.makeCookieUnsafe(name, value, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      maxAge,
    }),
  );
/** Expire an unusable browser credential without touching bearer or MCP clients. */
export const clearSession = () => cookie(sessionCookie, "", "0 seconds");
const readCookie = (request: Request, name: string) =>
  Cookies.parseHeader(request.headers.get("cookie") ?? "")[name];
/** Whether the request supplies the website's session cookie. */
export const hasSession = (request: Request) => readCookie(request, sessionCookie) !== undefined;
/** Reject cross-site cookie mutations before any provider or application operation. */
export const checkOrigin = (request: Request, origin: string) => {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return Effect.void;
  return request.headers.get("origin") === origin &&
    request.headers.get("sec-fetch-site") !== "cross-site"
    ? Effect.void
    : Effect.fail(
        new Model.Failure({
          code: "forbidden",
          message: "Browser mutations require the TalkTo website's Origin.",
        }),
      );
};
/** Verified SDK session plus an optional replacement cookie after token rotation. */
export interface Session {
  readonly accessToken: Redacted.Redacted<string>;
  readonly setCookie: string | null;
}
/** Browser-specific adapter; all application authority still comes from the shared JWT verifier. */
export interface Authentication {
  readonly route: (request: Request) => Effect.Effect<Response, Model.Failure>;
  readonly session: (request: Request) => Effect.Effect<Session, Model.Failure>;
}
/** Build optional website authentication without making it a dependency of MCP or device login. */
export const make = Effect.fn("Browser.make")(function* (
  env: Env,
  config: WorkOSIdentity.Configuration,
  origin: string,
) {
  const password = yield* Config.option(Config.redacted("WORKOS_COOKIE_PASSWORD")).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Effect.mapError(unavailable),
  );
  if (Option.isNone(password)) return undefined;
  if (Redacted.value(password.value).length < 32 || !origin.startsWith("https://"))
    return yield* unavailable();
  const redirectUri = yield* Config.string("WORKOS_REDIRECT_URI").pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Effect.mapError(unavailable),
  );
  if (redirectUri !== `${origin}/auth/callback`) return yield* unavailable();
  const sdk = new WorkOS(Redacted.value(config.apiKey), {
    clientId: config.clientId,
    maxRetries: 2,
  });
  return create(sdk, password.value, origin, redirectUri);
});

const create = (
  sdk: WorkOS,
  password: Redacted.Redacted<string>,
  origin: string,
  redirectUri: string,
): Authentication => {
  const cookiePassword = Redacted.value(password);
  const encryptionKey = () =>
    crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(cookiePassword))
      .then((value) => new Uint8Array(value));
  const sdkSession = (value: string) =>
    sdk.userManagement.loadSealedSession({ sessionData: value, cookiePassword });
  const session = Effect.fn("Browser.session")(function* (
    request: Request,
  ): Effect.fn.Return<Session, Model.Failure> {
    yield* checkOrigin(request, origin);
    const value = readCookie(request, sessionCookie);
    if (value === undefined || value.length > 12000) return yield* invalid();
    const current = sdkSession(value);
    const result = yield* Effect.tryPromise({
      try: () => current.authenticate(),
      catch: unavailable,
    });
    if (result.authenticated)
      return { accessToken: Redacted.make(result.accessToken), setCookie: null };
    if (result.reason !== "invalid_jwt") return yield* invalid();
    const refreshed = yield* Effect.tryPromise({
      try: () => current.refresh(),
      catch: unavailable,
    });
    if (!refreshed.authenticated) return yield* refreshed.retryable ? unavailable() : invalid();
    if (refreshed.sealedSession === undefined || refreshed.session === undefined)
      return yield* unavailable();
    return {
      accessToken: Redacted.make(refreshed.session.accessToken),
      setCookie: cookie(sessionCookie, refreshed.sealedSession, "30 days"),
    };
  });
  const route = Effect.fn("Browser.route")(function* (request: Request) {
    const url = new URL(request.url);
    const meta = Responses.metadata(origin);
    const headers = new Headers({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-request-id": meta.requestId,
    });
    const redirect = (location: string) => {
      headers.set("location", location);
      return new Response(null, { status: 303, headers });
    };
    if (url.pathname === "/auth/login" && request.method === "GET") {
      const query = yield* Schema.decodeUnknownEffect(LoginQuery)(
        Object.fromEntries(url.searchParams),
      ).pipe(Effect.mapError(invalid));
      const options: Parameters<typeof sdk.userManagement.getAuthorizationUrlWithPKCE>[0] = {
        provider: "authkit",
        redirectUri,
      };
      if (query.invitation_token !== undefined) options.invitationToken = query.invitation_token;
      const flow = yield* Effect.tryPromise({
        try: () => sdk.userManagement.getAuthorizationUrlWithPKCE(options),
        catch: unavailable,
      });
      // SDK 10.13's PKCE helper omits invitationToken from its authorization URL.
      const authorizationUrl = new URL(flow.url);
      if (query.invitation_token !== undefined)
        authorizationUrl.searchParams.set("invitation_token", query.invitation_token);
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const sealed = yield* Effect.tryPromise({
        try: async () =>
          new EncryptJWT({
            state: flow.state,
            codeVerifier: flow.codeVerifier,
            returnTo: query.return_to ?? "/app",
          })
            .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
            .setIssuer(origin)
            .setAudience("talkto-browser-login")
            .setIssuedAt(now)
            .setExpirationTime(now + 600)
            .encrypt(await encryptionKey()),
        catch: unavailable,
      });
      headers.append("set-cookie", cookie(loginCookie, sealed, "10 minutes"));
      return redirect(authorizationUrl.toString());
    }
    if (url.pathname === "/auth/callback" && request.method === "GET") {
      headers.append("set-cookie", cookie(loginCookie, "", "0 seconds"));
      const outcome = yield* Effect.gen(function* () {
        const query = yield* Schema.decodeUnknownEffect(Callback)(
          Object.fromEntries(url.searchParams),
        ).pipe(Effect.mapError(invalid));
        const sealed = readCookie(request, loginCookie);
        if (sealed === undefined || sealed.length > 4096) return yield* invalid();
        const transaction = yield* Effect.tryPromise({
          try: async () =>
            jwtDecrypt(sealed, await encryptionKey(), {
              issuer: origin,
              audience: "talkto-browser-login",
              keyManagementAlgorithms: ["dir"],
              contentEncryptionAlgorithms: ["A256GCM"],
            }),
          catch: invalid,
        });
        const flow = yield* Schema.decodeUnknownEffect(Login)(transaction.payload).pipe(
          Effect.mapError(invalid),
        );
        if (flow.state !== query.state) return yield* invalid();
        const result = yield* Effect.tryPromise({
          try: () =>
            sdk.userManagement.authenticateWithCode({
              code: query.code,
              codeVerifier: flow.codeVerifier,
              session: { sealSession: true, cookiePassword },
            }),
          catch: (error) =>
            error instanceof OauthException || error instanceof BadRequestException
              ? invalid()
              : unavailable(),
        });
        const session = yield* Schema.decodeUnknownEffect(Secret)(result.sealedSession).pipe(
          Effect.mapError(unavailable),
        );
        return { session, returnTo: flow.returnTo };
      }).pipe(Effect.result);
      if (outcome._tag === "Failure") {
        const response = Responses.failure(
          outcome.failure.code === "unauthenticated" ? 401 : 503,
          outcome.failure.code,
          outcome.failure.message,
          meta,
        );
        for (const [name, value] of headers) response.headers.append(name, value);
        return response;
      }
      headers.append(
        "set-cookie",
        cookie(sessionCookie, Redacted.value(outcome.success.session), "30 days"),
      );
      return redirect(`${origin}${outcome.success.returnTo}`);
    }
    if (url.pathname === "/auth/logout" && request.method === "POST") {
      yield* checkOrigin(request, origin);
      const value = readCookie(request, sessionCookie);
      let location = `${origin}/`;
      if (value !== undefined) {
        const current = yield* Effect.tryPromise({
          try: () =>
            sdk.userManagement.getSessionFromCookie({ sessionData: value, cookiePassword }),
          catch: unavailable,
        });
        if (current !== undefined && current.accessToken !== undefined) {
          const claims = yield* Effect.try({
            try: () => decodeJwt(current.accessToken),
            catch: invalid,
          });
          const parsed = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ sid: Schema.NonEmptyString }),
          )(claims).pipe(Effect.mapError(invalid));
          location = sdk.userManagement.getLogoutUrl({
            sessionId: parsed.sid,
            returnTo: `${origin}/`,
          });
        }
      }
      headers.append("set-cookie", clearSession());
      headers.append("set-cookie", cookie(loginCookie, "", "0 seconds"));
      return redirect(location);
    }
    return new Response(null, {
      status: 405,
      headers: { allow: url.pathname === "/auth/logout" ? "POST" : "GET" },
    });
  });
  return { route, session };
};
