import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { plans, selfHosting } from "@talkto/api/pricing";
import { agentGuides, installGuideUrl } from "@talkto/api/agent-guides";
import { sitePages } from "../../web/src/site-pages.ts";
import { agentPages } from "../src/agents.ts";
import { placeholderOrigin, rootLlms } from "../src/llms.ts";
import { brandMisspellings, stale, testedClaim } from "../../web/test/copy-rules.mjs";

/*
  The root /llms.txt the docs build writes (src/llms.ts), checked in the built site (run after
  `astro build`): the llmstxt.org shape, every agent and docs page, and links only to pages that
  exist. apps/server/test/asset-routing.test.mjs fetches every link through the Worker.
*/

const dist = new URL("../dist/", import.meta.url);
const repo = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, repo), "utf8");
const llms = await readFile(new URL("root-llms.txt", dist), "utf8");

/** Paths the Worker serves itself (apps/server/src/hosted.ts). */
const workerPaths = ["/instructions", "/skill.md", "/llms-full.txt", "/openapi.json"];
/** Install files, one per Connect agents recipe (/agents/<id>.md, apps/server/src/hosted.ts). */
const installPath = /^\/agents\/[a-z][a-z0-9-]*\.md$/;

const links = (text) =>
  [...text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map(([, name, url]) => ({ name, url }));

/** A link's file in the built docs, or null when the link is not a docs page. */
const docsFile = (url) => {
  const path = url.slice(placeholderOrigin.length);
  return path.startsWith("/docs/") ? new URL(path.slice("/docs/".length), dist) : null;
};

test("llms.txt has the llmstxt.org shape: H1, summary, notes, then H2 lists of links", () => {
  const lines = llms.split("\n");
  assert.equal(lines[0], "# TalkTo");
  assert.match(lines[2], /^> \S/);
  const first = lines.findIndex((line) => line.startsWith("## "));
  assert.ok(first > 3, "notes before the first section");
  assert.doesNotMatch(lines.slice(1, first).join("\n"), /^#/m, "no headings in the notes");
  for (const line of lines.slice(first).filter((line) => line !== ""))
    assert.match(line, /^## \S|^- \[[^\]]+\]\([^)\s]+\)(: \S.*)?$/, line);
  const sections = lines.filter((line) => line.startsWith("## "));
  assert.equal(sections.at(-1), "## Optional", "Optional comes last");
  assert.equal(new Set(sections).size, sections.length, "each section once");
});

test("llms.txt lists every agent page and every docs page, under this deployment's origin", async () => {
  const urls = links(llms).map(({ url }) => url);
  for (const url of urls) assert.ok(url.startsWith(`${placeholderOrigin}/`), url);
  for (const { slug, name } of agentPages)
    assert.ok(
      urls.includes(`${placeholderOrigin}/docs/agents/${slug}/index.md`),
      `llms.txt lists ${name}`,
    );
  for (const { id, name } of agentGuides)
    assert.ok(
      urls.includes(installGuideUrl(placeholderOrigin, id)),
      `llms.txt lists ${name}'s file`,
    );
  const files = await readdir(dist, { recursive: true });
  // A self-hosted copy has no billing, so its index leaves out the hosted plans' page.
  const unlisted = process.env.TALKTO_SELF_HOSTED === "true" ? ["pricing/index.md"] : [];
  for (const file of files.filter((file) => file === "index.md" || file.endsWith("/index.md")))
    if (!unlisted.includes(file))
      assert.ok(urls.includes(`${placeholderOrigin}/docs/${file}`), `llms.txt lists /docs/${file}`);
});

test("llms.txt links only pages that exist", () => {
  const site = new Set(sitePages.map(({ path }) => path));
  for (const { url } of links(llms)) {
    const file = docsFile(url);
    const path = url.slice(placeholderOrigin.length);
    if (file !== null) assert.ok(existsSync(file), `${url}: no such docs file`);
    else
      assert.ok(
        workerPaths.includes(path) || installPath.test(path) || site.has(path),
        `${url}: not a page`,
      );
  }
});

test("llms.txt states prices only from pricing.ts, and none of the stale terms", () => {
  const prices = new Set(
    Object.values(plans).map((plan) => `$${(plan.monthlyCents / 100).toLocaleString("en-US")}`),
  );
  for (const [match] of llms.matchAll(/\$\d+(?:[,.]\d+)*/g))
    assert.ok(prices.has(match), `${match} is not a price in pricing.ts`);
  // A self-hosted build lists no prices; the last test checks that variant.
  if (process.env.TALKTO_SELF_HOSTED !== "true")
    for (const price of prices) assert.ok(llms.includes(price), `llms.txt names ${price}`);
  const prose = llms.replace(/\([^)]*\)|`[^`]*`/g, " ");
  // Tools' own "workspace" may appear in docs descriptions; TalkTo's grouping is the organization.
  for (const term of stale.filter((term) => term.source !== String.raw`\bworkspace`))
    assert.doesNotMatch(prose, term);
  assert.doesNotMatch(prose, testedClaim);
  assert.deepEqual(
    [...prose.matchAll(brandMisspellings)].map((m) => m[0]),
    [],
    "llms.txt writes agent names as their makers do (docs/brand-names.md)",
  );
});

test("a self-hosted copy's llms.txt leaves out the website and the hosted plans", async () => {
  const files = await readdir(dist, { recursive: true });
  const pages = await Promise.all(
    files
      .filter((file) => file === "index.md" || file.endsWith("/index.md"))
      .map(async (file) => {
        const markdown = await readFile(new URL(file, dist), "utf8");
        // The Markdown copy's frontmatter writes each value as a JSON string.
        const field = (name) => JSON.parse(new RegExp(`^${name}: (".*")$`, "m").exec(markdown)[1]);
        return {
          slug: file === "index.md" ? "index" : file.replace(/\/index\.md$/, ""),
          title: field("title"),
          description: field("description"),
          order: 0,
        };
      }),
  );
  const guide = await read("apps/server/src/instructions.md");
  const skill = await read("apps/server/src/skill.md");
  const hosted = rootLlms({ pages, guide, skill, selfHosted: false });
  const own = rootLlms({ pages, guide, skill, selfHosted: true });
  assert.match(hosted, /^## Pricing$/m);
  // Self-hosting under Apache 2.0 (November 19, 2026); no license is sold.
  assert.ok(hosted.includes(selfHosting.license), "hosted states the source license");
  assert.doesNotMatch(hosted, /yearly licenses|Self-Host License/);
  assert.doesNotMatch(own, /^## Pricing$/m);
  assert.doesNotMatch(own, /\$\d/);
  assert.match(own, /self-hosted: it has no billing and no message limits/);
  for (const { path } of sitePages) {
    assert.ok(hosted.includes(`](${placeholderOrigin}${path})`), `hosted lists ${path}`);
    assert.ok(!own.includes(`](${placeholderOrigin}${path})`), `self-hosted leaves out ${path}`);
  }
  for (const { slug } of agentPages)
    assert.ok(own.includes(`/docs/agents/${slug}/index.md`), `self-hosted lists ${slug}`);
});
