import assert from "node:assert/strict";
import { test } from "node:test";
import { experimental_readRawConfig } from "wrangler";
import { fileURLToPath } from "node:url";
import { load } from "./sources.mjs";

const Robots = await load("../src/robots.ts");
const here = (path) => fileURLToPath(new URL(path, import.meta.url));

test("production robots.txt opens public pages to every crawler, AI training included", () => {
  const text = Robots.body("https://talkto.sh", true);
  assert.match(text, /^User-agent: \*$/m);
  assert.match(text, /^Content-Signal: search=yes, ai-input=yes, ai-train=yes$/m);
  assert.match(text, /^Allow: \/$/m);
  for (const prefix of ["/app", "/auth", "/v1/", "/mcp"])
    assert.match(text, new RegExp(`^Disallow: ${prefix}$`, "m"), `closes ${prefix}`);
  assert.doesNotMatch(text, /^Disallow: \/$/m, "the site stays open");
  assert.doesNotMatch(
    text,
    /Disallow: \/(docs|agents|llms)/,
    "docs, agent files and llms.txt stay open",
  );
  assert.match(text, /^Sitemap: https:\/\/talkto\.sh\/docs\/sitemap-index\.xml$/m);
});

test("staging and self-hosted robots.txt close everything", async () => {
  assert.equal(Robots.body("https://example.test", false), "User-agent: *\nDisallow: /\n");
  const response = Robots.serve(
    new Request("https://example.test/robots.txt"),
    Robots.isProduction({ SENTRY_ENVIRONMENT: "self-hosted" }),
  );
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await response.text(), "User-agent: *\nDisallow: /\n");
});

test("production serve uses the production body", async () => {
  const response = Robots.serve(
    new Request("https://talkto.sh/robots.txt"),
    Robots.isProduction({ SENTRY_ENVIRONMENT: "production" }),
  );
  assert.match(await response.text(), /ai-train=yes/);
});

// Staging and production route exactly as wrangler.jsonc does (production-config.private.test.mjs,
// which stays in the private repository with those configs).
test("every deployment runs the Worker first for /robots.txt", () => {
  for (const name of ["wrangler.jsonc", "wrangler.selfhost.example.jsonc"]) {
    const config = experimental_readRawConfig({ config: here(`../${name}`) }).rawConfig;
    assert.ok(config.assets.run_worker_first.includes("/robots.txt"), `${name} routes /robots.txt`);
  }
});
