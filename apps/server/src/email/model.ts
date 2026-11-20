import { Config, ConfigProvider, Context, Effect, Option, Redacted, Schema } from "effect";

/*
  TalkTo's own email (docs/email.md). The application decides what to send and records it in the
  D1 outbox; this port only delivers a batch. Provider code (Resend) stays in its adapter.
*/

/**
 * What each email is about; account kinds cannot be turned off, product updates can. This is the
 * outbox's `kind` column, which migration 0015 constrains to these four values and which every
 * deployed Worker decodes when it claims a batch, so a new template never adds a value here: it
 * stores the closest class (`payment` for every other account email, as `plan_kept` does) and
 * names itself in its payload.
 */
export const Kind = Schema.Literals(["allowance", "payment", "plugin_update", "product_update"]);
/** Parsed email kind. */
export type Kind = typeof Kind.Type;

/** One rendered email to one person. `headers` carries List-Unsubscribe on product updates. */
export interface Message {
  /** The sender, chosen per kind: account emails and product updates use separate domains. */
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The template (`plan_kept`, `server_invitation`…), for the provider's tag and logs. */
  readonly kind: Template;
}

/** Every template's name; wider than `Kind`, which is only the outbox's class of email. */
export type Template = Kind | "plan_kept" | "server_invitation" | "server_joined";

/**
 * Why a delivery did not complete. `refused`, `rate_limited` and `quota` mean the provider sent
 * nothing; `ambiguous` means it may have (a timeout or server error), so only the same idempotency
 * key may retry it.
 */
export const Reason = Schema.Literals([
  "refused",
  "rate_limited",
  "quota",
  "unauthorized",
  "ambiguous",
  "configuration",
]);
/** Parsed failure reason. */
export type Reason = typeof Reason.Type;

/** A failed delivery or email operation. Never carries an address, a body or a credential. */
export class Failure extends Schema.TaggedError<Failure>()("EmailFailure", {
  code: Schema.Literal("email_unavailable"),
  reason: Reason,
  operation: Schema.String,
  httpStatus: Schema.NullOr(Schema.Int),
  message: Schema.String,
}) {}
/** Build a failure with a fixed, data-free message. */
export const failure = (operation: string, reason: Reason, httpStatus: number | null = null) =>
  new Failure({
    code: "email_unavailable",
    reason,
    operation,
    httpStatus,
    message:
      reason === "configuration"
        ? "Email is not configured. Check TALKTO_EMAIL and its secrets."
        : "Email could not be delivered now. The outbox keeps it and retries without sending twice.",
  });

/** The sending port. One call sends a batch; the same key never sends the same batch twice. */
export class Email extends Context.Service<
  Email,
  {
    /** Most messages one `send` accepts. */
    readonly maxBatch: number;
    /**
     * Send every message or none. Returns the provider's message IDs in order. Retrying with the
     * same `idempotencyKey` and the same messages returns the first result without sending again.
     */
    readonly send: (
      messages: ReadonlyArray<Message>,
      idempotencyKey: string,
    ) => Effect.Effect<ReadonlyArray<string>, Failure>;
  }
>()("@talkto/email/Email") {}

/**
 * `TALKTO_EMAIL`: `off` (the default everywhere: nothing is queued or sent), `fake` (the full flow
 * with an in-memory recorder, for local runs and tests) or `resend` (real delivery).
 */
export const Mode = Schema.Literals(["off", "fake", "resend"]);
/** Parsed switch value. */
export type Mode = typeof Mode.Type;

