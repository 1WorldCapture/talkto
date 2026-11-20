import { Clock, Context, DateTime, Effect, Option, Redacted, Schema } from "effect";
import { productUpdatesByDefault } from "@talkto/api/email";
import type * as E from "@talkto/api/email";
import type * as B from "@talkto/api/billing";
import type * as G from "@talkto/api/guests";
import type * as M from "@talkto/api/models";
import type * as P from "@talkto/api/platform";
import * as Model from "./model.js";
import * as Store from "./d1.js";
import * as Signing from "./signing.js";
import * as Templates from "./templates.js";

/*
  What TalkTo emails, when, and to whom (docs/email.md). Queuing writes an outbox row keyed by
  what the email is about; delivery runs in the minute cron and claims rows before calling the
  provider, so a retry, a replayed webhook or an overlapping cron never sends one email twice.
*/

/** Where an email address comes from at send time: the identity provider, never D1. */
export class Directory extends Context.Service<
  Directory,
  {
    /** The person's address, or null when the user no longer exists. */
    readonly user: (
      userId: string,
    ) => Effect.Effect<
      { readonly email: string; readonly emailVerified: boolean } | null,
      Model.Failure
    >;
  }
>()("@talkto/email/Directory") {}

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const now = Clock.currentTimeMillis;
/** An unconfirmed batch is retried with its key until shortly before Resend forgets the key. */
const staleAfterMs = 10 * 60_000;
const idempotencyWindowMs = 23 * 60 * 60_000;
/** People queued per cron run for an announcement. */
const announcementSlice = 500;

/** Usage crossed 80% or 100% of a period's allowance. Recorded by the organization's quota object. */
export interface AllowanceNotice {
  readonly accountId: string;
  readonly periodStart: M.Timestamp;
  readonly periodEnd: M.Timestamp | null;
  readonly threshold: 80 | 100;
  readonly used: number;
  readonly allowance: number;
  readonly funding: "paid" | "trial" | "starter" | "free";
}

/** Queue the usage warning for an organization's owner, once per period and threshold. */
export const queueAllowance = Effect.fn("Email.queueAllowance")(function* (
  notice: AllowanceNotice,
) {
  const store = yield* Store.Store;
  yield* store.queueForOwner({
    key: `allowance:${notice.accountId}:${notice.periodStart}:${notice.threshold}`,
    kind: "allowance",
    accountId: notice.accountId,
    payload: JSON.stringify({
      kind: "allowance",
      accountId: notice.accountId,
      organization: "",
      threshold: notice.threshold,
      used: notice.used,
      allowance: notice.allowance,
      funding: notice.funding,
      periodEnd: notice.periodEnd,
    }),
    at: iso(yield* now),
  });
});

/**
 * Hook for plugin version reporting: email the organization's owner that a TalkTo plugin an agent
 * uses is out of date. Detection lives elsewhere; this only queues, once per organization, plugin
 * and latest version, so calling it on every report is safe.
 */
export const queuePluginUpdate = Effect.fn("Email.queuePluginUpdate")(function* (notice: {
  readonly accountId: string;
  readonly plugin: string;
  readonly installed: string;
  readonly latest: string;
}) {
  const store = yield* Store.Store;
  yield* store.queueForOwner({
    key: `plugin_update:${notice.accountId}:${notice.plugin}:${notice.latest}`,
    kind: "plugin_update",
    accountId: notice.accountId,
    payload: JSON.stringify({
      kind: "plugin_update",
      accountId: notice.accountId,
      organization: "",
      plugin: notice.plugin,
      installed: notice.installed,
      latest: notice.latest,
    }),
    at: iso(yield* now),
  });
});

/**
 * Queue one payment email per failed renewal. Stripe already emails the customer after each failed
 * card payment with a link to fix the card; TalkTo adds one email saying what that means here
 * (new messages are paused) and never repeats it per retry. The key names the subscription and the
 * end of its last paid month, which only a new failed renewal changes.
 */
export const queuePaymentProblems = Effect.fn("Email.queuePaymentProblems")(function* () {
  const store = yield* Store.Store;
  const problems = yield* store.paymentProblems();
  const at = iso(yield* now);
  yield* Effect.forEach(problems, (problem) =>
    store.queueForOwner({
      key: `payment:${problem.accountId}:${problem.subscriptionId}:${problem.paidThrough ?? "never"}`,
      kind: "payment",
      accountId: problem.accountId,
      payload: JSON.stringify({
        kind: "payment",
        accountId: problem.accountId,
        organization: "",
        plan: problem.plan satisfies B.Plan | null,
      }),
      at,
    }),
  );
  return problems.length;
});

