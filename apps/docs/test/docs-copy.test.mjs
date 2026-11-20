import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mcpEndpoint, renderDocumentation, setupSentence } from "@talkto/api/documentation";
import {
  free as freePlan,
  history,
  historyGigabytes,
  plans,
  readsLabel,
  serverHistoryGigabytes,
  starter,
  storageGigabytes,
  storageLabel,
} from "@talkto/api/pricing";
import { footerLinks } from "../src/footer.ts";
import { plansMarkdown } from "../src/generate.ts";
import { freePublished, freeSwitch, starterPublished, starterSwitch } from "../src/starter.ts";
import { agentPages, omittedSections, sharedSections } from "../src/agents.ts";
import { connectSections, siteOrigin } from "../src/guide.ts";
import {
  brandMisspellings,
  decode,
  stale,
  testedClaim,
  without,
  words,
} from "../../web/test/copy-rules.mjs";

/*
  The docs site's words, checked against the code, in the built site (run after `astro build`):
  every page's HTML and its Markdown copy. Facts: docs/site-facts.md; rules shared with the public
  site's test through apps/web/test/copy-rules.mjs.
*/

const dist = new URL("../dist/", import.meta.url);
const repo = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, repo), "utf8");
const guide = renderDocumentation(await read("apps/server/src/instructions.md"), siteOrigin);

/** Every built page: its path under /docs, its HTML and its Markdown copy. */
async function builtPages() {
  const files = await readdir(dist, { recursive: true });
  const pages = files
    .filter((file) => file === "index.md" || file.endsWith("/index.md"))
    .map((file) => file.replace(/index\.md$/, ""));
  return Promise.all(
    pages.map(async (dir) => ({
      path: `/docs/${dir}`,
      html: await readFile(new URL(`${dir}index.html`, dist), "utf8"),
      markdown: await readFile(new URL(`${dir}index.md`, dist), "utf8"),
    })),
  );
}
const pages = await builtPages();

const wordmark = /<a [^>]*class="tt-wordmark"[^>]*>talkto<i[^>]*><\/i><\/a>/g;
const footerLine = /<a class="tt-from"[^>]*>from Plannotator<\/a>/g;
const htmlCode = /<(code|pre)\b[^>]*>[\s\S]*?<\/\1>/g;
/** Not text at all: scripts, styles and templates. */
const htmlHidden = /<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/g;
const mdCode = /```[\s\S]*?```|`[^`\n]+`/g;
const urls = /https?:\/\/[^\s)<>"']+|\b[\w.-]+\.(?:sh|com|ai|dev|app)\/[^\s)<>"']*/g;
/** Prose a person reads: HTML text without code, the wordmark or the footer line. */
const htmlProse = (html) =>
  words(without(without(without(without(html, htmlHidden), htmlCode), wordmark), footerLine));
/** Prose an agent reads in the Markdown copy, without code. */
const mdProse = (markdown) => without(markdown, mdCode);
/** Code the docs show: fenced blocks and inline spans of the Markdown copy. */
const mdCodeText = (markdown) =>
  [...markdown.matchAll(mdCode)].map((m) => m[0].replace(/^```\w*\n?|```$|^`|`$/g, ""));

/*
  TalkTo's public source repository, which the docs header (astro.config.ts `github`) and the
  self-hosting page link and clone. Its address is a location, not the product named in a sentence;
  every other mention of Plannotator still fails.
*/
const sourceRepository =
  /https:\/\/github\.com\/plannotator\/talkto(?:\.git|\/[^\s)<>"'`]*)?(?![\w-])/g;

test("every page has one footer line and names Plannotator nowhere else", () => {
  for (const { path, html, markdown } of pages) {
    assert.equal(html.match(footerLine)?.length, 1, `${path}: one "from Plannotator" footer line`);
    for (const prose of [htmlProse(html), mdProse(markdown)].map((text) =>
      without(text, sourceRepository),
    ))
      assert.doesNotMatch(prose, /plannotator/i, `${path}: Plannotator only in the footer line`);
    for (const code of mdCodeText(markdown).map((text) => without(text, sourceRepository)))
      assert.doesNotMatch(code, /plannotator/i, `${path}: the plugin repository is talkto-sh`);
  }
});

test('the name in running text is "TalkTo"; lowercase only in the wordmark, code and names', () => {
  // `talkto` inside an identifier (talkto-hooks, talkto_follow, talkto.sh, talkto/SKILL.md) is a
  // name the tool uses, not the product name in a sentence.
  const bare = /(?<![\w./@-])talkto(?![\w./@-])/gi;
  for (const { path, html, markdown } of pages)
    for (const prose of [htmlProse(html), mdProse(markdown)])
      for (const [match] of prose.replace(urls, " ").matchAll(bare))
        assert.equal(match, "TalkTo", `${path}: "${match}" in running text`);
});

