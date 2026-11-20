import { DateTime, Effect, Schema } from "effect";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as U from "@talkto/api/metering";
import * as Model from "./model.js";
import * as Configuration from "./configuration.js";
import * as FreePlan from "../free-plan.js";
import { free, serversPerOrganization } from "@talkto/api/pricing";

/** Paid billing observations feed the quota authority through private Cloudflare RPC. */
export const configure = Effect.fn("Metering.bindings")(function* (env: Env) {
  const settings = yield* Configuration.read(env);
  const read = Effect.fn("Metering.read")(function* (accountId: P.AccountId) {
    if (!Configuration.enabled(settings, accountId))
      return U.Usage.make({
        status: "unmetered",
        periodStart: null,
        periodEnd: null,
        allowance: 0,
        overdraft: 0,
        used: 0,
        outstanding: 0,
        usageUpperBound: 0,
        available: 0,
        lastReportedAt: null,
        asOf: M.Timestamp.make(DateTime.formatIso(DateTime.nowUnsafe())),
      });
    return yield* Effect.tryPromise({
      try: () => env.QUOTAS.getByName(accountId).read(),
      catch: () => Model.unavailable("read"),
    });
  });
  return Model.Quotas.of({
    publish: Effect.fn("Metering.publish")(function* (accountId, period) {
      if (!Configuration.enabled(settings, accountId) || period === null) return true;
      const result = yield* Effect.tryPromise({
        try: () =>
          env.QUOTAS.getByName(accountId).publish({
            accountId,
            start: period.start,
            end: period.end,
            kind: period.kind ?? "paid",
            ...(period.kind === "trial"
              ? { allowance: period.allowance, overdraft: 0 }
              : Configuration.limits(settings, accountId, period.allowance)),
          }),
        catch: () => Model.unavailable("publish", period.end),
      });
      return result.ok;
    }),
    revoke: Effect.fn("Metering.revoke")(function* (accountId, period) {
      if (!Configuration.enabled(settings, accountId)) return false;
      const result = yield* Effect.tryPromise({
        try: () => env.QUOTAS.getByName(accountId).revoke({ accountId, ...period }),
        catch: () => Model.unavailable("revoke"),
      });
      return result.ok;
    }),
    restore: Effect.fn("Metering.restore")(function* (accountId, start) {
      if (!Configuration.enabled(settings, accountId)) return;
      yield* Effect.tryPromise({
        try: () => env.QUOTAS.getByName(accountId).restore({ accountId, start }),
        catch: () => Model.unavailable("restore"),
      });
    }),
    publishStarter: Effect.fn("Metering.publishStarter")(function* (accountId, grant) {
      // The free start exists only where messages are counted; elsewhere nothing is opened.
      if (!Configuration.enabled(settings, accountId)) return false;
      const result = yield* Effect.tryPromise({
        try: () =>
          env.QUOTAS.getByName(accountId).publish({
            accountId,
            start: grant.start,
            end: null,
            allowance: grant.allowance,
            overdraft: 0,
            kind: "starter",
          }),
        catch: () => Model.unavailable("publish"),
      });
      return result.ok;
    }),
    publishFree: Effect.fn("Metering.publishFree")(function* (accountId, start) {
      if (!Configuration.enabled(settings, accountId)) return false;
      const result = yield* Effect.tryPromise({
        try: () =>
          env.QUOTAS.getByName(accountId).publish({
            accountId,
            start,
            end: M.Timestamp.make(
              DateTime.formatIso(DateTime.makeUnsafe(FreePlan.nextMonth(Date.parse(start)))),
            ),
            allowance: free.messages,
            overdraft: 0,
            kind: "free",
          }),
        catch: () => Model.unavailable("publish"),
      });
      return result.ok;
    }),
    addBonus: Effect.fn("Metering.addBonus")(function* (accountId, bonus) {
      // Where messages are not counted there is no allowance to add to.
      if (!Configuration.enabled(settings, accountId)) return "not_added" as const;
      const result = yield* Effect.tryPromise({
        try: () => env.QUOTAS.getByName(accountId).addBonus({ accountId, ...bonus }),
        catch: () => Model.unavailable("bonus"),
      });
      return result.outcome;
    }),
    readFree: Effect.fn("Metering.readFree")(function* (accountId) {
      if (!Configuration.enabled(settings, accountId)) return null;
      return yield* Effect.tryPromise({
        try: () => env.QUOTAS.getByName(accountId).free(),
        catch: () => Model.unavailable("read"),
      });
    }),
    readStarter: Effect.fn("Metering.readStarter")(function* (accountId) {
      if (!Configuration.enabled(settings, accountId)) return null;
      return yield* Effect.tryPromise({
        try: () => env.QUOTAS.getByName(accountId).starter(),
        catch: () => Model.unavailable("read"),
      });
    }),
    publishStorage: Effect.fn("Metering.publishStorage")(function* (accountId, period) {
      if (period === null) return;
      yield* Effect.tryPromise({
        try: () => env.QUOTAS.getByName(accountId).publishStoragePlan({ accountId, ...period }),
        catch: () => Model.unavailable("storage.publish", period.end),
      });
    }),
    read,
    readCounted: Effect.fn("Metering.readCounted")(function* (accountId) {
      if (!Configuration.enabled(settings, accountId)) return yield* read(accountId);
      const { usage, blocks } = yield* Effect.tryPromise({
        try: () => env.QUOTAS.getByName(accountId).readHeld(),
        catch: () => Model.unavailable("read"),
      });
      if (blocks.length === 0 || blocks.length > probeLimit) return usage;
      const local = yield* unreported(env.SERVERS, blocks);
      if (local === null) return usage;
      return { ...usage, counted: Math.min(usage.usageUpperBound, usage.used + local) };
    }),
  });
});

/** More open blocks than this (one per server) leave the range, not one ask per server. */
const probeLimit = serversPerOrganization;
const Unreported = Schema.NullOr(Schema.Struct({ id: M.RequestKey, used: M.Count }));
/**
 * What the servers holding `blocks` have committed against them but not reported: one read-only
 * ask per server. A server now on another block, or none, has reported that one (it adds 0). Any
 * failure means the count is not known (null).
 */
const unreported = (namespace: Env["SERVERS"], blocks: ReadonlyArray<Model.OpenBlock>) =>
  Effect.forEach(
    blocks,
    (block) =>
      Effect.tryPromise(() => namespace.getByName(block.serverId).unreportedUsage()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Unreported)),
        Effect.map((value) => (value?.id === block.id ? Math.min(block.capacity, value.used) : 0)),
      ),
    { concurrency: 8 },
  ).pipe(
    Effect.map((counts) => counts.reduce((sum, count) => sum + count, 0)),
    Effect.orElseSucceed(() => null),
  );