/**
 * Queue one email per scheduled move that billing canceled because the organization had more
 * people than the smaller plan includes. The key names the subscription and renewal, so the
 * minute cron's repeats stay one email. Rows older than two days are left alone.
 */
export const queuePlanHolds = Effect.fn("Email.queuePlanHolds")(function* () {
  const store = yield* Store.Store;
  const started = yield* now;
  const holds = yield* store.planHolds(iso(started - 2 * 86400000));
  const at = iso(started);
  yield* Effect.forEach(holds, (hold) =>
    store.queueForOwner({
      key: `plan_kept:${hold.accountId}:${hold.subscriptionId}:${hold.at}`,
      kind: "payment",
      accountId: hold.accountId,
      payload: JSON.stringify({
        kind: "plan_kept",
        accountId: hold.accountId,
        organization: "",
        plan: hold.plan,
        kept: hold.kept,
        at: hold.at,
        people: hold.people,
      }),
      at,
    }),
  );
  return holds.length;
});

/**
 * Queue the invitation email for one send of a server invitation (docs/email.md, "Server
 * invitations"). The row's person is the invitation itself: the invited address may have no
 * account, so it is read from the invitation when the email is sent, never stored here. Each send
 * has its own key, so Resend is a new email and a repeat of one send is still one. The outbox
 * class is `payment` (an account email that cannot be turned off): see `Model.Kind`. True when
 * queued; false while the server or its organization is being deleted.
 */
export const queueInvitation = Effect.fn("Email.queueInvitation")(function* (
  invitation: {
    readonly id: G.InvitationId;
    readonly accountId: string;
    readonly serverId: string;
    readonly sends: number;
    readonly expiresAt: M.Timestamp;
  },
  inviter: string,
) {
  const store = yield* Store.Store;
  return yield* store.queueForServer({
    key: `server_invitation:${invitation.id}:${invitation.sends}`,
    kind: "payment",
    userId: invitation.id,
    accountId: invitation.accountId,
    serverId: invitation.serverId,
    payload: JSON.stringify({
      kind: "server_invitation",
      invitationId: invitation.id,
      sends: invitation.sends,
      server: "",
      organization: "",
      inviter,
      expiresAt: invitation.expiresAt,
    } satisfies Templates.Payload),
    at: iso(yield* now),
  });
});

/** Tell the person who sent an invitation that it was accepted: once per invitation. */
export const queueJoined = Effect.fn("Email.queueJoined")(function* (
  invitation: {
    readonly id: G.InvitationId;
    readonly accountId: P.AccountId;
    readonly serverId: M.ServerId;
    readonly inviterId: string;
  },
  guest: string,
) {
  const store = yield* Store.Store;
  return yield* store.queueForServer({
    key: `server_joined:${invitation.id}`,
    kind: "payment",
    userId: invitation.inviterId,
    accountId: invitation.accountId,
    serverId: invitation.serverId,
    payload: JSON.stringify({
      kind: "server_joined",
      invitationId: invitation.id,
      accountId: invitation.accountId,
      serverId: invitation.serverId,
      server: "",
      organization: "",
      guest,
    } satisfies Templates.Payload),
    at: iso(yield* now),
  });
});

/** The person's choices, with the default applied when they never chose. */
export const preferences = Effect.fn("Email.preferences")(function* (userId: string) {
  const store = yield* Store.Store;
  const stored = yield* store.preference(userId);
  return {
    productUpdates: stored ?? productUpdatesByDefault,
    accountEmails: "always",
  } satisfies E.EmailPreferences;
});

/** Turn product updates on or off from account settings. */
export const updatePreferences = Effect.fn("Email.updatePreferences")(function* (
  userId: string,
  productUpdates: boolean,
) {
  const store = yield* Store.Store;
  yield* store.setPreference(userId, productUpdates, "settings", iso(yield* now));
  return yield* preferences(userId);
});

/**
 * Unsubscribe the person a signed link names from product updates. Works without signing in and
 * whatever `TALKTO_EMAIL` says, so links in emails already sent keep working. False for a link that
 * is altered, foreign, or signed with another secret.
 */
export const unsubscribe = Effect.fn("Email.unsubscribe")(function* (
  secret: Redacted.Redacted<string> | null,
  token: string,
  source: "unsubscribe_link" | "one_click",
) {
  if (secret === null) return false;
  const userId = yield* Signing.readUnsubscribeToken(secret, token);
  if (userId === null) return false;
  const store = yield* Store.Store;
  yield* store.setPreference(userId, false, source, iso(yield* now));
  return true;
});