/** Everything email reads from the Worker environment. Secrets stay redacted. */
export interface Settings {
  readonly mode: Mode;
  /** Sender of account emails (usage, payment, plugin updates): `TALKTO_EMAIL_FROM_ACCOUNT`. */
  readonly fromAccount: string;
  /** Sender of product updates: `TALKTO_EMAIL_FROM_UPDATES`. */
  readonly fromUpdates: string;
  readonly replyTo: string | null;
  readonly origin: string;
  /** Signs unsubscribe tokens and keys the suppression list. Required unless `off`. */
  readonly signingSecret: Redacted.Redacted<string> | null;
  readonly resendApiKey: Redacted.Redacted<string> | null;
  readonly resendWebhookSecret: Redacted.Redacted<string> | null;
  /** Most emails one cron run sends; Resend's batch endpoint takes 100. */
  readonly batch: number;
  /** Most emails sent per UTC day, across every kind (Resend's free plan allows 100). */
  readonly dailyLimit: number;
}

const Address = Schema.String.check(
  Schema.isPattern(/^(?:[^<>\r\n]{1,64} <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+)$/),
);
const nonEmpty = (value: Option.Option<Redacted.Redacted<string>>) =>
  Option.isSome(value) && Redacted.value(value.value).length > 0 ? value.value : null;

/**
 * Default senders, one Resend sending domain each: account emails from mail.talkto.sh, product
 * updates from updates.talkto.sh, so a complaint about an update never touches account email.
 */
export const defaultFromAccount = "TalkTo <notifications@mail.talkto.sh>";
export const defaultFromUpdates = "TalkTo <updates@updates.talkto.sh>";

/**
 * Read the switch and its settings. Anything malformed turns email off rather than sending with a
 * guessed configuration; a missing secret is reported by the stage that needs it.
 */
export const settings = (env: Env) =>
  Config.all({
    mode: Config.schema(Mode, "TALKTO_EMAIL").pipe(Config.withDefault<Mode>("off")),
    fromAccount: Config.schema(Address, "TALKTO_EMAIL_FROM_ACCOUNT").pipe(
      Config.withDefault(defaultFromAccount),
    ),
    fromUpdates: Config.schema(Address, "TALKTO_EMAIL_FROM_UPDATES").pipe(
      Config.withDefault(defaultFromUpdates),
    ),
    replyTo: Config.option(Config.schema(Address, "TALKTO_EMAIL_REPLY_TO")),
    origin: Config.string("TALKTO_SERVICE_ORIGIN"),
    signingSecret: Config.option(Config.redacted("TALKTO_EMAIL_SIGNING_SECRET")),
    resendApiKey: Config.option(Config.redacted("TALKTO_RESEND_API_KEY")),
    resendWebhookSecret: Config.option(Config.redacted("TALKTO_RESEND_WEBHOOK_SECRET")),
    batch: Config.int("TALKTO_EMAIL_BATCH").pipe(Config.withDefault(100)),
    dailyLimit: Config.int("TALKTO_EMAIL_DAILY_LIMIT").pipe(Config.withDefault(1000)),
  }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Effect.map((value): Settings => ({
      mode: value.mode,
      fromAccount: value.fromAccount,
      fromUpdates: value.fromUpdates,
      replyTo: Option.getOrNull(value.replyTo),
      origin: value.origin,
      signingSecret: nonEmpty(value.signingSecret),
      resendApiKey: nonEmpty(value.resendApiKey),
      resendWebhookSecret: nonEmpty(value.resendWebhookSecret),
      batch: Math.min(Math.max(value.batch, 1), 100),
      dailyLimit: Math.max(value.dailyLimit, 0),
    })),
    Effect.mapError(() => failure("configuration.read", "configuration")),
  );

const Switch = Schema.Struct({ TALKTO_EMAIL: Schema.Literals(["fake", "resend"]) });
/** The same answer as `enabled`, synchronously, for Durable Object transactions. */
export const isEnabled = (env: Env) => Option.isSome(Schema.decodeUnknownOption(Switch)(env));

/** Whether TalkTo queues and sends email at all. Malformed configuration counts as off. */
export const enabled = (env: Env) =>
  settings(env).pipe(
    Effect.map((value) => value.mode !== "off"),
    Effect.orElseSucceed(() => false),
  );
