import { Context, DateTime, Effect, Layer, Option, Result, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import * as E from "@talkto/api/email";
import * as Envelope from "@talkto/api/envelope";
import * as P from "@talkto/api/platform";
import * as Security from "@talkto/api/security";
import { trace } from "@talkto/telemetry/effect";
import * as PlatformHttp from "../platform/http.js";
import * as Telemetry from "../telemetry.js";
import * as PlatformModel from "../platform/model.js";
import * as Platform from "../platform/service.js";
import * as Store from "./d1.js";
import * as Fake from "./fake.js";
import * as Model from "./model.js";
import * as Resend from "./resend.js";
import * as Signing from "./signing.js";
import * as Email from "./service.js";

/*
  The Worker boundary for TalkTo's email: the settings API, the public unsubscribe page, the
  Resend webhook, the minute cron stage, and the queue hooks other parts of the server call.
*/

/** Addresses from the identity provider; a deleted user has none. */
const directory = (identity: Layer.Layer<Platform.Identity>) =>
  Layer.effect(
    Email.Directory,
    Effect.gen(function* () {
      const provider = yield* Platform.Identity;
      return Email.Directory.of({
        user: (userId) => {
          const id = Schema.decodeUnknownOption(P.UserId)(userId);
          if (Option.isNone(id)) return Effect.succeed(null);
          return provider.user(id.value).pipe(
            Effect.map((user) => ({ email: user.email, emailVerified: user.emailVerified })),
            Effect.catchTag("PlatformFailure", (error) =>
              error.code === "not_found"
                ? Effect.succeed(null)
                : Effect.fail(Model.failure("identity.user", "ambiguous")),
            ),
          );
        },
      });
    }),
  ).pipe(Layer.provide(identity));

/** The sender `TALKTO_EMAIL` selects. `off` has none. */
const sender = (settings: Model.Settings) => {
  switch (settings.mode) {
    case "fake":
      return Effect.succeed(Fake.layer);
    case "resend":
      return settings.resendApiKey === null
        ? Effect.fail(Model.failure("configuration.resend_api_key", "configuration"))
        : Effect.succeed(
            Resend.layer({
              apiKey: settings.resendApiKey,
              replyTo: settings.replyTo,
            }),
          );
    case "off":
      return Effect.fail(Model.failure("configuration.off", "configuration"));
  }
};

/** Whether TalkTo queues and sends email in this environment. */
export const enabled = Model.enabled;

/**
 * The cron stage. Off sends nothing and touches no storage. A configuration problem (a missing
 * secret) is reported every run until fixed, and nothing is sent meanwhile.
 */
export const synchronize = Effect.fn("EmailHttp.synchronize")(function* (
  env: Env,
  identity: Layer.Layer<Platform.Identity>,
) {
  const settings = yield* Model.settings(env);
  if (settings.mode === "off") return;
  const email = yield* sender(settings);
  const delivery = yield* Email.deliver(settings).pipe(
    Effect.provide([Store.layer(env.PLATFORM), email, directory(identity)]),
  );
  yield* Effect.logInfo("TalkTo email delivery", delivery);
  // Emails that ended unsent (refused by Resend, unconfirmed past their key, unrenderable) are
  // not retried. Seen without paging: counts only, never an address.
  if (delivery.failed > 0)
    Telemetry.failure(
      "email_unavailable",
      crypto.randomUUID(),
      Model.failure("delivery.ended_unsent", "refused"),
      "email",
      "warning",
    );
});

/**
 * Queue a usage warning. Called from the organization's quota object, off the message path. Does
 * nothing while email is off.
 */
export const queueAllowance = Effect.fn("EmailHttp.queueAllowance")(function* (
  env: Env,
  notice: Email.AllowanceNotice,
) {
  if (!(yield* Model.enabled(env))) return;
  yield* Email.queueAllowance(notice).pipe(Effect.provide(Store.layer(env.PLATFORM)));
});

/**
 * Hook for plugin version reporting (not wired yet): queue the "update your plugin" email to the
 * organization's owner. Safe to call on every report: one email per organization, plugin and latest
 * version. Does nothing while email is off.
 */
export const notifyPluginUpdateNeeded = Effect.fn("EmailHttp.notifyPluginUpdateNeeded")(function* (
  env: Env,
  notice: {
    readonly accountId: string;
    readonly plugin: string;
    readonly installed: string;
    readonly latest: string;
  },
) {
  if (!(yield* Model.enabled(env))) return;
  yield* Email.queuePluginUpdate(notice).pipe(Effect.provide(Store.layer(env.PLATFORM)));
});

/**
 * Queue the invitation email for one send of a server invitation. False, queuing nothing, while
 * email is off, so the inviter shares the link instead.
 */
export const queueServerInvitation = Effect.fn("EmailHttp.queueServerInvitation")(function* (
  env: Env,
  invitation: Parameters<typeof Email.queueInvitation>[0],
  inviter: string,
) {
  if (!(yield* Model.enabled(env))) return false;
  return yield* Email.queueInvitation(invitation, inviter).pipe(
    Effect.provide(Store.layer(env.PLATFORM)),
  );
});

/** Queue "<guest> joined <server>" to the inviter, once per invitation. Nothing while email is off. */
export const queueServerJoined = Effect.fn("EmailHttp.queueServerJoined")(function* (
  env: Env,
  invitation: Parameters<typeof Email.queueJoined>[0],
  guest: string,
) {
  if (!(yield* Model.enabled(env))) return;
  yield* Email.queueJoined(invitation, guest).pipe(Effect.provide(Store.layer(env.PLATFORM)));
});

const storageFailure = (meta: Envelope.Meta) =>
  PlatformHttp.failure(
    new PlatformModel.Failure({
      code: "storage_unavailable",
      message: "Email settings are temporarily unavailable. Try again.",
    }),
    meta,
  );
const respond = Effect.fn("EmailHttp.respond")(function* <A>(
  operation: (actor: PlatformModel.Actor) => Effect.Effect<A, Model.Failure>,
) {
  const { actor, meta } = yield* PlatformHttp.RequestContext;
  const data = yield* operation(actor).pipe(Effect.mapError(() => storageFailure(meta)));
  return { data, meta };
});
const handlers = HttpApiBuilder.group(E.Api, "email", (routes) =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    const stored = <A>(operation: Effect.Effect<A, Model.Failure, Store.Store>) =>
      Effect.provideService(operation, Store.Store, store);
    return routes.handleAll({
      preferences: () => respond((actor) => stored(Email.preferences(actor.userId))),
      updatePreferences: ({ payload }) =>
        respond((actor) => stored(Email.updatePreferences(actor.userId, payload.productUpdates))),
    });
  }),
);

