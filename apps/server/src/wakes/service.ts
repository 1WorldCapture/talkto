import { Clock, Context, DateTime, Effect, Layer } from "effect";
import * as M from "@talkto/api/models";
import * as E from "@talkto/api/errors";
import * as W from "@talkto/api/wake";
import type * as A from "@talkto/api/agent";
import type * as U from "@talkto/api/updates";
import type { AccessContext } from "../access.js";
import * as Store from "../persistence.js";
import * as Updates from "../updates.js";
import * as Actors from "../actors.js";
import * as Reads from "../reads.js";
import * as Navigation from "../navigation.js";
import * as TalkTo from "../talkto.js";
import * as Policy from "./policy.js";
import * as Crypto from "./crypto.js";
import * as Transport from "./transport.js";
import * as Targets from "./store.js";
import * as McpEvents from "./mcp-events.js";
import { adapters } from "./kinds.js";
import { CallbackFailed, TargetLimit } from "./errors.js";
import { WakeSettings } from "./settings.js";
import * as Schedule from "./schedule.js";

type Base = E.ServerAccessDenied | E.StorageUnavailable;
type Selected =
  | E.ParticipantNotFound
  | E.NotAnAgent
  | E.ParticipantRemoved
  | E.ConversationNotFound
  | E.WrongConversationKind;
type Outcome<A, F = never> = Effect.Effect<M.Outcome<A>, Base | F>;
/** A subscription request after protocol parsing. */
export interface Subscribe {
  readonly arguments: W.EventArguments;
  readonly url: string;
  readonly secret: string;
  readonly ttlMs: number | null;
}
/**
 * Shared wake operations, used by the dashboard's HTTP routes, MCP tools, MCP events and the server
 * object's alarm.
 */
export interface Interface {
  /** TALKTO_WAKE_TOKENS=on: pasted Claude Code routine, Grok Bot and Town wakes can be added. */
  readonly tokensEnabled: boolean;
  /** Store a pasted fire URL and token for an explicitly named participant. */
  readonly create: (
    access: AccessContext,
    participantId: M.ParticipantId,
    input: W.Register,
  ) => Outcome<W.Wake, E.InvalidInput | Selected>;
  readonly revoke: (
    access: AccessContext,
    input: A.RevokeWake,
  ) => Outcome<W.Revoked, E.ParticipantNotFound | E.NotAnAgent | E.ParticipantRemoved>;
  readonly list: (
    access: AccessContext,
    input: A.ListWakes,
  ) => Outcome<W.List, E.ParticipantNotFound | E.NotAnAgent | E.ParticipantRemoved>;
  readonly subscribe: (
    access: AccessContext,
    input: Subscribe,
  ) => Effect.Effect<
    McpEvents.Subscribed,
    Base | E.InvalidInput | Selected | CallbackFailed | TargetLimit
  >;
  readonly unsubscribe: (
    access: AccessContext,
    input: Omit<Subscribe, "secret" | "ttlMs">,
  ) => Effect.Effect<void, Base>;
  /** How often TalkTo may wake this agent. Any server-access holder may read it. */
  readonly cadence: (
    access: AccessContext,
    participantId: M.ParticipantId,
  ) => Outcome<W.CadenceSetting, E.ParticipantNotFound | E.NotAnAgent | E.ParticipantRemoved>;
  /**
   * A person changes how often TalkTo may wake this agent. Only the human HTTP API calls this; no
   * MCP tool does, because a shared MCP connection cannot tell one agent from another.
   */
  readonly setCadence: (
    access: AccessContext,
    participantId: M.ParticipantId,
    input: W.SetCadence,
  ) => Outcome<W.CadenceSetting, E.ParticipantNotFound | E.NotAnAgent | E.ParticipantRemoved>;
  /**
   * A person sends one test wake to a pasted target, through the same adapter and transport as a
   * real wake, and reads the answer in `lastTest`. Each test starts a real run on the person's
   * account, so only the dashboard calls this; no MCP tool does. At most one test per
   * `Policy.testIntervalMs` (or the host's longer minimum), never within the host's minimum of a
   * real wake, and counted in the agent's wake budget. A test never moves the target's checkpoint,
   * due time, failures or last attempt, so the cadence is unchanged; the next real wake waits only
   * for the host's own minimum after it.
   */
  readonly test: (
    access: AccessContext,
    participantId: M.ParticipantId,
    wakeId: W.WakeId,
  ) => Outcome<
    W.Wake,
    E.InvalidInput | E.RateLimited | E.ParticipantNotFound | E.NotAnAgent | E.ParticipantRemoved
  >;
  /** Deliver every due target; returns when the next one is due, or null. */
  readonly deliver: () => Effect.Effect<number | null, E.StorageUnavailable>;
}
/** Wake application service. */
export class Wakes extends Context.Service<Wakes, Interface>()("@talkto/Wakes") {}