/*
  The one place the docs may say "encrypt": a single sentence on /docs/how-it-works/ that reports
  what Cloudflare's own data security pages document about the storage TalkTo uses (linked in the
  next sentence). It credits Cloudflare and claims nothing for TalkTo. Only this exact sentence on
  this page is exempt; the stale rule still applies to the rest of that page and to every other one.
*/
const cloudflareAtRest = {
  path: "/docs/how-it-works/",
  sentence:
    "Cloudflare documents that it encrypts all data that Durable Objects, D1 and R2 store, with AES-256 and keys that Cloudflare manages, and that data moving to and from them travels over TLS.",
};
const withoutAttributed = (path, prose) => {
  if (path !== cloudflareAtRest.path) return prose;
  assert.equal(
    prose.split(cloudflareAtRest.sentence).length,
    2,
    `${path}: the attributed sentence once`,
  );
  return prose.replace(cloudflareAtRest.sentence, " ");
};

/*
  The free trial, while production offers it: the one passage that may say "free" and "trial" and
  name its own message count (docs/site-facts.md, claims 49 to 52), above every plan table. Its
  words are checked in "the free trial is described only once it is published".
*/
/** The free trial's passage, or the Free plan's that replaces it (src/generate.ts `starterMarkdown`). */
const offerText =
  /Free trial: [\d,]+ messages\.[\s\S]*?Leftover messages carry over when you choose a plan\.|Free plan: [\d,]+ messages a month\.[\s\S]*?Nothing is charged automatically\./g;
const withoutOffer = (prose) => without(prose, offerText);