/** Whether a path is the settings API. */
export const isPreferencesPath = (path: string) => path === "/v1/me/email";

/** The signed-in person's own email settings. Works whatever `TALKTO_EMAIL` says. */
export const handle = Effect.fn("EmailHttp.handle")(function* (
  request: Request,
  actor: PlatformModel.Actor,
  meta: Envelope.Meta,
  env: Env,
) {
  const web = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(E.Api).pipe(
      Layer.provide(handlers),
      Layer.provide(Store.layer(env.PLATFORM)),
      Layer.provide(
        Layer.succeed(
          Security.Authorization,
          Security.Authorization.of({ bearer: (effect) => effect, webSession: (effect) => effect }),
        ),
      ),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true, middleware: trace },
  );
  try {
    return yield* Effect.promise(() =>
      web.handler(request, Context.make(PlatformHttp.RequestContext, { actor, meta })),
    );
  } finally {
    yield* Effect.promise(() => web.dispose());
  }
});

/** Whether a path is the public unsubscribe page. */
export const isUnsubscribePath = (path: string) => path === "/email/unsubscribe";

const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const page = (status: number, title: string, body: string) =>
  new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${escape(title)} · TalkTo</title>
<style>
body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;background:#fff;color:#111}
main{max-width:480px;margin:0 auto;padding:64px 24px}
.brand{font-weight:700;font-size:15px;margin:0 0 32px}
h1{font-size:22px;line-height:1.3;margin:0 0 12px}
p{margin:0 0 16px;color:#444}
button{font:inherit;font-weight:600;padding:10px 16px;border:0;border-radius:6px;background:#111;color:#fff;cursor:pointer}
a{color:inherit}
@media (prefers-color-scheme: dark){body{background:#151515;color:#ededed}p{color:#a3a3a3}button{background:#ededed;color:#151515}}
</style>
</head>
<body><main><p class="brand">TalkTo</p>${body}</main></body>
</html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      },
    },
  );
const invalid = (origin: string) =>
  page(
    400,
    "Link not valid",
    `<h1>This unsubscribe link isn’t valid</h1><p>It may be incomplete. You can turn product updates off in your <a href="${escape(origin)}/app/account">account settings</a>.</p>`,
  );

/**
 * `GET` asks to confirm (mail scanners open links, so a visit changes nothing); `POST` unsubscribes,
 * from the page's button or from a mail app's RFC 8058 one-click request
 * (`List-Unsubscribe=One-Click`). Neither needs a sign-in: the signed token names the person.
 */
export const unsubscribePage = Effect.fn("EmailHttp.unsubscribe")(function* (
  request: Request,
  env: Env,
  body: string,
) {
  const url = new URL(request.url);
  const settings = yield* Model.settings(env).pipe(Effect.option);
  const origin = Option.isSome(settings) ? settings.value.origin : url.origin;
  const secret = Option.isSome(settings) ? settings.value.signingSecret : null;
  const token = url.searchParams.get("t") ?? "";
  if (request.method === "GET") {
    const userId = secret === null ? null : yield* Signing.readUnsubscribeToken(secret, token);
    if (userId === null) return invalid(origin);
    return page(
      200,
      "Unsubscribe",
      `<h1>Unsubscribe from TalkTo product updates?</h1><p>You’ll stop getting emails about new features and releases. Emails about your account, like usage and billing, still arrive.</p><form method="post" action="/email/unsubscribe?t=${escape(token)}"><button type="submit">Unsubscribe</button></form>`,
    );
  }
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
  const source =
    new URLSearchParams(body).get("List-Unsubscribe") === "One-Click"
      ? "one_click"
      : "unsubscribe_link";
  const done = yield* Email.unsubscribe(secret, token, source).pipe(
    Effect.provide(Store.layer(env.PLATFORM)),
    Effect.result,
  );
  if (Result.isFailure(done)) {
    Telemetry.failure(done.failure.code, crypto.randomUUID(), done.failure, "email");
    return page(
      503,
      "Try again",
      "<h1>That didn’t work</h1><p>TalkTo couldn’t save the change. Please try again in a minute.</p>",
    );
  }
  if (!done.success) return invalid(origin);
  return page(
    200,
    "Unsubscribed",
    `<h1>You’re unsubscribed</h1><p>TalkTo won’t send you product updates. Emails about your account still arrive. Changed your mind? Turn updates back on in your <a href="${escape(origin)}/app/account">account settings</a>.</p>`,
  );
});
/**
 * Resend's signed webhook. A bounce, complaint or provider suppression adds the address's keyed
 * hash to the suppression list, so TalkTo never emails it again. Other events are acknowledged.
 */
export const webhook = Effect.fn("EmailHttp.webhook")(function* (
  request: Request,
  env: Env,
  body: string,
) {
  const settings = yield* Model.settings(env).pipe(Effect.option);
  if (
    Option.isNone(settings) ||
    settings.value.resendWebhookSecret === null ||
    settings.value.signingSecret === null
  )
    return Response.json({ error: "Email webhooks are not configured." }, { status: 404 });
  const nowSeconds = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
  const event = yield* Resend.verifyWebhook(
    settings.value.resendWebhookSecret,
    request.headers,
    body,
    nowSeconds,
  );
  if (event === null) return Response.json({ error: "Invalid signature." }, { status: 400 });
  const reason = Schema.decodeUnknownOption(Resend.SuppressingEvent)(event.type);
  if (Option.isSome(reason)) {
    const applied = yield* Email.suppress(settings.value.signingSecret, {
      id: event.id,
      reason:
        reason.value === "email.bounced"
          ? "bounced"
          : reason.value === "email.complained"
            ? "complained"
            : "suppressed",
      to: event.to,
    }).pipe(Effect.provide(Store.layer(env.PLATFORM)), Effect.result);
    // Not saved: Resend retries the delivery. Reported, since an unsaved bounce could be emailed again.
    if (Result.isFailure(applied)) {
      Telemetry.failure(applied.failure.code, crypto.randomUUID(), applied.failure, "email");
      return Response.json({ error: "Try again." }, { status: 503 });
    }
  }
  return Response.json({ received: true });
});
