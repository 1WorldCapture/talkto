import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { experimental_readRawConfig, unstable_startWorker } from "wrangler";
import { load } from "./sources.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const raw = (name) => experimental_readRawConfig({ config: here(`../${name}`) }).rawConfig;

/** The hosted Worker's HTTP handler over the built site, with `routing`'s asset routing. */
async function startAssets(t, routing) {
  const directory = await mkdtemp(join(tmpdir(), "talkto-assets-"));
  const config = join(directory, "wrangler.jsonc");
  await writeFile(
    config,
    JSON.stringify({
      name: "talkto-asset-routing",
      main: here("asset-fixture.ts"),
      compatibility_date: routing.compatibility_date,
      compatibility_flags: routing.compatibility_flags,
      rules: routing.rules,
      assets: { ...routing.assets, directory: here("../../web/dist") },
    }),
  );
  const worker = await unstable_startWorker({
    config,
    dev: {
      remote: false,
      persist: false,
      watch: false,
      inspector: false,
      logLevel: "error",
      server: { hostname: "127.0.0.1", port: 0 },
    },
  });
  t.after(async () => {
    await worker.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const get = async (path, headers = {}) => {
    const response = await worker.fetch(`http://127.0.0.1${path}`, { redirect: "manual", headers });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, response, bytes, text: bytes.toString("utf8") };
  };
  return get;
}

// wrangler.jsonc's asset routing over the built site, with the hosted Worker's HTTP handler. Staging
// and production must route exactly as wrangler.jsonc does (production-config.private.test.mjs,
// in the private repository). `pnpm test` builds ../web/dist first.
test("unknown docs paths get the docs 404 page; site and dashboard routes keep their pages", async (t) => {
  const routing = raw("wrangler.jsonc");
  const Shell = await load("../src/shell.ts");
  for (const pattern of ["/app", "/app/*", "/onboarding"])
    assert.ok(
      routing.assets.run_worker_first.includes(pattern),
      `run_worker_first lacks ${pattern}`,
    );
  for (const path of ["/app", "/app/", "/app/accounts/a/servers/b", "/onboarding"])
    assert.ok(Shell.isShellPath(path), path);
  for (const path of ["/", "/apps", "/onboarding/x", "/docs/", "/setup"])
    assert.ok(!Shell.isShellPath(path), path);

  const get = await startAssets(t, routing);
  const shell = (await get("/")).text;
  assert.match(shell, /<div id="root"/);
  const docs404 = (await get("/docs/404")).text;
  assert.match(docs404, /Page not found/);
  assert.doesNotMatch(docs404, /<div id="root"/);

  for (const path of ["/docs/nope/", "/docs/nope", "/docs/agents/nope/", "/docs/_astro/nope.js"]) {
    const page = await get(path);
    assert.equal(page.status, 404, path);
    assert.equal(page.text, docs404, `${path} serves the docs site's own 404 page`);
  }
  for (const path of ["/docs/", "/docs/quickstart/", "/docs/agents/hermes/"]) {
    const page = await get(path);
    assert.equal(page.status, 200, path);
    assert.doesNotMatch(page.text, /<div id="root"/, path);
  }
  assert.equal((await get("/docs")).response.headers.get("location"), "/docs/");
  for (const path of ["/setup", "/access", "/pricing"]) {
    const page = await get(path);
    assert.equal(page.status, 200, path);
    assert.match(page.text, /<div id="root"/, path);
  }
  for (const path of ["/app", "/app/accounts/a/servers/b?tab=agents", "/onboarding"]) {
    const page = await get(path, { "sec-fetch-mode": "navigate", accept: "text/html" });
    assert.equal(page.status, 200, path);
    assert.equal(page.text, shell, `${path} serves the site shell`);
  }
  const etag = (await get("/app")).response.headers.get("etag");
  assert.ok(etag);
  assert.equal((await get("/app/x", { "if-none-match": etag })).status, 304);
  // Install files come from the Worker; the marks beside them under /agents/ stay static assets.
  assert.ok(
    routing.assets.run_worker_first.includes("/agents/*"),
    "run_worker_first lacks /agents/*",
  );
  const install = await get("/agents/claude-code.md");
  assert.equal(install.status, 200);
  assert.equal(install.response.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.ok(install.text.startsWith("# Install TalkTo in Claude Code\n"));
  assert.ok(install.text.includes("http://127.0.0.1/docs/agents/claude-code/"));
  const mark = await get("/agents/claude.svg");
  assert.equal(mark.status, 200);
  assert.match(mark.response.headers.get("content-type"), /^image\/svg\+xml/);
  assert.equal((await get("/agents/nope.md")).status, 404);
  // Outside /docs, unknown paths keep the shell, whose router shows "Page not found", now as a 404.
  const unknown = await get("/nope");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.text, shell);
});

// The root llms.txt (built by apps/docs/src/llms.ts, served by src/llms.ts): plain text with the
// request's origin, and every link it gives answers with a page.
test("llms.txt and llms-full.txt use the request's origin, and every link resolves", async (t) => {
  const routing = raw("wrangler.jsonc");
  for (const pattern of ["/llms.txt", "/llms-full.txt"])
    assert.ok(
      routing.assets.run_worker_first.includes(pattern),
      `run_worker_first lacks ${pattern}`,
    );
  const get = await startAssets(t, routing);
  const origin = "http://127.0.0.1";
  const unfilled = /YOUR-TALKTO-HOST|\{\{[A-Z_]+\}\}/;
  const index = await get("/llms.txt");
  assert.equal(index.status, 200);
  assert.equal(index.response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(index.text, /^# TalkTo\n\n> /);
  assert.doesNotMatch(index.text, unfilled);
  const full = await get("/llms-full.txt");
  assert.equal(full.status, 200);
  assert.equal(full.response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.ok(full.text.startsWith(index.text), "llms-full.txt starts with the index");
  assert.match(full.text, /^# TalkTo agent documentation$/m, "then the agent guide");
  assert.doesNotMatch(full.text, unfilled);
  const links = [...index.text.matchAll(/\]\(([^)]+)\)/g)].map(([, url]) => url);
  assert.ok(links.length > 30, "llms.txt links its pages");
  for (const url of links) {
    assert.ok(url.startsWith(`${origin}/`), `${url} is on this deployment`);
    assert.equal((await get(url.slice(origin.length))).status, 200, `${url} resolves`);
  }
});

// The icons (drawn by tools/icons.mjs) are static assets at the root, so browsers that ask for
// /favicon.ico without reading the page get a real icon, not the 404 shell. Every page links them.
test("the favicons, touch icon and manifest are served with their types and linked from every page", async (t) => {
  const routing = raw("wrangler.jsonc");
  const get = await startAssets(t, routing);
  const icons = {
    "/favicon.ico": "image/vnd.microsoft.icon",
    "/favicon.svg": "image/svg+xml",
    "/apple-touch-icon.png": "image/png",
    "/icon-192.png": "image/png",
    "/icon-512.png": "image/png",
    "/manifest.webmanifest": "application/manifest+json",
  };
  for (const [path, type] of Object.entries(icons)) {
    assert.ok(!routing.assets.run_worker_first.includes(path), `${path} is a static asset`);
    const icon = await get(path);
    assert.equal(icon.status, 200, path);
    assert.equal(icon.response.headers.get("content-type"), type, path);
    assert.deepEqual(icon.bytes, await readFile(here(`../../web/dist${path}`)), path);
  }
  const ico = (await get("/favicon.ico")).bytes;
  assert.deepEqual([ico.readUInt16LE(2), ico.readUInt16LE(4)], [1, 2], "an ICO with two images");
  assert.deepEqual([ico[6], ico[22]], [16, 32], "at 16 and 32 px");
  const manifest = JSON.parse((await get("/manifest.webmanifest")).text);
  for (const purpose of ["any", "maskable"])
    for (const size of ["192x192", "512x512"])
      assert.ok(
        manifest.icons.some((icon) => icon.purpose === purpose && icon.sizes === size),
        `the manifest has a ${purpose} icon at ${size}`,
      );
  for (const { src } of manifest.icons) assert.equal((await get(src)).status, 200, src);

  const links = [
    '<link rel="icon" href="/favicon.ico" sizes="32x32" />',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
    '<link rel="manifest" href="/manifest.webmanifest" />',
  ];
  const navigate = { "sec-fetch-mode": "navigate", accept: "text/html" };
  for (const path of ["/", "/teams", "/setup", "/access", "/pricing", "/terms", "/nope", "/app"]) {
    const page = await get(path, navigate);
    for (const link of links) assert.ok(page.text.includes(link), `${path} links ${link}`);
  }
  // The docs site (Nimbus) links its own copy, which is the same drawing.
  const docs = await get("/docs/");
  assert.match(docs.text, /<link rel="icon" type="image\/svg\+xml" href="\/docs\/favicon\.svg">/);
  assert.deepEqual((await get("/docs/favicon.svg")).bytes, (await get("/favicon.svg")).bytes);
});
