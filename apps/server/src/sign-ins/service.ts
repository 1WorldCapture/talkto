import { Clock, DateTime, Effect, Result } from "effect";
import * as P from "@talkto/api/platform";
import * as S from "@talkto/api/sign-ins";
import * as M from "@talkto/api/models";
import * as Model from "../platform/model.js";
import * as Platform from "../platform/service.js";
import * as Store from "./store.js";

/*
  Signed-in computers (docs/dashboard-api.md, "Signed-in computers"): what MCP authentication
  checks after a resource token verifies, what it records, the person's list, and sign-out.

  Cost on the MCP path, per Worker isolate: at most one indexed D1 read of the person's
  revocations every `revocationCacheMs` (30 s), on the request path; and at most one D1 upsert per
  sign-in every `recordInterval` (5 minutes), after the response through waitUntil. The upsert's
  own condition keeps the row written at most once per interval across isolates.
*/

/** How often a sign-in's last-seen time is written. */
export const recordInterval = 5 * 60_000;
/** How long an isolate trusts the revocations it read. A sign-out reaches every isolate within it. */
export const revocationCacheMs = 30_000;
/** Rows unseen this long are deleted by the minute cron. */
export const retentionDays = 90;
/** How long a per-`sid` sign-out stays in force after the sign-in last tried to connect. */
export const sidRevocationDays = 90;
/** Rows per person: bounds the table if a client's `sid` changes on every token refresh. */
export const sessionCap = 100;
const day = 86_400_000;
const cacheLimit = 10_000;

/** Facts the HTTP boundary reads from the request. No IP address. */
export interface Observed {
  /** First User-Agent product, lowercased, for example `claude-code`. */
  readonly agent: string | null;
  readonly city: string | null;
  readonly country: string | null;
}
/** Deployment settings. */
export interface Settings {
  /**
   * The longest an MCP access token can live (AuthKit "Access token duration", or longer). A
   * client-wide sign-out is enforced this long, after which every token issued before it expired.
   */
  readonly maxTokenLifetimeMs: number;
}

const revocations = new Map<
  string,
  { readonly at: number; readonly items: ReadonlyArray<Store.Revocation> }
>();
const recorded = new Map<string, number>();
const extended = new Map<string, number>();
const remember = <V>(map: Map<string, V>, key: string, value: V) => {
  if (map.size >= cacheLimit) map.clear();
  map.set(key, value);
};
const sessionKey = (userId: string, clientId: string, sid: string | null) =>
  JSON.stringify([userId, clientId, sid]);
/** Forget what this isolate knows about a person, after their sign-out here. */
const forget = (userId: string) => {
  revocations.delete(userId);
  const prefix = JSON.stringify([userId]).slice(0, -1);
  for (const key of [...recorded.keys(), ...extended.keys()])
    if (key.startsWith(prefix)) {
      recorded.delete(key);
      extended.delete(key);
    }
};
/** Clear every isolate cache. Tests only. */
export const resetCaches = () => {
  revocations.clear();
  recorded.clear();
  extended.clear();
};

/** Whether a revocation refuses a token from this client. */
export const covers = (revocation: Store.Revocation, client: Model.McpClient) =>
  revocation.clientId === client.clientId &&
  (revocation.sid === null
    ? client.issuedAt * 1000 <= revocation.revokedAt
    : revocation.sid === client.sid);

/** What admission decided, and the recording to run after the response. */
export interface Admission {
  readonly revoked: boolean;
  /** Never fails: storage problems are passed to `report` and dropped. */
  readonly background: Effect.Effect<void> | null;
}

/**
 * Check a verified MCP token against the person's sign-outs, and decide whether to record it. If
 * the revocations cannot be read, the last ones this isolate read are used, or none: an outage of
 * the platform database never stops MCP. WorkOS has already ended the refresh tokens of a
 * client-wide sign-out, so only access tokens issued before it could get through meanwhile.
 */