const iso = (ms: number) => M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(ms)));
const setting = (participantId: M.ParticipantId, cadence: M.WakeCadence): W.CadenceSetting => ({
  participantId,
  cadence,
  intervalSeconds: M.wakeCadenceSeconds[cadence],
});
const empty = <A>(data: A): M.Outcome<A> => ({
  data,
  included: { participants: [], conversations: [] },
});
const invalid = (message: string) => new E.InvalidInput({ message });
const binding = (serverId: M.ServerId, id: W.WakeId, kind: W.Kind) => `${serverId}/${id}/${kind}`;
const hourMs = 3_600_000;
const dayMs = 86_400_000;

/** What a stored code means, for the participant. */
const explain = (code: string | null, kind: W.Kind): string | null => {
  if (code === null) return null;
  if (code === "budget")
    return `This agent's wakes reached their limit (${Policy.participantHourlyBudget} an hour, ${Policy.participantDailyBudget} a day); the next wake waits for the next hour.`;
  if (code === "read_limit")
    return "This agent is at its read limit; the wake waits until it can read again.";
  if (code === "selection_unavailable")
    return "The agent or a chosen channel no longer exists. Add it again.";
  const repeated = code.startsWith("repeated:");
  const reason = repeated ? code.slice("repeated:".length) : code;
  const known = Policy.reasons.find((item) => item === reason);
  const text = known === undefined ? reason : Policy.describe(known, kind);
  return repeated ? `It failed several times in a row. ${text}` : text;
};
/** The latest test, in the words the person reads on the dashboard. */
const tested = (target: Targets.Target): W.TestResult | null => {
  if (target.lastTestAt === null || target.lastTestOutcome === null) return null;
  const at = iso(target.lastTestAt);
  const host = W.hostNames[target.kind];
  const outcome = target.lastTestOutcome;
  if (outcome === "accepted")
    return { at, accepted: true, message: `Test sent: ${host} accepted it (started a run).` };
  const known = Policy.reasons.find((item) => item === outcome);
  if (known === undefined)
    return { at, accepted: false, message: "The test didn't finish. Send another in a minute." };
  const text = Policy.describe(known, target.kind);
  return {
    at,
    accepted: false,
    message: `Test failed: ${text}${Policy.transient.has(known) ? " Try again in a few minutes." : ""}`,
  };
};
/** Seconds until `ms` from now, for a Retry-After: at least 1, at most an hour. */
const seconds = (ms: number) => Math.min(3600, Math.max(1, Math.ceil(ms / 1000)));
/** How long, in a few words, for a person waiting to test again. */
const wait = (ms: number) => {
  const s = seconds(ms);
  if (s < 60) return s === 1 ? "1 second" : `${s} seconds`;
  const m = Math.ceil(s / 60);
  return m === 1 ? "a minute" : `${m} minutes`;
};
const limited = (ms: number, message: string) =>
  new E.RateLimited({
    retryable: true,
    action: "retry_after",
    retryAfterSeconds: seconds(ms),
    scope: "participant",
    message,
  });
/** The participant's view of a target. Never the token and never the full URL. */
const view = (target: Targets.Target): W.Wake => ({
  wakeId: target.id,
  kind: target.kind,
  host: new URL(target.url).hostname,
  credentialHint: `…${target.hint}`,
  selection: target.selection,
  state: target.disabledAt === null ? "active" : "disabled",
  addedAt: iso(target.createdAt),
  lastSentAt: target.lastSentAt === null ? null : iso(target.lastSentAt),
  lastError: target.disabledAt === null ? explain(target.lastError, target.kind) : null,
  disabledReason: explain(target.disabledReason, target.kind),
  expiresAt: iso(target.expiresAt),
  minIntervalSeconds: Math.ceil(target.minIntervalMs / 1000),
  lastTest: tested(target),
});

