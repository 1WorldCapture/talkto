/**
 * Whether a request belongs to Better Auth mode (docs/self-host-better-auth.md), without loading
 * Better Auth. hosted.ts imports better-auth.ts only when a copy asks for it, so the WorkOS and
 * Access modes, talkto.sh among them, never pay for it at startup.
 */

/** Whether this copy asks for Better Auth: its switch or its secret is present. */
export const requested = (env: Env) => "TALKTO_AUTH_PROVIDER" in env || "BETTER_AUTH_SECRET" in env;

/** The website paths Better Auth mode answers beyond `/auth/login`, `/auth/callback` and `/auth/logout`. */
export const isPath = (path: string) =>
  path === "/auth/sign-in" ||
  path === "/auth/sign-up" ||
  path === "/auth/consent" ||
  path === "/auth/join" ||
  path.startsWith("/auth/api/") ||
  path === "/.well-known/oauth-authorization-server" ||
  path === "/.well-known/openid-configuration";
