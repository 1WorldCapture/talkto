import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { load } from "./sources.mjs";

const { describeFailure } = await load("../src/failure-log.ts");

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
