import { Effect, Option, Schema } from "effect";
import { Cookies } from "effect/unstable/http";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import * as Model from "./platform/model.js";
import * as Browser from "./browser-auth.js";
import * as Responses from "./responses.js";

/**
 * Self-host sign-in with Cloudflare Access (docs/self-host-cloudflare-access.md). Access signs
 * people in before a request reaches the Worker and adds its signed token; the Worker verifies that
 * token on every request and never trusts a request only because it arrived.
 */

/** The header Access adds to every request it lets through. */
export const tokenHeader = "cf-access-jwt-assertion";
/** Access's browser cookie: only a website request carries it. */
const cookieName = "CF_Authorization";

const Settings = Schema.Struct({
  TALKTO_ACCESS_TEAM_DOMAIN: Schema.String.check(
    Schema.isPattern(/^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$/),
  ),
  TALKTO_ACCESS_AUD: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{16,128}$/)),
});
/** Parsed Access settings: the team domain is the issuer; the AUD tag names the application. */
export interface Settings extends Schema.Schema.Type<typeof Settings> {}

const unconfigured = () =>
  new Model.Failure({
    code: "identity_unavailable",
    message:
      "Cloudflare Access sign-in is misconfigured. Set TALKTO_ACCESS_TEAM_DOMAIN and TALKTO_ACCESS_AUD on a self-hosted copy.",
  });
const unauthenticated = (message = "Sign in through Cloudflare Access.") =>
  new Model.Failure({ code: "unauthenticated", message });
const unavailable = () =>
  new Model.Failure({
    code: "identity_unavailable",
    message: "Cloudflare Access is temporarily unavailable.",
  });

/** Whether this copy asks for Access sign-in: either setting is present. */
export const requested = (env: Env) =>
  "TALKTO_ACCESS_TEAM_DOMAIN" in env || "TALKTO_ACCESS_AUD" in env;

/** Read the settings. Access mode is for self-hosted copies only, so talkto.sh can never use it. */
export const settings = Effect.fn("CloudflareAccess.settings")(function* (env: Env) {
  const selfHosted = Schema.decodeUnknownOption(
    Schema.Struct({ TALKTO_SELF_HOSTED: Schema.Literal("true") }),
  )(env);
  if (Option.isNone(selfHosted)) return yield* unconfigured();
  return yield* Schema.decodeUnknownEffect(Settings)(env).pipe(Effect.mapError(unconfigured));
});

const Claims = Schema.Struct({
  email: Schema.String.check(
    Schema.isMaxLength(254),
    // ASCII only, so lowercasing can never fold two different addresses into one.
    Schema.isPattern(/^[\x21-\x3f\x41-\x7e]+@[\x21-\x3f\x41-\x7e]+\.[\x21-\x3f\x41-\x7e]+$/),
  ),
});

/** Access's checked sign-in: the lowercased email, and whether it came from the website. */
export interface Checked {
  readonly email: string;
  readonly website: boolean;
}
/** The person a verified request belongs to, and whether it came from the website. */
export interface Verified extends Checked {
  readonly actor: Model.Actor;
}

/** Where a request goes: the website and API, or `/mcp`. */
export type Route = "api" | "mcp";

/** Access's signing keys for the team, cached and refreshed by jose when a new key appears. */
export const remoteKeys = (settings: Settings): JWTVerifyGetKey =>
  createRemoteJWKSet(new URL(`${settings.TALKTO_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));

/**
 * Verify Access's token: RS256 with the team's keys, the team domain as issuer, the application's
 * AUD tag in the audience, a current expiry, and an email. Service tokens carry no email, so they
 * never sign in as a person.
 */
export const verifier = (settings: Settings, origin: string, keys: JWTVerifyGetKey) => {
  const check = Effect.fn("CloudflareAccess.check")(function* (token: string) {
    if (token.length === 0 || token.length > 16384) return yield* unauthenticated();
    const result = yield* Effect.tryPromise({
      try: () =>
        jwtVerify(token, keys, {
          issuer: settings.TALKTO_ACCESS_TEAM_DOMAIN,
          audience: settings.TALKTO_ACCESS_AUD,
          algorithms: ["RS256"],
          requiredClaims: ["exp", "iat"],
        }),
      catch: (error) =>
        error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError)
          ? unavailable()
          : unauthenticated(),
    });
    const claims = yield* Schema.decodeUnknownEffect(Claims)(result.payload).pipe(
      Effect.mapError(() =>
        unauthenticated(
          "This Cloudflare Access sign-in has no email. Service tokens cannot sign in to TalkTo.",
        ),
      ),
    );
    return claims.email.toLowerCase();
  });
  const host = new URL(origin).host;
  return Effect.fn("CloudflareAccess.verify")(function* (
    request: Request,
    route: Route,
  ): Effect.fn.Return<Checked, Model.Failure> {
    // Access guards this copy's own hostname only; a token arriving by any other host is refused.
    if (new URL(request.url).host !== host) return yield* unauthenticated();
    const token = request.headers.get(tokenHeader);
    if (token === null) return yield* unauthenticated();
    const email = yield* check(token);
    const cookie = Cookies.parseHeader(request.headers.get("cookie") ?? "")[cookieName];
    // `/mcp` checks browser origins against its own allowlist and never counts as the website.
    if (route === "mcp") return { email, website: false };
    // Any request a browser could send, with a cookie or an Origin, must come from this site to
    // change something, whatever its cookie holds.
    if (cookie !== undefined || request.headers.has("origin"))
      yield* Browser.checkOrigin(request, origin);
    // A website request carries Access's browser cookie holding the very token Access forwarded.
    return { email, website: cookie === token };
  });
};

const ReturnPath = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^\/(?:app(?:\/[A-Za-z0-9/_-]*)?|onboarding)(?:\?[^\\\r\n#]*)?$/),
);

/**
 * The website's `/auth/*` routes. Access signs the person in before the Worker sees the request, so
 * sign-in only returns them to their page, and sign-out ends their Access session.
 */
export const browser = (origin: string): Browser.Authentication => ({
  route: Effect.fn("CloudflareAccess.route")(function* (request: Request) {
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
      const returnTo = Schema.decodeUnknownOption(ReturnPath)(url.searchParams.get("return_to"));
      return redirect(`${origin}${Option.getOrElse(returnTo, () => "/app")}`);
    }
    if (url.pathname === "/auth/logout" && request.method === "POST") {
      yield* Browser.checkOrigin(request, origin);
      // Access ends the person's sessions for every application in the account.
      return redirect(
        `${origin}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(`${origin}/`)}`,
      );
    }
    return Responses.failure(404, "not_found", "Cloudflare Access handles sign-in.", meta);
  }),
  // Never used: the hosted Worker reads Access's token, not a TalkTo session cookie.
  session: () => Effect.fail(unauthenticated()),
});