/** Construct the wake service from persistence, its own store, and runtime ports. */
export const layer = Layer.effect(
  Wakes,
  Effect.gen(function* () {
    const persistence = yield* Store.Persistence;
    const store = yield* Targets.WakeStore;
    const sealer = yield* Crypto.WakeSealer;
    const transport = yield* Transport.WakeTransport;
    const settings = yield* WakeSettings;
    const reads = yield* Reads.Reads;
    const ids = yield* TalkTo.Identifiers;
    const schedule = yield* Schedule.WakeSchedule;
    const run = <A, F>(
      access: AccessContext,
      operation: string,
      body: (tx: Store.Session) => Effect.Effect<A, F>,
    ) =>
      persistence.transaction(operation, (tx) =>
        Effect.gen(function* () {
          const serverId = yield* tx.serverIdentity();
          const grant = yield* tx.grant(access.grantId);
          if (
            serverId !== access.serverId ||
            grant === null ||
            grant.principalKey !== access.principalKey ||
            grant.revokedAt !== null
          )
            return yield* new E.ServerAccessDenied({ message: "The server is unavailable." });
          return yield* body(tx);
        }),
      );
    // Wakes act for an agent; a person's participant is never one.
    const participant = (tx: Store.Session, id: M.ParticipantId) =>
      Actors.requireAgent(tx, id).pipe(Effect.asVoid);
    const sorted = (selection: U.Selection): U.Selection => ({
      channelIds: selection.channelIds.toSorted(),
      directChats: selection.directChats,
    });
    const unavailable = () => invalid("Wakes are not enabled on this deployment.");

    /** Settle one attempt's outcome against the kind's retry rules. */
    const settle = (
      target: Targets.Target,
      outcome: Transport.Outcome,
      through: number,
      at: number,
    ): Targets.Result => {
      const policy = adapters[target.kind].policy;
      const failed = (reason: Policy.Reason, retryAfterMs: number | null): Targets.Result =>
        target.failures + 1 >= policy.maxAttempts
          ? { _tag: "Disabled", at, reason: `repeated:${reason}` }
          : {
              _tag: "Failed",
              at,
              reason,
              retryAt:
                at +
                Math.max(
                  Policy.backoffMs(target.failures + 1),
                  policy.minIntervalMs,
                  retryAfterMs ?? 0,
                ),
            };
      switch (outcome._tag) {
        case "Delivered":
          return { _tag: "Sent", through, at, error: null };
        case "Uncertain":
          // Without an idempotency key a lost answer may still have started a run: never resend.
          return policy.retryOnTimeout
            ? failed("timeout", null)
            : { _tag: "Sent", through, at, error: "timeout" };
        case "Retry":
          return failed(outcome.reason, outcome.retryAfterMs);
        case "Refused":
          return { _tag: "Disabled", at, reason: outcome.reason };
      }
    };

    const deliverOne = Effect.fn("Wakes.deliverOne")(function* (
      target: Targets.Target,
      at: number,
    ) {
      const adapter = adapters[target.kind];
      // A person's test started a run moments ago: the host's own minimum still applies to it.
      if (target.lastTestAt !== null && target.lastTestAt + target.minIntervalMs > at) {
        yield* store.defer(target.id, target.lastTestAt + target.minIntervalMs);
        return;
      }
      const prepared = yield* persistence.transaction("wakes.prepare", (tx) =>
        Effect.gen(function* () {
          const grant = yield* tx.grant(target.grantId);
          // The grant is checked again on every wake: revoking it ends the wake.
          if (grant === null || grant.revokedAt !== null) {
            yield* store.remove(target.participantId, target.id);
            return null;
          }
          const head = yield* tx.updatesHead();
          if (head.generation !== target.generation) {
            yield* store.rebase(target.id, head.generation, head.sequence);
            return null;
          }
          const usable = yield* Updates.checkSelection(
            tx,
            target.participantId,
            target.selection,
          ).pipe(
            Effect.as(true),
            Effect.catchTags({
              ParticipantNotFound: () => Effect.succeed(false),
              NotAnAgent: () => Effect.succeed(false),
              ParticipantRemoved: () => Effect.succeed(false),
              ConversationNotFound: () => Effect.succeed(false),
              WrongConversationKind: () => Effect.succeed(false),
            }),
          );
          if (!usable) {
            yield* store.record(target.id, {
              _tag: "Disabled",
              at,
              reason: "selection_unavailable",
            });
            return null;
          }
          const tally = yield* tx.signalTally({
            ...target.selection,
            participantId: target.participantId,
            boundary: target.deliveredThrough,
            limit: W.countLimit + 1,
          });
          if (tally.newest.length === 0) {
            yield* store.clearDue(target.id);
            return null;
          }
          const hour = Math.floor(at / hourMs);
          if (
            (yield* store.sent(target.participantId, hour)) >= Policy.participantHourlyBudget ||
            (yield* store.sent(target.participantId, hour - 23)) >= Policy.participantDailyBudget
          ) {
            yield* store.postpone(target.id, (hour + 1) * hourMs, "budget");
            return null;
          }
          const serverId = yield* tx.serverIdentity();
          const notice: W.Notice = {
            serverId,
            participantId: target.participantId,
            pending: Math.min(tally.newest.length, W.countLimit),
            urgent: Math.min(tally.urgent, W.countLimit),
            more: tally.newest.length > W.countLimit,
            checkpoint: Navigation.encodeCursor({
              version: 1,
              serverId,
              generation: head.generation,
              participantId: target.participantId,
              selection: target.selection,
              boundary: target.deliveredThrough,
              kind: "updates_checkpoint",
            }),
          };
          return {
            serverId,
            notice,
            through: head.sequence,
            access: { serverId, grantId: grant.id, principalKey: grant.principalKey },
          };
        }),
      );
      if (prepared === null) return;
      // A wake counts against the participant's own read limit, like a signal link check.
      const refused = yield* reads
        .admit(prepared.access, {
          operation: "wake",
          transport: "wake",
          participantId: target.participantId,
        })
        .pipe(
          Effect.as(null),
          Effect.catchTag("RateLimited", (error) => Effect.succeed(error.retryAfterSeconds)),
        );
      if (refused !== null) {
        yield* store.postpone(target.id, at + refused * 1000, "read_limit");
        return;
      }
      const opened = yield* sealer
        .open(target.sealed, binding(prepared.serverId, target.id, target.kind))
        .pipe(Effect.option);
      if (opened._tag === "None") {
        yield* store.record(target.id, { _tag: "Disabled", at, reason: "credential_unreadable" });
        return;
      }
      const attemptId = target.attemptId ?? `evt_${yield* Crypto.random(18)}`;
      const request = yield* adapter
        .request({
          notice: prepared.notice,
          wakeId: target.id,
          url: target.url,
          secret: opened.value,
          attemptId,
          at,
        })
        .pipe(Effect.option);
      if (request._tag === "None") {
        yield* store.record(target.id, { _tag: "Disabled", at, reason: "credential_unreadable" });
        return;
      }
      // Count the attempt and keep its ID before anything leaves, so an eviction mid-send cannot
      // turn into an uncounted or differently-identified resend.
      yield* persistence.transaction("wakes.attempt", () =>
        store
          .setAttempt(target.id, attemptId)
          .pipe(Effect.andThen(store.addSend(target.participantId, Math.floor(at / hourMs)))),
      );
      const outcome = yield* transport.post(request.value);
      yield* store.record(target.id, settle(target, outcome, prepared.through, at));
    });

    return Wakes.of({
      tokensEnabled: settings.tokens,
      create: Effect.fn("Wakes.create")(function* (access, participantId, input) {
        if (!settings.tokens)
          return yield* invalid(
            "Waking Claude Code routines, Grok Bot and Town is not enabled on this deployment.",
          );
        const adapter = adapters[input.kind];
        const checked = W.checkUrl(adapter.policy, input.url);
        if (checked._tag === "Refused") return yield* invalid(checked.problem);
        const tokenProblem = adapter.checkToken(input.token);
        if (tokenProblem !== null) return yield* invalid(tokenProblem);
        const id = W.WakeId.make(yield* ids.uuid());
        const identity = yield* Crypto.sha256(
          `token\n${access.serverId}\n${participantId}\n${input.kind}`,
        );
        const sealed = yield* sealer
          .seal(input.token, binding(access.serverId, id, input.kind))
          .pipe(Effect.mapError(unavailable));
        const at = yield* Clock.currentTimeMillis;
        const selection = sorted(input);
        const stored = yield* run(access, "wakes.create", (tx) =>
          Effect.gen(function* () {
            yield* Updates.checkSelection(tx, participantId, selection);
            const others =
              (yield* store.count(participantId, null)) -
              (yield* store.count(participantId, input.kind));
            if (others >= Policy.participantTargetLimit)
              return yield* invalid(
                `This agent already has ${Policy.participantTargetLimit} wakes. Revoke one it no longer needs.`,
              );
            const head = yield* tx.updatesHead();
            yield* store.removeExpired(at);
            yield* store.put({
              id,
              identity,
              kind: input.kind,
              participantId,
              grantId: access.grantId,
              url: checked.url.href,
              sealed,
              hint: input.token.slice(-4),
              selection,
              generation: head.generation,
              deliveredThrough: head.sequence,
              minIntervalMs: adapter.policy.minIntervalMs,
              createdAt: at,
              expiresAt: at + (input.ttlDays ?? W.defaultTtlDays) * dayMs,
            });
            return yield* store.byId(id);
          }),
        );
        if (stored === null) return yield* Effect.die("Stored wake is missing");
        return empty<W.Wake>(view(stored));
      }),
      revoke: Effect.fn("Wakes.revoke")(function* (access, input) {
        return yield* run(access, "wakes.revoke", (tx) =>
          participant(tx, input.participantId).pipe(
            Effect.andThen(store.remove(input.participantId, input.wakeId ?? null)),
            Effect.map((revoked) => empty<W.Revoked>({ revoked })),
          ),
        );
      }),
      list: Effect.fn("Wakes.list")(function* (access, input) {
        const at = yield* Clock.currentTimeMillis;
        return yield* run(access, "wakes.list", (tx) =>
          participant(tx, input.participantId).pipe(
            Effect.andThen(store.removeExpired(at)),
            Effect.andThen(
              Effect.all([store.list(input.participantId), tx.wakeCadence(input.participantId)]),
            ),
            Effect.map(([items, cadence]) => empty<W.List>({ items: items.map(view), cadence })),
          ),
        );
      }),
      subscribe: Effect.fn("Wakes.subscribe")(function* (access, input) {
        if (!settings.events) return yield* unavailable();
        const adapter = adapters.mcp_events;
        const checked = W.checkUrl(adapter.policy, input.url);
        if (checked._tag === "Refused") return yield* invalid(checked.problem);
        const secretProblem = adapter.checkToken(input.secret);
        if (secretProblem !== null) return yield* invalid(secretProblem);
        const args = input.arguments;
        const selection = sorted(args);
        const url = checked.url.href;
        // Deterministic over (principal, callback URL, event name, arguments), as the draft requires.
        const identity = yield* Crypto.sha256(
          [
            "events",
            access.principalKey,
            url,
            W.eventName,
            JSON.stringify({
              serverId: args.serverId,
              participantId: args.participantId,
              channelIds: selection.channelIds,
              directChats: selection.directChats,
            }),
          ].join("\n"),
        );
        const id = W.WakeId.make(`sub_${identity.slice(0, 32)}`);
        yield* run(access, "wakes.subscribe.check", (tx) =>
          Effect.gen(function* () {
            yield* Updates.checkSelection(tx, args.participantId, selection);
            if ((yield* store.byId(id)) !== null) return;
            if (
              (yield* store.count(args.participantId, "mcp_events")) >=
              Policy.participantSubscriptionLimit
            )
              return yield* new TargetLimit({ max: Policy.participantSubscriptionLimit });
            if ((yield* store.count(args.participantId, null)) >= Policy.participantTargetLimit)
              return yield* new TargetLimit({ max: Policy.participantTargetLimit });
          }),
        );
        // Prove the callback before storing anything.
        const at = yield* Clock.currentTimeMillis;
        const nonce = yield* Crypto.random(32);
        const challenge = yield* McpEvents.challenge(url, input.secret, nonce, at, id).pipe(
          Effect.mapError(() => invalid("delivery.secret is not usable.")),
        );
        const verified = yield* transport.verify(challenge, nonce);
        if (verified._tag === "Failed")
          return yield* new CallbackFailed({
            reason: Policy.eventCategory(verified.reason),
            detail: verified.reason,
            status: verified.status,
          });
        const sealed = yield* sealer
          .seal(input.secret, binding(access.serverId, id, "mcp_events"))
          .pipe(Effect.mapError(unavailable));
        const refreshBefore = at + McpEvents.ttl(input.ttlMs);
        const previous = yield* run(access, "wakes.subscribe", (tx) =>
          Effect.gen(function* () {
            yield* Updates.checkSelection(tx, args.participantId, selection);
            const head = yield* tx.updatesHead();
            const existing = yield* store.byId(id);
            yield* store.removeExpired(at);
            yield* store.put({
              id,
              identity,
              kind: "mcp_events",
              participantId: args.participantId,
              grantId: access.grantId,
              url,
              sealed,
              hint: input.secret.slice(-4),
              selection,
              generation: head.generation,
              // A refresh keeps counting from the last wake; a new subscription starts at now.
              deliveredThrough:
                existing !== null && existing.generation === head.generation
                  ? existing.deliveredThrough
                  : head.sequence,
              minIntervalMs: adapter.policy.minIntervalMs,
              createdAt: existing?.createdAt ?? at,
              expiresAt: refreshBefore + McpEvents.graceMs,
            });
            return existing;
          }),
        );
        const result: McpEvents.Subscribed = {
          resultType: "complete",
          id,
          refreshBefore: iso(refreshBefore),
          cursor: null,
          truncated: false,
        };
        if (previous === null) return result;
        const last = previous.disabledReason ?? previous.lastError;
        const reason = Policy.reasons.find((item) => last?.endsWith(item) ?? false);
        return {
          ...result,
          deliveryStatus: {
            active: true,
            lastDeliveryAt: previous.lastSentAt === null ? null : iso(previous.lastSentAt),
            lastError: reason === undefined ? null : Policy.eventCategory(reason),
          },
        };
      }),
      unsubscribe: Effect.fn("Wakes.unsubscribe")(function* (access, input) {
        const args = input.arguments;
        const selection = sorted(args);
        const url = URL.canParse(input.url) ? new URL(input.url).href : input.url;
        const identity = yield* Crypto.sha256(
          [
            "events",
            access.principalKey,
            url,
            W.eventName,
            JSON.stringify({
              serverId: args.serverId,
              participantId: args.participantId,
              channelIds: selection.channelIds,
              directChats: selection.directChats,
            }),
          ].join("\n"),
        );
        // Idempotent, and only ever this principal's own subscription.
        yield* run(access, "wakes.unsubscribe", () => store.removeIdentity(identity));
      }),
      cadence: Effect.fn("Wakes.cadence")(function* (access, participantId) {
        return yield* run(access, "wakes.cadence", (tx) =>
          participant(tx, participantId).pipe(
            Effect.andThen(tx.wakeCadence(participantId)),
            Effect.map((cadence) => empty(setting(participantId, cadence))),
          ),
        );
      }),
      setCadence: Effect.fn("Wakes.setCadence")(function* (access, participantId, input) {
        const at = yield* Clock.currentTimeMillis;
        const due = yield* run(access, "wakes.setCadence", (tx) =>
          participant(tx, participantId).pipe(
            Effect.andThen(tx.setWakeCadence(participantId, input.cadence, iso(at))),
            // A wake the old cadence was holding back may be due sooner now; none is delayed.
            Effect.andThen(store.advance(participantId, at)),
          ),
        );
        if (due !== null && settings.events) yield* schedule.arm(due);
        return empty(setting(participantId, input.cadence));
      }),
      test: Effect.fn("Wakes.test")(function* (access, participantId, wakeId) {
        if (!settings.tokens)
          return yield* invalid(
            "Waking Claude Code routines, Grok Bot and Town is not enabled on this deployment.",
          );
        // A test counts against the agent's own read limit, like every wake.
        yield* reads.admit(access, { operation: "wake_test", transport: "wake", participantId });
        const at = yield* Clock.currentTimeMillis;
        const gone = () => invalid("This Auto-start no longer exists. Add it again.");
        const prepared = yield* run(access, "wakes.test", (tx) =>
          Effect.gen(function* () {
            yield* participant(tx, participantId);
            const target = yield* store.byId(wakeId);
            if (target === null || target.participantId !== participantId || target.expiresAt <= at)
              return yield* gone();
            if (target.kind === "mcp_events")
              return yield* invalid(
                "ChatGPT proves its own subscription when it subscribes. There is nothing to test.",
              );
            if (target.disabledAt !== null)
              return yield* invalid(
                "This Auto-start is turned off. Add it again, then send a test.",
              );
            const host = W.hostNames[target.kind];
            // Checked and reserved in one transaction, so two clicks cannot both send.
            if (target.lastTestAt !== null) {
              const next =
                target.lastTestAt + Math.max(Policy.testIntervalMs, target.minIntervalMs) - at;
              if (next > 0)
                return yield* limited(
                  next,
                  `A test was just sent. You can send another in ${wait(next)}.`,
                );
            }
            if (target.lastAttemptAt !== null) {
              const next = target.lastAttemptAt + target.minIntervalMs - at;
              if (next > 0)
                return yield* limited(
                  next,
                  `TalkTo started ${host} moments ago. You can send a test in ${wait(next)}.`,
                );
            }
            // A real wake about to go out (or going out now) answers the same question.
            if (target.dueAt !== null && target.dueAt <= at + target.minIntervalMs) {
              const next = Math.max(target.dueAt, at) + target.minIntervalMs - at;
              return yield* limited(
                next,
                `TalkTo is starting ${host} for new messages now, and the result shows here. You can send a test in ${wait(next)}.`,
              );
            }
            const hour = Math.floor(at / hourMs);
            if (
              (yield* store.sent(participantId, hour)) >= Policy.participantHourlyBudget ||
              (yield* store.sent(participantId, hour - 23)) >= Policy.participantDailyBudget
            ) {
              const next = (hour + 1) * hourMs - at;
              return yield* limited(
                next,
                `This agent's wakes reached their limit (${Policy.participantHourlyBudget} an hour, ${Policy.participantDailyBudget} a day). You can send a test in ${wait(next)}.`,
              );
            }
            const grant = yield* tx.grant(target.grantId);
            if (grant === null || grant.revokedAt !== null) return yield* gone();
            const head = yield* tx.updatesHead();
            const serverId = yield* tx.serverIdentity();
            // Positioned at the newest message: a run that polls with it finds nothing new. The
            // target's own checkpoint (delivered_through) stays where the last real wake left it.
            const notice: W.TestNotice = {
              serverId,
              participantId,
              test: true,
              pending: 0,
              urgent: 0,
              more: false,
              checkpoint: Navigation.encodeCursor({
                version: 1,
                serverId,
                generation: head.generation,
                participantId,
                selection: target.selection,
                boundary: head.sequence,
                kind: "updates_checkpoint",
              }),
            };
            // Reserve before anything leaves, so an eviction mid-send still counts the test.
            yield* store.recordTest(target.id, at, "unfinished");
            yield* store.addSend(participantId, hour);
            return { target, notice, serverId };
          }),
        );
        const { target, notice, serverId } = prepared;
        const attemptId = `evt_${yield* Crypto.random(18)}`;
        const outcome = yield* sealer
          .open(target.sealed, binding(serverId, target.id, target.kind))
          .pipe(
            Effect.flatMap((secret) =>
              adapters[target.kind].request({
                notice,
                wakeId: target.id,
                url: target.url,
                secret,
                attemptId,
                at,
              }),
            ),
            Effect.flatMap(transport.post),
            Effect.map((answer): Targets.TestOutcome => {
              switch (answer._tag) {
                case "Delivered":
                  return "accepted";
                case "Uncertain":
                  return "timeout";
                case "Retry":
                case "Refused":
                  return answer.reason;
              }
            }),
            Effect.catchTag("SealBroken", () =>
              Effect.succeed<Targets.TestOutcome>("credential_unreadable"),
            ),
          );
        yield* store.recordTest(target.id, at, outcome);
        const stored = yield* store.byId(target.id);
        if (stored === null) return yield* gone();
        return empty<W.Wake>(view(stored));
      }),
      deliver: Effect.fn("Wakes.deliver")(function* () {
        const at = yield* Clock.currentTimeMillis;
        yield* store.removeExpired(at);
        const due = yield* store.due(at, Policy.passLimit);
        yield* Effect.forEach(
          due,
          (target) =>
            deliverOne(target, at).pipe(Effect.catchTag("StorageUnavailable", () => Effect.void)),
          { concurrency: 4, discard: true },
        );
        return yield* store.nextDue();
      }),
    });
  }),
);
