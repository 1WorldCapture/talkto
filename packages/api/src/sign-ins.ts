import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import * as M from "./models.js";
import * as P from "./platform.js";
import * as Envelope from "./envelope.js";
import { Authorization } from "./security.js";

/*
  Signed-in computers (docs/dashboard-api.md, "Signed-in computers"). Each place an agent app signed
  in to the person's TalkTo through the MCP sign-in, and the way to sign one out. A sign-in TalkTo
  has seen is identified by its own UUID; one only WorkOS knows about (an authorization granted
  before TalkTo recorded sign-ins, or never used since) by WorkOS's authorized application ID.
*/

/** A sign-in on this page: TalkTo's record ID, or WorkOS's authorized application ID. */
export const SignInId = Schema.String.check(
  Schema.isPattern(
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|authorized_connect_app_[A-Za-z0-9]{1,64})$/,
  ),
).pipe(Schema.brand("SignInId"));
/** Parsed sign-in ID. */
export type SignInId = typeof SignInId.Type;

/**
 * What a sign-out covers. `this`: only this sign-in. `app`: every sign-in of this app for the
 * person, which an app that shares one client ID across every copy (CIMD, for example Codex)
 * needs to end its WorkOS authorization.
 */
export const SignOutScope = Schema.Literals(["this", "app"]);
/** Parsed sign-out scope. */
export type SignOutScope = typeof SignOutScope.Type;

/** One signed-in place. Times are null when only WorkOS knows the sign-in. */
export const SignIn = Schema.Struct({
  id: SignInId,
  /** The app's name, for example "Claude Code". */
  app: Schema.String,
  /** The OAuth client the app signed in with: an ID, or a URL every copy of the app shares. */
  clientId: Schema.String,
  /** True when every copy of this app signs in with the same client ID (CIMD). */
  shared: Schema.Boolean,
  /** Coarse place of the most recent request, for example "San Francisco, US". Never an address. */
  place: Schema.NullOr(Schema.String),
  /** The program that made the requests, from its User-Agent, for example "claude-code". */
  agent: Schema.NullOr(Schema.String),
  firstSignedInAt: Schema.NullOr(M.Timestamp),
  lastActiveAt: Schema.NullOr(M.Timestamp),
  /** The sign-outs this sign-in offers, in order. Never empty. */
  signOut: Schema.Array(SignOutScope).check(Schema.isMinLength(1)),
});
/** Parsed sign-in. */
export interface SignIn extends Schema.Schema.Type<typeof SignIn> {}

/**
 * The person's sign-ins, most recently active first. `provider` is `unavailable` when WorkOS
 * could not be asked: the list then has only what TalkTo recorded, and app names may be missing.
 */
export const SignIns = Schema.Struct({
  items: Schema.Array(SignIn),
  provider: Schema.Literals(["ok", "unavailable"]),
});
/** Parsed sign-in list. */
export interface SignIns extends Schema.Schema.Type<typeof SignIns> {}

/** Sign out one sign-in. `scope` defaults to `this`. */
export const SignOut = Schema.Struct({ scope: Schema.optionalKey(SignOutScope) }).annotate({
  parseOptions: { onExcessProperty: "error" },
});
/** Parsed sign-out request. */
export interface SignOut extends Schema.Schema.Type<typeof SignOut> {}

/**
 * The finished sign-out. `provider` is `revoked` when WorkOS also ended the app's authorization
 * and refresh tokens, `skipped` when only TalkTo refuses this sign-in (one copy of a shared app).
 */
export const SignedOut = Schema.Struct({
  scope: SignOutScope,
  provider: Schema.Literals(["revoked", "skipped"]),
});
/** Parsed sign-out outcome. */
export interface SignedOut extends Schema.Schema.Type<typeof SignedOut> {}

/** Whether every copy of an app shares this client ID: a CIMD client ID is an HTTPS URL. */
export const sharedClient = (clientId: string) => /^https:\/\//i.test(clientId);

/** Readable names for the programs agents connect with, keyed by User-Agent product. */
const agentNames: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude-code/i, "Claude Code"],
  [/^claude/i, "Claude"],
  [/^codex/i, "Codex"],
  [/^cursor/i, "Cursor"],
  [/^openai/i, "ChatGPT"],
  [/^opencode/i, "OpenCode"],
  [/^vscode|^visual-studio-code/i, "VS Code"],
  [/^windsurf/i, "Windsurf"],
  [/^goose/i, "Goose"],
];
/** The app name for a recorded User-Agent product, or null when TalkTo does not know it. */
export const agentName = (agent: string | null) =>
  agent === null ? null : (agentNames.find(([pattern]) => pattern.test(agent))?.[1] ?? null);

/** The signed-in person's own MCP sign-ins. No MCP surface. */
export const Api = HttpApi.make("talkto-sign-ins").add(
  HttpApiGroup.make("signIns")
    .add(
      HttpApiEndpoint.get("list", "/v1/me/sign-ins", {
        success: P.response(SignIns),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("signOut", "/v1/me/sign-ins/:id/sign-out", {
        params: { id: SignInId },
        payload: SignOut,
        success: P.response(SignedOut),
        error: Envelope.failures,
      }),
    )
    .middleware(Authorization),
);