/** A verified provider event that stops future sends to its addresses. */
export const suppress = Effect.fn("Email.suppress")(function* (
  secret: Redacted.Redacted<string>,
  event: {
    readonly id: string;
    readonly reason: "bounced" | "complained" | "suppressed";
    readonly to: ReadonlyArray<string>;
  },
) {
  const store = yield* Store.Store;
  const at = iso(yield* now);
  if (!(yield* store.firstDelivery(event.id, at))) return;
  yield* Effect.forEach(event.to, (address) =>
    Signing.addressKey(secret, address).pipe(
      Effect.flatMap((key) => store.suppress(key, event.reason, at)),
    ),
  );
});

/** What one delivery run did, for logs and tests. Counts only, never people. */
export interface Delivery {
  readonly payments: number;
  readonly queued: number;
  readonly recovered: number;
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
  readonly limited: boolean;
}

const startOfUtcDay = (millis: number) => millis - (millis % 86_400_000);
const nextUtcDay = (millis: number) => startOfUtcDay(millis) + 86_400_000;

type Prepared =
  | { readonly _tag: "ended"; readonly row: Store.Row; readonly outcome: Store.Outcome }
  | { readonly _tag: "ready"; readonly row: Store.Row; readonly message: Model.Message };

/**
 * Turn one claimed row into an email, or into the reason it is not sent. `recheck` is false when a
 * batch is retried under its original key: the batch must be rebuilt exactly as first sent.
 */