test("pages use the site's words, without stale or unsupported terms", () => {
  // The agent guide names other tools' "workspace" (VS Code, Antigravity); TalkTo's own grouping
  // is the organization. Every other stale term applies everywhere.
  const terms = stale.filter((term) => term.source !== String.raw`\bworkspace`);
  const ownWorkspace = /\b(?:TalkTo|your|organization|organization's) workspaces?\b/i;
  for (const { path, html, markdown } of pages)
    for (const prose of [htmlProse(html), mdProse(markdown)].map((text) =>
      withoutOffer(withoutAttributed(path, text)),
    )) {
      for (const term of terms) assert.doesNotMatch(prose, term, `${path}: ${term}`);
      assert.doesNotMatch(prose, ownWorkspace, `${path}: say "organization"`);
    }
});

const count = (n) => n.toLocaleString("en-US");
test("every price, message count, storage size and people limit is in pricing.ts", () => {
  const keys = Object.keys(plans);
  const prices = new Set(keys.map((key) => `$${plans[key].monthlyCents / 100}`));
  const messages = new Set(keys.map((key) => count(plans[key].messages)));
  // File pools, the Free plan's pool, and the history kept in place per organization and server.
  const pools = new Set([
    ...keys.map((key) => storageLabel(storageGigabytes[key])),
    storageLabel(freePlan.storageGigabytes),
    ...Object.values(historyGigabytes).map((gigabytes) => `${gigabytes} GB`),
    `${serverHistoryGigabytes} GB`,
  ]);
  const people = new Set(
    keys.flatMap((key) =>
      plans[key].peopleLimit === null ? [] : [String(plans[key].peopleLimit)],
    ),
  );
  for (const { path, html, markdown } of pages)
    for (const prose of [htmlProse(html), mdProse(markdown)].map(withoutOffer)) {
      for (const [match] of prose.matchAll(/\$\d[\d,.]*/g))
        assert.ok(prices.has(match), `${path}: ${match} is not a price in pricing.ts`);
      for (const [, count] of prose.matchAll(/([\d,]+) messages/g))
        assert.ok(messages.has(count), `${path}: ${count} messages is not in pricing.ts`);
      for (const [size] of prose.matchAll(/\d[\d,.]* [GT]B\b/g))
        assert.ok(pools.has(size), `${path}: ${size} is not a storage pool in pricing.ts`);
      for (const [, limit] of prose.matchAll(/up to (\d+) people/gi))
        assert.ok(people.has(limit), `${path}: up to ${limit} people is not a people limit`);
      // The plan table's People column: "| Up to 3 |".
      for (const [, limit] of prose.matchAll(/\| Up to (\d+) \|/g))
        assert.ok(people.has(limit), `${path}: up to ${limit} people is not a people limit`);
    }
  const pricing = pages.find(({ path }) => path === "/docs/pricing/");
  assert.ok(pricing, "a pricing page");
  for (const key of keys)
    for (const fact of [
      plans[key].name,
      `$${plans[key].monthlyCents / 100}`,
      `${count(plans[key].messages)} messages`,
      `${storageLabel(storageGigabytes[key])} storage`,
    ]) {
      assert.ok(htmlProse(pricing.html).includes(fact), `pricing page shows ${fact}`);
      assert.ok(pricing.markdown.includes(fact), `pricing Markdown shows ${fact}`);
    }
});

test("the plan table shows each plan's listed allowance and nothing on top", () => {
  const table = plansMarkdown(false);
  assert.match(
    table,
    /\| Shop \| \$12 \| 40,000 messages \| 2M reads a month — about 20 always-on agents \| 25 GB storage \|/,
  );
  assert.match(
    table,
    /\| Studio \| \$60 \| 250,000 messages \| 10M reads a month — about 100 always-on agents \| 100 GB storage \|/,
  );
  assert.match(
    table,
    /\| Factory \| \$150 \| 750,000 messages \| 20M reads a month — about 200 always-on agents \| 500 GB storage \|/,
  );
  // The dated beta bonus is gone (owner decision, November 16, 2026).
  assert.doesNotMatch(table, /beta|bonus|% more/i);
  // Each plan's reads a month, with the always-on gloss (owner decision, November 16, 2026).
  for (const key of ["shop", "studio", "factory"])
    assert.ok(table.includes(`| ${readsLabel(key)} |`), `${key}: ${readsLabel(key)}`);
});

/** MCP tool names registered in apps/server/src/mcp.ts, resolving imported name constants. */
async function mcpTools() {
  const source = await read("apps/server/src/mcp.ts");
  const modules = new Map(
    [...source.matchAll(/import \* as (\w+) from "@talkto\/api\/([\w-]+)"/g)].map((m) => [
      m[1],
      `packages/api/src/${m[2]}.ts`,
    ]),
  );
  const tools = new Set();
  for (const [, literal, alias, constant] of source.matchAll(
    /\n {2}tool\(\s*(?:"([a-z_]+)"|(\w+)\.(\w+)),/g,
  )) {
    if (literal) tools.add(literal);
    else {
      const module = await read(modules.get(alias));
      const value = new RegExp(`export const ${constant} = "([a-z_]+)"`).exec(module)?.[1];
      assert.ok(value, `mcp.ts: ${alias}.${constant} resolves to a tool name`);
      tools.add(value);
    }
  }
  return tools;
}

test("every MCP tool the docs name exists in apps/server/src/mcp.ts", async () => {
  const tools = await mcpTools();
  assert.ok(tools.has("get_context") && tools.has("get_updates"), "the tool registry was read");
  // Tool-shaped names: a verb, then words. The plugins' own tools carry a talkto_ prefix.
  const toolName =
    /^(?:get|register|read|send|create|set|share|prepare|complete|fetch|list|revoke)_[a-z_]+$/;
  for (const { path, markdown } of pages)
    for (const code of mdCodeText(markdown))
      if (toolName.test(code))
        assert.ok(tools.has(code), `${path}: \`${code}\` is not a tool in mcp.ts`);
});

test("install lines and the setup sentence match the agent guide and the site", async () => {
  // Every command the docs show is the agent guide's own line, or an update step from
  // documentation.ts (the guide installs; the updates page updates).
  const { hookUpdates, pluginUpdates } = await import("@talkto/api/documentation");
  const updateText = [...pluginUpdates, ...hookUpdates]
    .flatMap((item) => [...item.commands, item.then, item.autoUpdate])
    .join("\n");
  const command =
    /^(?:\/plugin|claude|codex|opencode|pi|grok|droid|amp|gemini|agy|copilot|devin|openclaw|hermes|muse|npx) /;
  for (const { path, markdown } of pages)
    for (const code of mdCodeText(markdown))
      for (const line of code.split("\n").filter((text) => command.test(text)))
        assert.ok(
          guide.includes(line) || updateText.includes(line),
          `${path}: "${line}" is not in the agent guide`,
        );
  // An SSH clone fails for anyone without a GitHub SSH key; the public repository needs none.
  assert.doesNotMatch(guide, /install git:git@/, "the guide installs over HTTPS, not SSH");

  const sentence = setupSentence(siteOrigin);
  const quickstart = pages.find(({ path }) => path === "/docs/quickstart/");
  assert.ok(quickstart?.markdown.includes(sentence), "Quickstart carries the setup sentence");
  for (const page of agentPages) {
    const built = pages.find(({ path }) => path === `/docs/agents/${page.slug}/`);
    assert.ok(built?.markdown.includes(sentence), `${page.slug}: the setup sentence`);
    assert.ok(built.markdown.includes(mcpEndpoint(siteOrigin)), `${page.slug}: the MCP endpoint`);
  }

  // The site's install lines (apps/web/src/landing-parts.tsx) all appear in the docs.
  const web = new URL("apps/web/", repo);
  const { createServer } = await import(
    createRequire(new URL("package.json", web)).resolve("vite")
  );
  const vite = await createServer({
    root: web.pathname,
    configFile: new URL("vite.config.ts", web).pathname,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    logLevel: "silent",
  });
  try {
    const { installLines, agentSentence, mcpUrl } =
      await vite.ssrLoadModule("/src/landing-parts.tsx");
    const all = pages.map(({ markdown }) => markdown).join("\n");
    for (const { lines } of installLines)
      for (const line of lines) assert.ok(all.includes(line), `the docs carry ${line}`);
    assert.equal(agentSentence, sentence, "the site and the docs send the same sentence");
    assert.equal(mcpUrl, mcpEndpoint(siteOrigin));
  } finally {
    await vite.close();
  }
});

test("every agent in the agent guide has a docs page, and every agent page has a guide section", () => {
  const headings = connectSections(guide).map(({ heading }) => heading);
  const used = new Set([
    ...agentPages.flatMap((page) => page.parts.map(({ heading }) => heading)),
    ...Object.values(sharedSections),
    ...omittedSections,
  ]);
  for (const heading of headings)
    assert.ok(
      used.has(heading),
      `instructions.md "### ${heading}" has no docs page: add it to apps/docs/src/agents.ts`,
    );
  for (const heading of used)
    assert.ok(
      headings.includes(heading),
      `apps/docs/src/agents.ts names "${heading}", not in the guide`,
    );
  // Each list item of the plugin and hooks sections lands on some agent page.
  for (const name of [sharedSections.plugins, sharedSections.hooks]) {
    const body = connectSections(guide).find(({ heading }) => heading === name)?.body ?? "";
    for (const [item] of body.matchAll(/^- [^:(]+/gm)) {
      const label = item.slice(2).trim();
      const pointer = /see "[^"]+" below/.test(
        body.split("\n").find((l) => l.startsWith(item)) ?? "",
      );
      assert.ok(
        pointer ||
          agentPages.some((page) => page.parts.some((part) => part.items?.includes(label))),
        `"${label}" in "${name}" is on no agent page`,
      );
    }
  }

  const built = new Set(
    pages.flatMap(({ path }) => {
      const slug = /^\/docs\/agents\/([^/]+)\/$/.exec(path)?.[1];
      return slug ? [slug] : [];
    }),
  );
  assert.deepEqual(
    [...built].sort(),
    agentPages.map(({ slug }) => slug).sort(),
    "one page per agent",
  );
  const index = pages.find(({ path }) => path === "/docs/agents/");
  for (const { slug, name } of agentPages) {
    assert.ok(
      index?.markdown.includes(`[${name}](${siteOrigin}/docs/agents/${slug}/)`),
      `index lists ${name}`,
    );
    assert.ok(index.html.includes(`href="/docs/agents/${slug}/"`), `index links ${name}`);
  }
});

test("every page writes agent names as their makers do (docs/brand-names.md)", () => {
  for (const { path, html, markdown } of pages)
    for (const prose of [htmlProse(html), mdProse(markdown)])
      assert.deepEqual(
        [...prose.matchAll(brandMisspellings)].map((m) => m[0]),
        [],
        `${path}: OpenCode and Pi, not opencode and pi`,
      );
});

test("no docs page shows a tested label", () => {
  for (const { path, html, markdown } of pages) {
    assert.doesNotMatch(html, /live[- ]tested/i, `${path}: no Live-tested label`);
    assert.doesNotMatch(markdown, /live[- ]tested/i, `${path}: no Live-tested label`);
    for (const prose of [htmlProse(html), mdProse(markdown)])
      assert.deepEqual(
        [...prose.matchAll(testedClaim)].map((m) => m[0]),
        [],
        `${path}: no tested claim`,
      );
  }
});

test("llms.txt lists every page and llms-full.txt carries them", async () => {
  const llms = await readFile(new URL("llms.txt", dist), "utf8");
  const sections = await Promise.all(
    ["agents", "guides", "concepts"].map((name) =>
      readFile(new URL(`${name}/llms.txt`, dist), "utf8"),
    ),
  );
  const full = await readFile(new URL("llms-full.txt", dist), "utf8");
  const index = [llms, ...sections].join("\n");
  for (const { path, markdown } of pages) {
    assert.ok(index.includes(`${siteOrigin}${path}index.md`), `llms.txt lists ${path}`);
    const title = /^title: "?(.+?)"?$/m.exec(markdown)?.[1];
    assert.ok(title && full.includes(`# ${decode(title)}`), `llms-full.txt carries ${path}`);
  }
});

test("agent page slugs are the site's mark IDs, so other pages can link by mark", async () => {
  const source = await read("packages/api/src/agent-guides.ts");
  const list = /export const brandMarks = \[([\s\S]*?)\] as const/.exec(source)?.[1] ?? "";
  const marks = [...list.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(marks.includes("claude") && marks.includes("mcp"), "brandMarks was read");
  for (const mark of marks.filter((id) => id !== "generic"))
    assert.ok(
      agentPages.some(({ slug }) => slug === mark),
      `no agent page at /docs/agents/${mark}/ for the "${mark}" mark`,
    );
  for (const { slug } of agentPages) assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});

test("agent pages link the guide sections they mention instead of pointing within the guide", () => {
  const headings = connectSections(guide).map(({ heading }) => heading);
  headings.push("Keep up while working", "Recover and finish");
  for (const page of pages.filter(({ path }) => path.startsWith("/docs/agents/"))) {
    const prose = mdProse(page.markdown);
    for (const heading of headings)
      assert.doesNotMatch(
        prose,
        new RegExp(
          `(see|follow) "${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"|"${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" (below|above)`,
          "i",
        ),
        `${page.path} points to the guide's "${heading}" section`,
      );
  }
});

/*
  "How TalkTo keeps your servers separate" (/docs/how-it-works/): its numbers and its account of
  what is shared come from the server's code and migrations. A new shared table, a changed
  lifetime or a new live test fails here until the page says so.
*/
const howItWorks = pages.find(({ path }) => path === "/docs/how-it-works/");
const howProse = howItWorks ? mdProse(howItWorks.markdown) : "";

test("how-it-works: the shared platform database holds the tables the page names, and no messages", async () => {
  assert.ok(howItWorks, "a /docs/how-it-works/ page");
  const dir = new URL("apps/server/src/platform/migrations/", repo);
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  const sql = (await Promise.all(files.map((file) => readFile(new URL(file, dir), "utf8")))).join(
    "\n",
  );
  const dropped = new Set([...sql.matchAll(/DROP TABLE (\w+)/g)].map((m) => m[1]));
  const tables = [...sql.matchAll(/CREATE (?:VIRTUAL )?TABLE (\w+)/g)]
    .map((m) => m[1])
    .filter((table) => !dropped.has(table))
    .sort();
  // Each table, as the page's "What is shared" list names it.
  const named = {
    accounts: "Organizations and their members",
    memberships: "Organizations and their members",
    servers: "The list of servers",
    server_access: "Who has access to each server",
    // Invitations to one server (docs/dashboard-api.md, "Server guests"): the address is kept until
    // 30 days after the invitation ends.
    server_invitations: "Server invitations",
    workspace_billing: "Billing",
    billing_operations: "Billing",
    stripe_events: "Billing",
    billing_periods: "Billing",
    billing_trials: "Billing",
    billing_plan_changes: "Billing",
    billing_revocations: "Billing",
    billing_plan_holds: "Billing",
    starter_grants: "Allowance eligibility",
    starter_claims: "Allowance eligibility",
    starter_observations: "Allowance eligibility",
    // Share links (docs/share-links-spec.md): codes, sign-ups and the free messages given.
    share_links: "Share links",
    share_referrals: "Share links",
    share_bonuses: "Share links",
    invitation_attempts: "Invitation email counts",
    account_deletions: "Deleted accounts",
    // TalkTo's own email (docs/email.md): preferences, send records, suppressions, announcements.
    email_preferences: "Email records",
    email_outbox: "Email records",
    email_suppressions: "Email records",
    email_announcements: "Email records",
    email_webhook_events: null,
    // Signed-in computers (docs/dashboard-api.md): where agent apps signed in, and sign-outs.
    mcp_client_sessions: "Signed-in computers",
    mcp_revocations: "Signed-in computers",
    // Feedback and bug reports (docs/feedback.md): from the dashboard and from agents.
    feedback: "Feedback",
    activity_progress: "The activity index",
    activity_events: "The activity index",
    // Internal bookkeeping, not customer content: the WorkOS event cursor and dashboard setup progress.
    identity_sync: null,
    user_onboarding: null,
    // The retired self-host license sales (Stripe IDs and GitHub accounts, written until
    // November 19, 2026; nothing writes them now). No organization's content.
    selfhost_licenses: null,
    selfhost_seats: null,
    // Cloudflare Access sign-in (docs/self-host-cloudflare-access.md): used only on a self-hosted
    // copy, so they stay empty on talkto.sh, which this page describes.
    local_users: null,
    local_organizations: null,
    local_memberships: null,
    local_invitations: null,
    local_identity_events: null,
  };
  assert.deepEqual(tables, Object.keys(named).sort(), "a new shared table: update the page");
  for (const phrase of Object.values(named))
    if (phrase) assert.ok(howProse.includes(phrase), `the page names "${phrase}"`);
  // No message words in the shared database: 0009 emptied and dropped the old search index.
  assert.match(
    await read("apps/server/src/platform/migrations/0009.sql"),
    /VALUES\('delete-all'\);\s*DROP TABLE activity_search;/,
  );
  assert.deepEqual(
    [...sql.matchAll(/CREATE VIRTUAL TABLE (\w+)/g)]
      .map((m) => m[1])
      .filter((t) => !dropped.has(t)),
    [],
    "no search index in the shared database",
  );
  assert.match(howProse, /It holds no message text and no words from messages\./);
  // Account search asks each server, at most serverLimit of them.
  const search = await read("apps/server/src/platform/activity-search.ts");
  assert.match(search, /export const serverLimit = 20;/);
  assert.match(howProse, /It asks your 20 most recently active servers at most\./);
  assert.doesNotMatch(sql, /CREATE TABLE messages\b/, "no message table in the shared database");
  // Messages and their search live in each server's own database.
  const server = await read("apps/server/src/migrations/0001.sql");
  assert.match(server, /CREATE TABLE messages \(/);
  assert.match(server, /CREATE VIRTUAL TABLE messages_fts USING fts5/);
  assert.match(server, /CREATE TRIGGER messages_immutable_delete/, "single messages stay");
  assert.match(
    await read("apps/server/src/platform/servers.ts"),
    /namespace\.getByName\(server\.id\)\.provision/,
    "one Durable Object per server ID",
  );
});

test("how-it-works: lifetimes and limits match the code", async () => {
  const transfers = await read("apps/server/src/files/transfers.ts");
  assert.match(transfers, /export const linkSeconds = 60 \* 60;/);
  assert.match(howProse, /links last one hour/);
  assert.match(transfers, /export const retentionSeconds = 30 \* 24 \* 60 \* 60;/);
  // The bucket's lifecycle rule does the deleting; the private repository's
  // apps/server/test/transfer-lifecycle.private.test.mjs ties the runbook's rule to this prefix.
  assert.match(
    transfers,
    /export const serverPrefix = \(serverId: M\.ServerId\) => `r30\/\$\{serverId\}\/`;/,
  );
  assert.match(
    howProse,
    /After 30 days a file can no longer be fetched, and a rule on the storage bucket deletes it\./,
  );

  const signal = await read("packages/api/src/signal.ts");
  assert.match(signal, /export const defaultTtlSeconds = 86_400;/);
  assert.match(signal, /maximum: 604_800/);
  assert.match(howProse, /24 hours by default and at most 7 days/);
  assert.match(await read("integrations/hooks/src/core.mjs"), /authorization: `Bearer \$\{/i);
  assert.match(
    howProse,
    /A hook sends the link's secret in a request header, not in the web address/,
  );

  // Production's cron runs every minute: docs-copy.private.test.mjs, with production's config.
  assert.match(howProse, /checks for membership changes every minute/);

  assert.match(await read("apps/server/src/wakes/crypto.ts"), /name: "AES-GCM"/);
  assert.match(
    await read("apps/server/src/migrations/0009.sql"),
    /hint TEXT NOT NULL CHECK \(length\(hint\) <= 4\)/,
  );
  assert.match(howProse, /sealed with AES-GCM/);
  assert.match(howProse, /last 4 characters/);
  assert.match(await read("apps/server/src/migrations/0008.sql"), /secret_hash TEXT NOT NULL/);
  assert.match(
    await read("apps/server/src/http.ts"),
    /if \(!website\)/,
    "only the dashboard adds an auto-start key",
  );
});

test("hooks, OpenClaw and Auto-start wake only for what concerns the agent, as the code does", async () => {
  // Signal counts say how many should wake; the hooks and OpenClaw wake only for those.
  assert.match(await read("packages/api/src/signal.ts"), /\bwaking: Schema\.Int/);
  assert.match(await read("integrations/hooks/src/core.mjs"), /wakingOf\(counts\) > 0/);
  assert.match(await read("integrations/hooks/src/core.mjs"), /wakingOf\(counts\) === 0/);
  assert.match(await read("integrations/openclaw/signals.mjs"), /wakingOf\(latest\) > 0/);
  assert.match(howProse, /how many should wake the agent/);
  assert.match(howProse, /It never returns message text, senders or channel names\./);

  const delivery = await read("apps/docs/src/content/docs/concepts/delivery.mdx");
  const readme = await read("README.md");
  for (const [name, text] of [
    ["delivery.mdx", delivery],
    ["the agent guide", guide],
    ["README.md", readme],
  ])
    assert.doesNotMatch(text, /cannot yet tell messages apart/, name);
  assert.match(
    delivery,
    /TalkTo wakes an agent for its direct messages, @mentions of it and TalkTo's own notices/,
  );
  assert.match(delivery, /TalkTo hooks and the OpenClaw plugin mention them with the agent's next/);
  assert.match(guide, /TalkTo hooks and the OpenClaw plugin do the same/);
  assert.match(readme, /TalkTo hooks and the OpenClaw plugin follow the same rule/);

  // Auto-start starts for direct chats and mentions with directChats "own", and for every
  // message only in the channels the person ticked: the rule markDue matches.
  assert.match(
    await read("apps/server/src/wakes/store.ts"),
    /EXISTS \(SELECT 1 FROM json_each\(channel_ids\) WHERE value=\?\)\s+OR \(direct_chats='own'/,
  );
  assert.match(delivery, /every message in the channels the person ticks there/);
  assert.match(await read("apps/web/src/agent-wakes.tsx"), /Every message in these channels:/);
});

test("how-it-works names no live check", () => {
  assert.doesNotMatch(howProse, /\blive\b[^.]*\bcheck|checked [^.]* live/i);
});

// That the docs follow production's switches is checked against production's config in
// docs-copy.private.test.mjs; this checks how a switch is read.
test("the free-trial and Free plan switches are read strictly", () => {
  const line = (value) => `  "vars": {\n    "TALKTO_STARTER_ADMISSIONS_ENABLED": "${value}",\n  }`;
  assert.equal(starterSwitch(line("true")), true);
  assert.equal(starterSwitch(line("false")), false);
  // A commented-out line does not count; a missing, doubled or odd value fails the build.
  assert.throws(() => starterSwitch(`// "TALKTO_STARTER_ADMISSIONS_ENABLED": "true",`));
  assert.throws(() => starterSwitch(`${line("true")}\n${line("false")}`));
  assert.throws(() => starterSwitch(line("yes")));
  // The Free plan follows its own switch, and only while free starts are published at all.
  assert.ok(!freePublished || starterPublished, "the Free plan is published only with free starts");
  const free = (value) => `  "vars": {\n    "TALKTO_FREE_PLAN_ENABLED": "${value}",\n  }`;
  assert.equal(freeSwitch(free("true")), true);
  assert.equal(freeSwitch(free("false")), false);
  assert.throws(() => freeSwitch(`// "TALKTO_FREE_PLAN_ENABLED": "true",`));
});

test("the plan table gives each plan's history from pricing.ts, and no page says history is kept forever", () => {
  const table = plansMarkdown(false);
  assert.match(
    table,
    /\| Plan \| Per month \(USD\) \| Messages per month \| Reads per month \| Storage \| History \|/,
  );
  assert.match(table, /\| Shop \|[^\n]*\| 90 days of history \|/);
  assert.match(table, /\| Studio \|[^\n]*\| 1 year of history \|/);
  assert.match(table, /\| Factory \|[^\n]*\| All history, archived after 1 year \|/);
  assert.match(table, /the shorter limit starts 30 days later/);
  for (const { path, html, markdown } of pages)
    for (const prose of [htmlProse(html), mdProse(markdown)])
      assert.doesNotMatch(prose, /indefinitely, for now/, `${path}: history follows the plan`);
});

test("with the Free plan switched on, the docs describe the Free plan in place of the free trial", () => {
  const monthly = freePlan.messages.toLocaleString("en-US");
  const live = plansMarkdown(true, true);
  assert.match(
    live,
    new RegExp(`\\*\\*Free plan: ${monthly} messages a month\\.\\*\\* No credit card\\.`),
  );
  assert.match(live, new RegExp(`${history.free.days} days of message history\\.`));
  assert.match(live, /start again each month/);
  assert.doesNotMatch(live, /Free trial|do not refill|carry over/);
  assert.doesNotMatch(plansMarkdown(false, true), /Free plan/);
});

test("the free trial is described only once it is published", () => {
  const count = starter.messages.toLocaleString("en-US");
  const offer = new RegExp(`Free trial: ${count} messages|No credit card|starter server`, "i");
  for (const { path, html, markdown } of pages) {
    // Published, a page may carry the offer at most once, above its plan table, in both copies.
    const shown = starterPublished ? 1 : 0;
    for (const prose of [htmlProse(html), mdProse(markdown)])
      assert.ok((prose.match(offerText)?.length ?? 0) <= shown, `${path}: the offer at most once`);
    assert.doesNotMatch(withoutOffer(htmlProse(html)), offer, `${path}: no free start elsewhere`);
    assert.doesNotMatch(
      withoutOffer(mdProse(markdown)),
      /\bfree\b/i,
      `${path}: no "free" elsewhere`,
    );
  }
  if (starterPublished)
    assert.match(
      htmlProse(pages.find(({ path }) => path === "/docs/pricing/")?.html ?? ""),
      new RegExp(offerText.source),
      "/docs/pricing/: the offer while production makes it",
    );
  assert.doesNotMatch(plansMarkdown(false), offer);
  // The free trial's own words, whichever offer production makes now.
  const live = plansMarkdown(true, false);
  assert.match(
    live,
    new RegExp(`\\*\\*Free trial: ${count} messages\\.\\*\\* No credit card\\. No time limit\\.`),
  );
  assert.match(live, /One starter server, once per person\./);
  assert.match(live, /Leftover messages carry over when you choose a plan\./);
  for (const [, n] of live.matchAll(/([\d,]+)(?: free)? messages\b(?! per month)/g))
    assert.ok(
      n === count ||
        Object.values(plans).some((plan) => plan.messages.toLocaleString("en-US") === n),
      `${n} messages comes from pricing.ts`,
    );
});

test("the footer links Terms and Privacy on every page", () => {
  const legal = ["/terms", "/privacy"];
  const hrefs = footerLinks().map(({ href }) => href);
  for (const href of legal) assert.ok(hrefs.includes(href), `the footer links ${href}`);
  for (const { path, html } of pages)
    for (const href of legal) assert.ok(html.includes(`href="${href}"`), `${path}: links ${href}`);
});

test("guide references link inside the docs site, not to /docs/docs/", async () => {
  const { linkGuideReferences } = await import("../src/generate.ts");
  const linked = linkGuideReferences(
    'See "Keep up while working" below, "Hermes Agent" below and "OpenClaw" below.',
  );
  assert.doesNotMatch(linked, /\]\(\/docs\//);
  assert.match(linked, /\[Delivery\]\(\/concepts\/delivery\/\)/);
});

test("the FAQ carries its questions and answers as FAQPage structured data", () => {
  const faq = pages.find(({ path }) => path === "/docs/faq/");
  assert.ok(faq, "a /docs/faq/ page");
  const data = [...faq.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => JSON.parse(m[1]))
    .find((item) => item["@type"] === "FAQPage");
  assert.ok(data, "FAQPage JSON-LD in the head");
  const questions = [...faq.markdown.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  assert.ok(questions.length >= 15, "at least 15 questions");
  assert.deepEqual(
    data.mainEntity.map((item) => item.name),
    questions,
    "one entry per question, in order",
  );
  for (const item of data.mainEntity)
    assert.ok(item.acceptedAnswer.text.length > 40, `${item.name}: an answer`);
});

test("the updates page has a section for each plugin, every update command, and footer links", async () => {
  const { hookUpdates, pluginUpdates } = await import("@talkto/api/documentation");
  const { updateAnchors, updatesPath } = await import("@talkto/api/plugins");
  const page = pages.find(({ path }) => path === updatesPath);
  assert.ok(page, `${updatesPath} is built`);
  // The plugins' update lines and the dashboard badge link these anchors.
  for (const anchor of Object.values(updateAnchors))
    assert.match(page.html, new RegExp(`id="${anchor}"`), `#${anchor}`);
  for (const guide of [...pluginUpdates, ...hookUpdates]) {
    assert.ok(page.markdown.includes(`# ${guide.heading}`), guide.heading);
    if (guide.commands.length > 0)
      assert.ok(
        page.markdown.includes(`\`\`\`sh\n${guide.commands.join("\n")}\n\`\`\``),
        guide.heading,
      );
  }
  assert.doesNotMatch(page.markdown, /\b[0-9a-f]{7,40}\b/, "no commit hashes on a public page");
  assert.ok(footerLinks().some(({ href }) => href === updatesPath));
  assert.ok(
    pages.every(({ html }) => html.includes(`href="${updatesPath}"`)),
    "every footer",
  );
});
