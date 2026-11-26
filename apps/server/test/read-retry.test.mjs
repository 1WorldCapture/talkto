import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit } from "effect";
import { load } from "./sources.mjs";

const R = await load("../src/read-retry.ts");

/** A rejection as Cloudflare flags a Durable Object call's. */
const rejection = (flags) => Object.assign(new Error("PRIVATE_RUNTIME"), flags);
/** An attempt that fails with these rejections in turn, then answers; it records each try. */
const attempts = (...rejections) => {
  const tries = [];
  const attempt = (fresh) =>
    Effect.suspend(() => {
      tries.push(fresh);
      const next = rejections.shift();
      return next === undefined ? Effect.succeed("page") : Effect.die(next);
    });
  return { tries, attempt };
};
const noPause = Effect.void;

test("a read that fails transiently once answers on a fresh stub, after one pause", async () => {
  const { tries, attempt } = attempts(rejection({ retryable: true, remote: true }));
  let paused = 0;
  const outcome = await Effect.runPromise(
    R.twice(
      attempt,
      Effect.sync(() => (paused += 1)),
    ),
  );
  assert.deepEqual(outcome, { kind: "answered", value: "page" });
  assert.deepEqual(tries, [false, true]);
  assert.equal(paused, 1);
});

test("a read that fails transiently twice is unavailable, never a third try", async () => {
  const second = rejection({ retryable: true });
  const { tries, attempt } = attempts(rejection({ retryable: true }), second);
  const outcome = await Effect.runPromise(R.twice(attempt, noPause));
  assert.equal(outcome.kind, "unavailable");
  assert.equal(outcome.defect, second);
  assert.deepEqual(tries, [false, true]);
});

test("an overloaded object, or a failure Cloudflare does not mark retryable, is not tried again", async () => {
  for (const flags of [{ retryable: true, overloaded: true }, { retryable: false }, {}]) {
    const failed = rejection(flags);
    const { tries, attempt } = attempts(failed);
    const exit = await Effect.runPromiseExit(R.twice(attempt, noPause));
    assert.ok(Exit.isFailure(exit), JSON.stringify(flags));
    assert.deepEqual(tries, [false], JSON.stringify(flags));
  }
  // A second failure that is not transient fails as it did before.
  const { attempt } = attempts(rejection({ retryable: true }), rejection({ overloaded: true }));
  assert.ok(Exit.isFailure(await Effect.runPromiseExit(R.twice(attempt, noPause))));
});

test("only reads are retried: no tool that writes is in the read set", () => {
  assert.deepEqual([...R.readTools].sort(), [
    "get_updates",
    "read_messages",
    "read_tasks",
    "read_transfer",
  ]);
  for (const tool of [
    "send_message",
    "create_channel",
    "register_participant",
    "claim_task",
    "update_task",
    "create_tasks",
    "prepare_transfer",
    "complete_transfer",
    "fetch_transfer",
    "get_context",
    "read_memory",
    "get_memory_access",
  ])
    assert.equal(R.readTools.has(tool), false, tool);
});

test("the default pause lasts between 100 and 300 ms", async () => {
  for (let n = 0; n < 5; n++) {
    const started = performance.now();
    await Effect.runPromise(R.pause);
    const took = performance.now() - started;
    assert.ok(took >= 95 && took < 400, String(took));
  }
});
