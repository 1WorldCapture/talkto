import { AuthRequest, ResponseType } from "expo-auth-session";
import { Schema } from "effect";
import * as P from "@talkto/api/platform";

/*
  WorkOS AuthKit, authorization code with PKCE in the system browser. The app is a public client:
  no client secret, the code verifier proves the exchange. The same User Management endpoints
  the API helper (apps/server/tools/api.mjs) uses for its device flow and refresh.
*/

/** Registered with WorkOS for each TalkTo environment the app signs in to. */
export const redirectUri = "talkto://auth/callback";
const discovery = {
  authorizationEndpoint: "https://api.workos.com/user_management/authorize",
  tokenEndpoint: "https://api.workos.com/user_management/authenticate",
};

const Tokens = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
});
const AuthenticationResponse = Schema.Struct({ data: P.Authentication });
/** Only the expiry is read from the access token; the server verifies it. */
const Claims = Schema.fromJsonString(Schema.Struct({ exp: Schema.Number }));

/** A signed-in person's tokens for one TalkTo origin. */
export interface Session {
  readonly origin: string;
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

/** Sign-in failed or was cancelled; the message is safe to show. */
export class SignInError extends Error {
  readonly cancelled: boolean;
  constructor(message: string, cancelled = false) {
    super(message);
    this.name = "SignInError";
    this.cancelled = cancelled;
  }
}

/** WorkOS refused the grant (sign in again), or could not be asked (keep the session, retry later). */
type Grant = typeof Tokens.Type | "rejected" | "unavailable";

const post = async (body: Record<string, string>): Promise<Grant> => {
  const response = await fetch(discovery.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  }).catch(() => null);
  if (response === null) return "unavailable";
  if (response.status === 400 || response.status === 401 || response.status === 403)
    return "rejected";
  if (!response.ok) return "unavailable";
  const parsed = Schema.decodeUnknownResult(Tokens)(await response.json().catch(() => null));
  return parsed._tag === "Success" ? parsed.success : "unavailable";
};

/** The server says which WorkOS client signs in to it (`GET /auth`); nothing secret is returned. */
async function clientIdFor(origin: string) {
  const response = await fetch(`${origin}/auth`, { headers: { accept: "application/json" } }).catch(
    () => null,
  );
  if (response === null) throw new SignInError("TalkTo could not be reached. Try again.");
  const parsed = Schema.decodeUnknownResult(AuthenticationResponse)(
    await response.json().catch(() => null),
  );
  if (!response.ok || parsed._tag === "Failure")
    throw new SignInError("Sign-in is not available on this server right now.");
  return parsed.success.data.clientId;
}

/** Open AuthKit in the system browser and exchange the returned code for tokens. */
export async function signIn(origin: string): Promise<Session> {
  const clientId = await clientIdFor(origin);
  const authorization = new AuthRequest({
    clientId,
    redirectUri,
    responseType: ResponseType.Code,
    usePKCE: true,
    scopes: [],
    extraParams: { provider: "authkit" },
  });
  const result = await authorization.promptAsync(discovery);
  if (result.type === "cancel" || result.type === "dismiss")
    throw new SignInError("Sign-in was cancelled.", true);
  const code = result.type === "success" ? result.params["code"] : undefined;
  if (code === undefined || authorization.codeVerifier === undefined)
    throw new SignInError("Sign-in did not finish. Try again.");
  const tokens = await post({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: authorization.codeVerifier,
  });
  if (tokens === "rejected" || tokens === "unavailable")
    throw new SignInError("Sign-in did not finish. Try again.");
  return {
    origin,
    clientId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
  };
}

/** Exchange the refresh token for a new pair; "rejected" means sign in again. */
export async function refresh(session: Session): Promise<Session | "rejected" | "unavailable"> {
  const tokens = await post({
    grant_type: "refresh_token",
    client_id: session.clientId,
    refresh_token: session.refreshToken,
  });
  return tokens === "rejected" || tokens === "unavailable"
    ? tokens
    : { ...session, accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
}

/** Refresh shortly before expiry, as the API helper does, rather than waiting for a refusal. */
export function expiresSoon(accessToken: string, now = Date.now()) {
  const payload = accessToken.split(".")[1];
  if (payload === undefined) return true;
  const json = atob(
    payload
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(payload.length / 4) * 4, "="),
  );
  const claims = Schema.decodeUnknownResult(Claims)(json);
  return claims._tag === "Failure" || claims.success.exp * 1000 <= now + 30_000;
}
