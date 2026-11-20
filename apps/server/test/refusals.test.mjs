import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./sources.mjs";

const { memory } = await load("../src/refusals.ts");

test("a remembered refusal answers with the server's seconds left until its retry time", () => {
  const remembered = memory(8);
  remembered.remember("caller", 1_000, 5, "refused", 1_200);
  assert.deepEqual(remembered.recall("caller", 1_200), { value: "refused", seconds: 5 });
  assert.deepEqual(remembered.recall("caller", 2_001), { value: "refused", seconds: 4 });
  assert.deepEqual(remembered.recall("caller", 5_999), { value: "refused", seconds: 1 });
  assert.equal(remembered.recall("caller", 6_000), null);
  assert.equal(remembered.recall("someone else", 1_200), null);
  // A clock that moved backwards forgets the refusal.
  remembered.remember("caller", 10_000, 5, "refused", 10_100);
  assert.equal(remembered.recall("caller", 9_999), null);
  assert.equal(remembered.recall("caller", 10_100), null);
  // A reply that arrives after its retry time is not remembered.
  remembered.remember("late", 0, 1, "refused", 1_000);
  assert.equal(remembered.recall("late", 1_000), null);
});

test("a long refusal is forgotten after a minute and still names the server's time left", () => {
  const remembered = memory(8);
  remembered.remember("budget", 0, 3600, "refused", 10);
  assert.deepEqual(remembered.recall("budget", 59_000), { value: "refused", seconds: 3541 });
  // Past a minute the next retry goes to the server object, which answers for itself.
  assert.equal(remembered.recall("budget", 60_000), null);
});

test("a full memory drops forgotten refusals first, then the oldest", () => {
  const remembered = memory(2);
  remembered.remember("first", 0, 2, "a", 0);
  remembered.remember("second", 0, 10, "b", 0);
  // "first" has passed its retry time, so it goes before the older live entry would.
  remembered.remember("third", 3_000, 10, "c", 3_000);
  assert.equal(remembered.recall("first", 3_000), null);
  assert.deepEqual(remembered.recall("second", 3_000), { value: "b", seconds: 7 });
  assert.deepEqual(remembered.recall("third", 3_000), { value: "c", seconds: 10 });
  // Nothing has expired: the oldest live refusal is dropped.
  remembered.remember("fourth", 3_000, 10, "d", 3_000);
  assert.equal(remembered.recall("second", 3_000), null);
  assert.deepEqual(remembered.recall("third", 3_000), { value: "c", seconds: 10 });
  assert.deepEqual(remembered.recall("fourth", 3_000), { value: "d", seconds: 10 });
  // Remembering a key again replaces it and makes it the newest.
  remembered.remember("third", 4_000, 10, "c2", 4_000);
  remembered.remember("fifth", 4_000, 10, "e", 4_000);
  assert.equal(remembered.recall("fourth", 4_000), null);
  assert.deepEqual(remembered.recall("third", 4_000), { value: "c2", seconds: 10 });
});