export const admit = Effect.fn("SignIns.admit")(function* (
  userId: P.UserId,
  client: Model.McpClient,
  observed: Observed,
  report: (error: Model.Failure, operation: string) => void,
) {
  const store = yield* Store.Store;
  const now = yield* Clock.currentTimeMillis;
  const cached = revocations.get(userId);
  let items = cached?.items ?? [];
  if (cached === undefined || now - cached.at >= revocationCacheMs) {
    const read = yield* store.revocations(userId, now).pipe(Effect.result);
    if (Result.isSuccess(read)) {
      items = read.success;
      remember(revocations, userId, { at: now, items });
    } else report(read.failure, "signins.revocations");
  }
  const sid = client.sid ?? null;
  const key = sessionKey(userId, client.clientId, sid);
  const refusal = items.find((item) => covers(item, client));
  const quiet = (operation: string) => (effect: Effect.Effect<void, Model.Failure>) =>
    effect.pipe(Effect.catch((error) => Effect.sync(() => report(error, operation))));
  if (refusal !== undefined) {
    // A per-`sid` sign-out stays in force while that sign-in keeps trying, at most one write a day.
    const last = extended.get(key);
    if (refusal.sid === null || sid === null || (last !== undefined && now - last < day))
      return { revoked: true, background: null } satisfies Admission;
    remember(extended, key, now);
    return {
      revoked: true,
      background: store
        .extend(
          userId,
          client.clientId,
          sid,
          now + sidRevocationDays * day,
          now + (sidRevocationDays - 1) * day,
        )
        .pipe(quiet("signins.extend")),
    } satisfies Admission;
  }
  const last = recorded.get(key);
  if (last !== undefined && now - last < recordInterval)
    return { revoked: false, background: null } satisfies Admission;
  remember(recorded, key, now);
  return {
    revoked: false,
    background: store
      .record(
        {
          id: crypto.randomUUID(),
          userId,
          clientId: client.clientId,
          sid,
          issuedAt: client.issuedAt * 1000,
          ...observed,
          at: now,
        },
        recordInterval,
        sessionCap,
      )
      .pipe(quiet("signins.record")),
  } satisfies Admission;
});

const iso = (millis: number) => M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(millis)));
const place = (row: Store.Row) =>
  row.country === null ? null : row.city === null ? row.country : `${row.city}, ${row.country}`;
const choices = (clientId: string, sid: string | null): ReadonlyArray<S.SignOutScope> =>
  !S.sharedClient(clientId) ? ["this"] : sid === null ? ["app"] : ["this", "app"];
const appName = (name: string | null | undefined, agent: string | null) =>
  name !== undefined && name !== null && name.length > 0
    ? name
    : (S.agentName(agent) ?? "Agent app");

/**
 * The person's sign-ins: what TalkTo recorded, named and completed from WorkOS's authorized
 * applications. If WorkOS cannot be asked, the recorded ones are listed with `provider: unavailable`.
 */
export const list = Effect.fn("SignIns.list")(function* (actor: Model.Actor) {
  const store = yield* Store.Store;
  const identity = yield* Platform.Identity;
  const rows = yield* store.active(actor.userId);
  const provided = yield* identity.authorizedApplications(actor.userId).pipe(Effect.result);
  const apps = Result.isSuccess(provided) ? provided.success : [];
  const byClient = new Map(apps.map((app) => [app.clientId, app]));
  const items: S.SignIn[] = rows.map((row) => ({
    id: S.SignInId.make(row.id),
    app: appName(byClient.get(row.clientId)?.name ?? row.clientName, row.agent),
    clientId: row.clientId,
    shared: S.sharedClient(row.clientId),
    place: place(row),
    agent: row.agent,
    firstSignedInAt: iso(row.firstSeenAt),
    lastActiveAt: iso(row.lastSeenAt),
    signOut: choices(row.clientId, row.sid),
  }));
  // Names WorkOS gave are kept for when it cannot be asked; each changes at most once.
  const named = new Set<string>();
  for (const row of rows) {
    const name = byClient.get(row.clientId)?.name;
    if (
      name === undefined ||
      name.length === 0 ||
      name === row.clientName ||
      named.has(row.clientId)
    )
      continue;
    named.add(row.clientId);
    yield* store.name(actor.userId, row.clientId, name);
  }
  const recordedClients = new Set(rows.map((row) => row.clientId));
  for (const app of apps)
    if (!recordedClients.has(app.clientId))
      items.push({
        id: S.SignInId.make(app.id),
        app: appName(app.name, null),
        clientId: app.clientId,
        shared: S.sharedClient(app.clientId),
        place: null,
        agent: null,
        firstSignedInAt: app.createdAt,
        lastActiveAt: null,
        signOut: choices(app.clientId, null),
      });
  return {
    items,
    provider: Result.isSuccess(provided) ? "ok" : "unavailable",
  } satisfies S.SignIns;
});

