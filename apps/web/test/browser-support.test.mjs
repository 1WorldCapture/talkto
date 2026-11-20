import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

// Browsers from before 2023 lack these methods, and the build does not add them. One of them blanked
// the home page for an older browser on November 18, 2026 (Sentry TALKTO-WEB-F).
const missing =
  /\.(toSorted|toReversed|toSpliced|findLast|findLastIndex)\(|\b(Object|Map)\.groupBy\(|Promise\.withResolvers\(/;

test("the web app uses only methods its browsers have", async () => {
  const directory = new URL("../src/", import.meta.url);
  const files = (await readdir(directory, { recursive: true })).filter((name) =>
    /\.(ts|tsx)$/.test(name),
  );
  const found = [];
  for (const name of files) {
    const lines = (await readFile(new URL(name, directory), "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (missing.test(line)) found.push(`${name}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, []);
});
