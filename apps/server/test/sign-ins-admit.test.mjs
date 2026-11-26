import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { load } from "./sources.mjs";

/*
  How often MCP admission reads a person's sign-outs from D1 (Sentry TALKTO-SERVER-C): a failed
  read backs off instead of querying on every request, and one read serves the isolate's other
  requests that arrive while it runs.
*/

const SignIns = await load("../src/sign-ins/service.ts");
const Store = await load("../src/sign-ins/store.ts");
const Model = await load("../src/platform/model.ts");

const client = { clientId: "client_01CLAUDECODE", sid: "app_consent_laptop", issuedAt: 1 };
const observed = { agent: null, city: null, country: null };
const signedOut = { clientId: client.clientId, sid: client.sid, revokedAt: 0 };
const failure = () => new Model.Failure({ code: "storage_unavailable", message: "D1 overloaded" });

/** A store whose revocations read runs `read` and is counted; every write succeeds. */
const fake = (read) => {
  const calls = { reads: 0 };
  const layer = Layer.succeed(
    Store.Store,
    Store.Store.of({
      revocations: () => {
        calls.reads++;
        return read(calls.reads);
      },
      record: () => Effect.void,
      extend: () => Effect.void,
      active: () => Effect.succeed([]),
      find: () => Effect.succeed(null),
      revoke: () => Effect.void,
      signedOut: () => Effect.void,
      name: () => Effect.void,
      prune: () => Effect.succeed({ sessions: 0, revocations: 0 }),
    }),
  );
  return { calls, layer };
};
const admit = (user, reports = []) =>
  SignIns.admit(user, client, observed, (error, operation) => reports.push(operation));
const run = (effect, layer) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(layer, TestClock.layer()))));

test("a failed revocations read keeps the last list and reads again only after the back-off", async () => {
  SignIns.resetCaches();
  const { calls, layer } = fake((n) =>
    n === 1 ? Effect.succeed([signedOut]) : Effect.fail(failure()),
  );
  const reports = [];
  const decided = await run(
    Effect.gen(function* () {
      const out = [];
      out.push((yield* admit("user_alice", reports)).revoked);
      yield* TestClock.adjust(SignIns.revocationCacheMs);
      // D1 fails now: the sign-out read before stays in force, and the next requests do not query.
      for (let i = 0; i < 20; i++) out.push((yield* admit("user_alice", reports)).revoked);
      const duringBackoff = calls.reads;
      yield* TestClock.adjust(SignIns.revocationBackoffMs - 1);
      out.push((yield* admit("user_alice", reports)).revoked);
      const beforeBackoffEnds = calls.reads;
      yield* TestClock.adjust(1);
      out.push((yield* admit("user_alice", reports)).revoked);
      return { out, duringBackoff, beforeBackoffEnds, after: calls.reads };
    }),
    layer,
  );
  assert.ok(
    decided.out.every((revoked) => revoked),
    "the earlier sign-out stays refused",
  );
  assert.equal(decided.duringBackoff, 2, "one read, then one failed read for 20 requests");
  assert.equal(decided.beforeBackoffEnds, 2, "no read within the back-off");
  assert.equal(decided.after, 3, "one read once the back-off ends");
  assert.deepEqual(reports, ["signins.revocations", "signins.revocations"]);
});

test("a cold isolate whose first read fails admits, as before, and backs off too", async () => {
  SignIns.resetCaches();
  const { calls, layer } = fake(() => Effect.fail(failure()));
  const decided = await run(
    Effect.gen(function* () {
      const out = [];
      for (let i = 0; i < 10; i++) out.push((yield* admit("user_bob")).revoked);
      const backedOff = calls.reads;
      yield* TestClock.adjust(SignIns.revocationBackoffMs);
      yield* admit("user_bob");
      return { out, backedOff, after: calls.reads };
    }),
    layer,
  );
  assert.ok(decided.out.every((revoked) => !revoked));
  assert.equal(decided.backedOff, 1);
  assert.equal(decided.after, 2);
});

test(
  "requests that arrive while a read runs share it: one D1 query for K readers",
  { timeout: 10_000 },
  async () => {
    SignIns.resetCaches();
    const gate = Effect.runSync(Deferred.make());
    const { calls, layer } = fake((n) =>
      n === 1 ? Effect.succeed([]) : Deferred.await(gate).pipe(Effect.as([signedOut])),
    );
    const decided = await run(
      Effect.gen(function* () {
        yield* admit("user_carol");
        yield* TestClock.adjust(SignIns.revocationCacheMs);
        // The first re-read holds; K more requests arrive meanwhile and use the list it had.
        const first = yield* Effect.forkChild(admit("user_carol"));
        yield* Effect.yieldNow;
        const others = [];
        for (let i = 0; i < 8; i++) others.push((yield* admit("user_carol")).revoked);
        const whileReading = calls.reads;
        yield* Deferred.succeed(gate, undefined);
        const refreshed = (yield* Fiber.join(first)).revoked;
        // Its answer is in force for everyone at once, with no further query.
        const next = (yield* admit("user_carol")).revoked;
        return { others, whileReading, refreshed, next, after: calls.reads };
      }),
      layer,
    );
    assert.equal(decided.whileReading, 2, "one initial read and one shared re-read");
    assert.ok(
      decided.others.every((revoked) => !revoked),
      "the others used the list already read",
    );
    assert.equal(decided.refreshed, true);
    assert.equal(decided.next, true);
    assert.equal(decided.after, 2);
  },
);

test(
  "a cold isolate's concurrent first requests each read: none is admitted without a list",
  { timeout: 10_000 },
  async () => {
    SignIns.resetCaches();
    const gate = Effect.runSync(Deferred.make());
    const { calls, layer } = fake(() => Deferred.await(gate).pipe(Effect.as([signedOut])));
    const decided = await run(
      Effect.gen(function* () {
        const fibers = [];
        for (let i = 0; i < 4; i++) fibers.push(yield* Effect.forkChild(admit("user_dave")));
        yield* Effect.yieldNow;
        const reading = calls.reads;
        yield* Deferred.succeed(gate, undefined);
        return { reading, revoked: yield* Fiber.joinAll(fibers) };
      }),
      layer,
    );
    assert.equal(decided.reading, 4);
    assert.ok(decided.revoked.every((d) => d.revoked));
  },
);