const prepare = Effect.fn("Email.prepare")(function* (
  settings: Model.Settings,
  secret: Redacted.Redacted<string>,
  row: Store.Row,
  recheck: boolean,
  announcements: Map<string, Store.Announcement | null>,
): Effect.fn.Return<Prepared, Model.Failure, Store.Store | Directory> {
  const store = yield* Store.Store;
  const directory = yield* Directory;
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Templates.Payload))(row.payload);
  if (Option.isNone(decoded))
    return { _tag: "ended", row, outcome: { state: "failed", reason: "invalid_payload" } };
  const payload = decoded.value;
  let context: Templates.Context = { origin: settings.origin };
  const headers: Record<string, string> = {};
  if (payload.kind === "product_update") {
    if (recheck) {
      const choice = yield* store.preference(row.userId);
      if (!(choice ?? productUpdatesByDefault))
        return { _tag: "ended", row, outcome: { state: "skipped", reason: "unsubscribed" } };
    }
    if (!announcements.has(payload.announcementId))
      announcements.set(payload.announcementId, yield* store.announcement(payload.announcementId));
    const announcement = announcements.get(payload.announcementId) ?? null;
    if (announcement === null)
      return { _tag: "ended", row, outcome: { state: "failed", reason: "no_announcement" } };
    const url = `${settings.origin}/email/unsubscribe?t=${yield* Signing.unsubscribeToken(secret, row.userId)}`;
    context = { ...context, unsubscribeUrl: url, announcement };
    headers["List-Unsubscribe"] = `<${url}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  const ended = (state: "skipped" | "failed", reason: string): Prepared => ({
    _tag: "ended",
    row,
    outcome: { state, reason },
  });
  let to: string;
  if (payload.kind === "server_invitation") {
    // The invited address may belong to no one yet: it comes from the invitation, which must still
    // be open and this email its latest send. A retry under the original key rebuilds the batch.
    const invitation = yield* store.invitation(payload.invitationId);
    if (invitation === null) return ended("skipped", "no_invitation");
    if (recheck) {
      if (
        invitation.state !== "pending" ||
        invitation.expiresAt <= iso(yield* now) ||
        invitation.live !== 1
      )
        return ended("skipped", "invitation_closed");
      if (invitation.sends !== payload.sends) return ended("skipped", "superseded");
    }
    to = invitation.email;
  } else {
    const user = yield* directory.user(row.userId);
    if (user === null) return ended("skipped", "no_user");
    if (!user.emailVerified) return ended("skipped", "unverified");
    to = user.email;
  }
  if (recheck && (yield* store.suppressed(yield* Signing.addressKey(secret, to))))
    return ended("skipped", "suppressed");
  const rendered = Templates.render(payload, context);
  return {
    _tag: "ready",
    row,
    message: {
      from: row.kind === "product_update" ? settings.fromUpdates : settings.fromAccount,
      to,
      ...rendered,
      headers,
      kind: payload.kind,
    },
  };
});

/**
 * Send a claimed batch under its key and record the outcome. A refusal ends its rows; a sure
 * "nothing was sent" puts them back in the queue; an ambiguous failure leaves them claimed for the
 * stale-batch retry, which reuses the same key.
 */
const send = Effect.fn("Email.send")(function* (
  settings: Model.Settings,
  secret: Redacted.Redacted<string>,
  batchId: string,
  rows: ReadonlyArray<Store.Row>,
  recheck: boolean,
) {
  const store = yield* Store.Store;
  const email = yield* Model.Email;
  const announcements = new Map<string, Store.Announcement | null>();
  const prepared = yield* Effect.forEach(rows, (row) =>
    prepare(settings, secret, row, recheck, announcements),
  ).pipe(
    // The address lookup failed: nothing was sent, so the batch can wait for the next run.
    Effect.tapError(() =>
      recheck
        ? now.pipe(Effect.flatMap((millis) => store.release(batchId, millis + 60_000)))
        : Effect.void,
    ),
  );
  const ended = prepared.flatMap((item) => (item._tag === "ended" ? [item] : []));
  const ready = prepared.flatMap((item) => (item._tag === "ready" ? [item] : []));
  const at = iso(yield* now);
  yield* store.finish(batchId, ended, at);
  const result = { sent: 0, skipped: 0, failed: 0 };
  for (const item of ended)
    if (item.outcome.state === "skipped") result.skipped++;
    else result.failed++;
  if (ready.length === 0) return result;
  const outcome = yield* email
    .send(
      ready.map((item) => item.message),
      batchId,
    )
    .pipe(Effect.result);
  if (outcome._tag === "Success") {
    yield* store.finish(
      batchId,
      ready.map((item, index) => ({
        row: item.row,
        outcome: { state: "sent", providerId: outcome.success[index] ?? "unknown" },
      })),
      iso(yield* now),
    );
    return { ...result, sent: result.sent + ready.length };
  }
  const failure = outcome.failure;
  const millis = yield* now;
  switch (failure.reason) {
    case "refused":
      yield* store.finish(
        batchId,
        ready.map((item) => ({ row: item.row, outcome: { state: "failed", reason: "refused" } })),
        iso(millis),
      );
      return { ...result, failed: result.failed + ready.length };
    case "rate_limited":
      yield* store.release(batchId, millis + 60_000);
      return result;
    case "quota":
      yield* store.release(batchId, nextUtcDay(millis));
      return result;
    case "unauthorized":
    case "configuration":
      yield* store.release(batchId, millis + 15 * 60_000);
      return yield* failure;
    case "ambiguous":
      // Retried under the same key once the batch is stale; nothing for anyone to fix yet.
      yield* Effect.logWarning("TalkTo email batch unconfirmed; it is retried under its key", {
        operation: failure.operation,
        status: failure.httpStatus,
        emails: ready.length,
      });
      return result;
  }
});

/**
 * The minute cron's email stage: queue payment emails and the next slice of an announcement, retry
 * unconfirmed batches under their own keys, then send one new batch within the daily limit.
 */
export const deliver = Effect.fn("Email.deliver")(function* (settings: Model.Settings) {
  const store = yield* Store.Store;
  const email = yield* Model.Email;
  if (settings.signingSecret === null)
    return yield* Model.failure("configuration.signing_secret", "configuration");
  const secret = settings.signingSecret;
  // Billing emails: failed renewals and plans kept because of a people limit.
  const payments = (yield* queuePaymentProblems()) + (yield* queuePlanHolds());
  const announcement = yield* store.queuing();
  const queued =
    announcement === null
      ? 0
      : yield* store.queueAnnouncement(announcement, announcementSlice, iso(yield* now));
  const totals = { sent: 0, skipped: 0, failed: 0 };
  const add = (part: typeof totals) => {
    totals.sent += part.sent;
    totals.skipped += part.skipped;
    totals.failed += part.failed;
  };
  const started = yield* now;
  const stale = yield* store.stale(started - staleAfterMs);
  for (const batchId of stale) {
    const rows = yield* store.batch(batchId);
    const claimed = Math.min(...rows.map((row) => row.claimedAt ?? started));
    if (started - claimed > idempotencyWindowMs) {
      // Its key has expired: retrying could send twice, so it is recorded as never confirmed.
      yield* store.finish(
        batchId,
        rows.map((row) => ({ row, outcome: { state: "failed", reason: "unconfirmed" } })),
        iso(started),
      );
      totals.failed += rows.length;
      continue;
    }
    add(yield* send(settings, secret, batchId, rows, false));
  }
  const used = yield* store.sentSince(iso(startOfUtcDay(started)));
  const room = Math.min(settings.batch, email.maxBatch, settings.dailyLimit - used);
  if (room <= 0)
    return {
      payments,
      queued,
      recovered: stale.length,
      ...totals,
      limited: true,
    } satisfies Delivery;
  const batchId = crypto.randomUUID();
  const rows = yield* store.claim(batchId, started, room);
  if (rows.length > 0) add(yield* send(settings, secret, batchId, rows, true));
  return {
    payments,
    queued,
    recovered: stale.length,
    ...totals,
    limited: false,
  } satisfies Delivery;
});