const notFound = () =>
  new Model.Failure({
    code: "not_found",
    message: "This sign-in is not one of yours, or it is already signed out. Reload the list.",
  });

/**
 * Sign out one sign-in. The revocation is written first, so MCP refuses the sign-in's tokens
 * within `revocationCacheMs` whatever happens next. Then WorkOS ends the app's authorization and
 * refresh tokens, so the app must sign in again. One copy of a shared (CIMD) app is signed out on
 * TalkTo's side only, by its `sid`: WorkOS can end only every copy at once, which `app` asks for.
 * If WorkOS fails, the sign-in stays listed and the request can be repeated.
 */
export const signOut = Effect.fn("SignIns.signOut")(function* (
  actor: Model.Actor,
  id: S.SignInId,
  scope: S.SignOutScope,
  settings: Settings,
) {
  const store = yield* Store.Store;
  const identity = yield* Platform.Identity;
  let clientId: string;
  let sid: string | null = null;
  if (id.startsWith("authorized_connect_app_")) {
    const app = (yield* identity.authorizedApplications(actor.userId)).find(
      (item) => item.id === id,
    );
    if (app === undefined) return yield* notFound();
    clientId = app.clientId;
  } else {
    const row = yield* store.find(actor.userId, id);
    if (row === null) return yield* notFound();
    clientId = row.clientId;
    sid = row.sid;
  }
  const shared = S.sharedClient(clientId);
  const now = yield* Clock.currentTimeMillis;
  if (shared && scope === "this") {
    if (sid === null)
      return yield* new Model.Failure({
        code: "invalid_input",
        message:
          "This app signs in the same way on every computer, so this sign-in can only be signed out with every copy of the app. Choose sign out everywhere.",
      });
    yield* store.revoke({
      userId: actor.userId,
      clientId,
      sid,
      at: now,
      expiresAt: now + sidRevocationDays * day,
    });
    forget(actor.userId);
    yield* store.signedOut({ userId: actor.userId, clientId, sid, at: now });
    return { scope, provider: "skipped" } satisfies S.SignedOut;
  }
  yield* store.revoke({
    userId: actor.userId,
    clientId,
    sid: null,
    at: now,
    expiresAt: now + settings.maxTokenLifetimeMs,
  });
  forget(actor.userId);
  yield* identity.revokeAuthorizedApplication(actor.userId, clientId).pipe(
    Effect.mapError((error) =>
      error.code === "identity_unavailable"
        ? new Model.Failure({
            code: "identity_unavailable",
            message:
              "TalkTo stopped this sign-in's current access but could not finish signing it out with the sign-in provider. Try again.",
          })
        : error,
    ),
  );
  yield* store.signedOut({ userId: actor.userId, clientId, sid: null, at: now });
  return { scope, provider: "revoked" } satisfies S.SignedOut;
});

/** The minute cron's retention: rows unseen for `retentionDays`, and expired revocations. */
export const prune = Effect.fn("SignIns.prune")(function* () {
  const store = yield* Store.Store;
  const now = yield* Clock.currentTimeMillis;
  return yield* store.prune(now - retentionDays * day, now, 500);
});
