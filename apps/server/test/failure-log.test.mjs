import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { load } from "./sources.mjs";

const { atStep, describeFailure, runtimeFlags, stepOf } = await load("../src/failure-log.ts");

class StoreFailure extends Schema.TaggedError()("FileStoreFailure", {
  message: Schema.String,
  operation: Schema.String,
  code: Schema.NullOr(Schema.String),
}) {}

test("an MCP failure log keeps the failure's shape and never its message", () => {
  const secret = "art_v1_0123456789abcdef";
  const text = "Secret plan alpha for General";
  const inner = new Error(`Bearer ${secret} rejected for ${text}`);
  const failure = new StoreFailure({
    message: `could not store report-${text}.pdf`,
    operation: "uploadUrl",
    code: "R2_403",
  });
  Object.defineProperty(failure, "cause", { value: inner });
  const logged = describeFailure(failure);
  assert.deepEqual(logged, {
    failure: "FileStoreFailure",
    code: "R2_403",
    operation: "uploadUrl",
    cause: { failure: "Error", code: null, operation: null },
  });
  const serialized = JSON.stringify(logged);
  for (const forbidden of [secret, text, "Bearer", "report-"])
    assert.ok(!serialized.includes(forbidden), forbidden);
});

test("free text in a tag, name, code or operation is dropped, not logged", () => {
  const error = new Error("body");
  error.name = "Message: Secret plan alpha";
  Object.assign(error, { code: "has spaces and words", operation: "x".repeat(200) });
  assert.deepEqual(describeFailure(error), {
    failure: "unknown",
    code: null,
    operation: null,
    cause: null,
  });
  assert.deepEqual(describeFailure("Secret plan alpha"), {
    failure: "unknown",
    code: null,
    operation: null,
    cause: null,
  });
  assert.deepEqual(describeFailure({ _tag: "Secret plan alpha" }).failure, "unknown");
});

test("Cloudflare's runtime flags are logged as booleans, never the message", () => {
  const text = "Durable Object overloaded: Secret plan alpha for General";
  const error = Object.assign(new Error(text), {
    retryable: true,
    overloaded: false,
    remote: true,
  });
  const logged = describeFailure(error);
  assert.deepEqual(logged, {
    failure: "Error",
    code: null,
    operation: null,
    retryable: true,
    overloaded: false,
    remote: true,
    cause: null,
  });
  assert.ok(!JSON.stringify(logged).includes("Secret plan alpha"));
  // A flag that is not a boolean is dropped, not stringified.
  const forged = Object.assign(new Error("x"), { retryable: "Secret plan alpha", remote: 1 });
  assert.deepEqual(runtimeFlags(forged), {});
  assert.deepEqual(describeFailure(forged), {
    failure: "Error",
    code: null,
    operation: null,
    cause: null,
  });
  // The flags of a wrapped Cloudflare error are kept one cause deep.
  const wrapped = new Error("outer", {
    cause: Object.assign(new Error(text), { overloaded: true }),
  });
  assert.deepEqual(describeFailure(wrapped).cause, {
    failure: "Error",
    code: null,
    operation: null,
    overloaded: true,
  });
});

test("the server-object call step a rejection came from is logged as a fixed word", () => {
  const error = Object.assign(new Error("Secret plan alpha"), { retryable: true });
  assert.equal(stepOf(error), null);
  assert.equal(describeFailure(error).step, undefined);
  atStep(error, "watch");
  // The innermost step is kept: an outer step does not relabel it.
  atStep(error, "invoke");
  assert.equal(stepOf(error), "watch");
  const logged = describeFailure(error);
  assert.equal(logged.step, "watch");
  assert.equal(logged.retryable, true);
  assert.ok(!JSON.stringify(logged).includes("Secret plan alpha"));
  // A rejection that is not an object cannot carry a step and is still described.
  atStep("Secret plan alpha", "invoke");
  assert.equal(stepOf("Secret plan alpha"), null);
  assert.equal(describeFailure("Secret plan alpha").step, undefined);
});
