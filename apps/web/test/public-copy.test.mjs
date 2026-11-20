import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createServer as createVite } from "vite";
import { brandMisspellings, decode, stale, testedClaim, without, words } from "./copy-rules.mjs";

/*
  The public site's words, checked against the product's shared facts (docs/site-facts.md).
  Renders each prerendered page the way the build does and reads index.html and the agent docs.
*/

const wordmark = /<a class="lp-wordmark"[^>]*>talkto<i[^>]*><\/i><\/a>/g;
const footerLine = /<a class="lp-from"[^>]*>from Plannotator<\/a>/g;
const code = /<code>[\s\S]*?<\/code>/g;
/*
  The only place the public site may say "encrypt": two exact sentences in the Security section of
  /privacy. One reports what Cloudflare's data security pages document (the docs site's
  /docs/how-it-works/ carries the same sentence); the other says messages are NOT end-to-end
  encrypted. Neither claims encryption for TalkTo. The stale rule still applies to the rest of
  /privacy and to every other page. Facts: docs/terms-privacy-notes.md.
*/
const attributed = {
  "/privacy": [
    "Cloudflare documents that it encrypts all data that Durable Objects, D1 and R2 store, with AES-256 and keys that Cloudflare manages, and that data moving to and from them travels over TLS.",
    "Messages are not end-to-end encrypted: the TalkTo service can read every message it stores.",
  ],
};
/*
  The Terms and Privacy pages name the operator, GistWorks LLC, doing business as Plannotator
  (owner decision, 2026-11-14), and give the support address. These exact phrases are the only
  other places the site names Plannotator.
*/
const operator = {
  "/terms": /service of GistWorks LLC, doing business as Plannotator|support@plannotator\.ai/g,
  "/privacy": /GistWorks LLC, doing business as Plannotator, runs TalkTo|support@plannotator\.ai/g,
};
const withoutOperator = (path, prose) =>
  operator[path] === undefined ? prose : prose.replace(operator[path], " ");
const withoutAttributed = (path, prose) =>
  (attributed[path] ?? []).reduce((text, sentence) => {
    assert.equal(text.split(sentence).length, 2, `${path}: the attributed sentence once`);
    return text.replace(sentence, " ");
  }, prose);
const codeLines = (html) =>
  [...html.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) =>
    decode(m[1].replaceAll("<!-- -->", "")),
  );
test("public pages state only the shared facts, in one voice", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { renderPublic, publicPages } = await vite.ssrLoadModule("/src/prerender.tsx");
  const { historyGigabytes, plans, serverHistoryGigabytes, storageGigabytes, storageLabel } =
    await vite.ssrLoadModule("@talkto/api/pricing");
  const { installLines, mcpUrl } = await vite.ssrLoadModule("/src/landing-parts.tsx");
  const { createFeed, openingLines } = await vite.ssrLoadModule("/src/landing-feed.ts");
  const keys = Object.keys(plans);
  const prices = new Set(keys.map((key) => `$${plans[key].monthlyCents / 100}`));
  const messages = new Set(keys.map((key) => plans[key].messages.toLocaleString("en-US")));
  // File pools and the history kept in place per organization and per server (claim 65).
  const pools = new Set([
    ...keys.map((key) => storageLabel(storageGigabytes[key])),
    ...Object.values(historyGigabytes).map((gigabytes) => `${gigabytes} GB`),
    `${serverHistoryGigabytes} GB`,
  ]);
  const people = new Set(
    keys.flatMap((key) =>
      plans[key].peopleLimit === null ? [] : [String(plans[key].peopleLimit)],
    ),
  );

  const template = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const escaped = publicPages[0].description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    template,
    new RegExp(`<meta\\s+name="description"\\s+content="${escaped}"\\s*/>`),
    "index.html carries the home page description, which the prerender replaces per page",
  );
  assert.equal(
    template.match(/<meta\s+name="description"/g)?.length,
    1,
    "index.html has exactly one description tag for the prerender to replace",
  );
  assert.match(template, /<title>TalkTo<\/title>/);

  const feed = createFeed(() => 0.37);
  const feedText = [...openingLines, ...Array.from({ length: 400 }, () => feed())]
    .map((line) => line.text)
    .join(" ");

  const rendered = publicPages.map(({ path, description }) => ({
    path,
    description,
    html: renderPublic(path),
  }));
  for (const { path, description, html } of rendered) {
    const page = `${path}: `;
    assert.equal(html.match(footerLine)?.length, 1, `${page}one "from Plannotator" footer line`);
    const prose = withoutOperator(
      path,
      withoutAttributed(
        path,
        words(without(without(without(html, wordmark), footerLine), code)) + ` ${description}`,
      ),
    );
    const codeText = decode((html.match(code) ?? []).join(" "));

    for (const term of stale) assert.doesNotMatch(prose, term, `${page}stale or unsupported term`);
    assert.deepEqual(
      [...prose.matchAll(brandMisspellings)].map((m) => m[0]),
      [],
      `${page}agent names as their makers write them (docs/brand-names.md)`,
    );
    for (const term of stale)
      assert.doesNotMatch(feedText, term, "the live feed avoids stale terms");
    for (const match of prose.matchAll(/talkto/gi))
      assert.equal(
        match[0],
        "TalkTo",
        `${page}the name in text is "TalkTo"; only the wordmark is lowercase`,
      );
    assert.doesNotMatch(
      prose,
      /plannotator/i,
      `${page}Plannotator appears only in the footer line`,
    );
    assert.doesNotMatch(
      codeText,
      /plannotator/i,
      `${page}the plugin repository is talkto-sh/talkto-plugin`,
    );

    for (const [match] of prose.matchAll(/\$\d[\d,.]*/g))
      assert.ok(prices.has(match), `${page}${match} is not a price in pricing.ts`);
    for (const [, count] of prose.matchAll(/([\d,]+) messages/g))
      assert.ok(messages.has(count), `${page}${count} messages is not an allowance in pricing.ts`);
    for (const [size] of prose.matchAll(/\d[\d,.]* [GT]B\b/g))
      assert.ok(pools.has(size), `${page}${size} is not a storage pool in pricing.ts`);
    for (const [, limit] of prose.matchAll(/up to (\d+) people/gi))
      assert.ok(people.has(limit), `${page}${limit} people is not a plan's people limit`);

    if (path === "/pricing" || path === "/") {
      for (const key of keys) {
        assert.ok(prose.includes(plans[key].name), `${page}${plans[key].name} is listed`);
        // Each card: price, people, messages a month and history (owner, November 17, 2026).
        assert.ok(
          prose.includes(`${plans[key].messages.toLocaleString("en-US")} messages a month`),
          `${page}${plans[key].name} messages`,
        );
      }
      for (const price of prices) assert.ok(prose.includes(price), `${page}${price} is listed`);
      assert.ok(
        prose.includes("Flat monthly price per organization. Not per seat."),
        `${page}the plans are labeled as a flat price, not per seat`,
      );
      // Swarms past Factory write to support, like an enterprise "Contact us" (claim 67).
      assert.ok(
        prose.includes("Running a swarm? Talk to us about many millions of messages a month."),
        `${page}the swarm contact`,
      );
      assert.match(
        html,
        /<a class="lp-button quiet" href="mailto:support@plannotator\.ai\?subject=TalkTo%20for%20a%20swarm">Contact us →<\/a>/,
        `${page}the swarm contact writes to support`,
      );
      // Home: beside Pricing details, a link straight to the self-hosting note (owner, Nov 17).
      if (path === "/")
        assert.match(
          html,
          /<a class="tm-link" href="\/pricing">Pricing details →<\/a><a class="tm-link" href="\/pricing#self-host">Self-host →<\/a>/,
          "/: Self-host sits beside Pricing details",
        );
      // Agents are unlimited, said once: Home's label, Pricing's plan details (claim 53).
      assert.equal(
        prose.match(/[Uu]nlimited agents/g)?.length,
        1,
        `${page}"unlimited agents" once, not on every card`,
      );
      // Home's cards carry four lines; Pricing's add file storage (claim 53). No agents or reads.
      const cards = html.match(/<dl class="lp-plans[ "][\s\S]*?<\/dl>/)?.[0] ?? "";
      const lines = path === "/pricing" ? 5 : 4;
      assert.equal(
        [...cards.matchAll(/<dd /g)].length,
        keys.length * lines,
        `${page}each card has price, people, messages, history${lines === 5 ? " and storage" : ""}`,
      );
      assert.doesNotMatch(words(cards), /agents|reads/, `${page}no agents or reads on the cards`);
      if (path === "/pricing")
        for (const key of keys)
          assert.ok(
            words(cards).includes(`${storageLabel(storageGigabytes[key])} of file storage`),
            `${page}${plans[key].name} storage on its card`,
          );
      else assert.doesNotMatch(words(cards), /storage|GB/, `${page}Home: four lines a card`);
    }
    if (path === "/pricing") {
      assert.match(prose, /Plan details/, `${page}one "Plan details" list`);
      // A few short lines under the cards; the fine print is in the docs (owner, November 17, 2026).
      for (const line of [
        "Every plan has every feature and unlimited agents.",
        "Only messages your agents send count. No overage charges.",
        "Reads, storage and history limits →",
        "Choose a plan on your organization’s Billing page. Prices in US dollars.",
      ])
        assert.ok(prose.includes(line), `${page}${line}`);
    }
    if (path === "/setup") {
      for (const { lines } of installLines)
        for (const line of lines) assert.ok(codeText.includes(line), `${page}${line}`);
    }
  }

  // Setup and links: every agent the site names has its own section in the agent docs; every install
  // line, link and sentence comes from the builders the docs use.
  const doc = await vite.ssrLoadModule("@talkto/api/documentation");
  const parts = await vite.ssrLoadModule("/src/landing-parts.tsx");
  const { mcpTools } = await vite.ssrLoadModule("/src/setup-page.tsx");
  const guide = doc.renderDocumentation(
    await readFile(new URL("../../server/src/instructions.md", import.meta.url), "utf8"),
    parts.siteOrigin,
  );
  const headings = new Set([...guide.matchAll(/^### (.+)$/gm)].map((m) => m[1]));
  for (const { name, docs } of [...parts.agents, ...mcpTools])
    assert.ok(headings.has(docs), `${name}: the agent docs have a "### ${docs}" section`);
  for (const { tool } of Object.values(parts.pluginInstalls))
    assert.ok(
      [...headings].some((heading) => heading.includes(tool)),
      `${tool}: plugin section in the agent docs`,
    );
  const covered = parts.docsCoverage
    .replace(/^The docs have the setup for /, "")
    .replace(/ and any other MCP tool\.$/, "")
    .split(/, | and /);
  assert.ok(covered.length > 10, "the coverage sentence lists the tools");
  for (const name of covered)
    assert.ok(
      [...headings].some((heading) => heading.includes(name)),
      `${name} is named on the site and has a section in the agent docs`,
    );

  assert.equal(parts.mcpUrl, doc.mcpEndpoint(parts.siteOrigin));
  assert.equal(parts.cursorLink, doc.cursorInstallLink(parts.mcpUrl));
  assert.equal(parts.vscodeLink, doc.vscodeWebInstallLink(parts.mcpUrl));
  assert.equal(parts.addMcpLine, doc.addMcpCommand(parts.mcpUrl));
  assert.equal(parts.agentSentence, doc.setupSentence(parts.siteOrigin));
  const cursorConfig = new URL(parts.cursorLink).searchParams;
  assert.equal(cursorConfig.get("name"), doc.mcpServerName);
  assert.deepEqual(JSON.parse(atob(cursorConfig.get("config"))), { url: parts.mcpUrl });
  const vscode = decodeURIComponent(new URL(parts.vscodeLink).searchParams.get("url"));
  assert.deepEqual(JSON.parse(decodeURIComponent(vscode.replace(/^vscode:mcp\/install\?/, ""))), {
    name: doc.mcpServerName,
    type: "http",
    url: parts.mcpUrl,
  });
  assert.ok(
    guide.includes(doc.cursorInstallLink(parts.mcpUrl)),
    "agent docs carry the Cursor link",
  );
  assert.ok(
    guide.includes(doc.vscodeInstallLink(parts.mcpUrl)),
    "agent docs carry the VS Code link",
  );
  assert.ok(guide.includes(`"url": "${parts.mcpUrl}"`), "agent docs carry the same entry");
  assert.doesNotMatch(
    guide,
    /\{\{[A-Z_]+\}\}/,
    "every generated value in the agent docs is filled",
  );
  for (const path of ["/", "/setup"]) {
    const html = renderPublic(path);
    for (const line of codeLines(html))
      assert.ok(guide.includes(line), `${path}: the agent docs carry "${line}"`);
    for (const [, href] of html.matchAll(
      /href="((?:cursor|vscode)[^"]*|https:\/\/vscode\.dev[^"]*)"/g,
    ))
      assert.ok(
        [parts.cursorLink, parts.vscodeLink].includes(decode(href)),
        `${path}: ${href} is built by the shared link builders`,
      );
  }
  const setupHtml = renderPublic("/setup");
  assert.ok(decode(setupHtml).includes(`href="${parts.cursorLink}"`), "Setup has Add to Cursor");
  assert.ok(decode(setupHtml).includes(`href="${parts.vscodeLink}"`), "Setup has Add to VS Code");
  for (const line of [parts.agentSentence, parts.addMcpLine, parts.mcpUrl])
    assert.ok(codeLines(setupHtml).includes(line), `Setup shows ${line}`);

  // Tested status is internal data: `liveTested`, mirrored by the launch checklist (checked in
  // live-tested.private.test.mjs, which stays in the private repository). No page shows it.
  assert.deepEqual(
    [...guide.matchAll(testedClaim)].map((m) => m[0]),
    [],
    "the agent docs make no tested claim",
  );
  for (const { path } of publicPages) {
    const html = renderPublic(path);
    assert.doesNotMatch(html, /live[- ]tested/i, `${path}: no Live-tested label`);
    assert.deepEqual(
      [...words(without(html, code)).matchAll(testedClaim)].map((m) => m[0]),
      [],
      `${path}: no tested claim`,
    );
  }

  // The agent docs are the same Markdown the site copies; they must agree with the site.
  const { renderDocumentation } = await vite.ssrLoadModule("@talkto/api/documentation");
  const raw = await readFile(new URL("../../server/src/instructions.md", import.meta.url), "utf8");
  const docs = renderDocumentation(raw, new URL(mcpUrl).origin);
  assert.doesNotMatch(
    docs,
    /\bSolo\b|Plannotator/,
    "agent docs: no Solo plan, no Plannotator brand",
  );
  for (const { lines } of installLines)
    for (const line of lines) assert.ok(docs.includes(line), `agent docs carry ${line}`);
  for (const [, size, plan] of docs.matchAll(/(\d+) GB on (Shop|Studio|Factory)/g)) {
    const key = keys.find((name) => plans[name].name === plan);
    assert.equal(size, String(storageGigabytes[key]), `agent docs: ${plan} storage`);
  }
  for (const [match] of docs.matchAll(/\$\d[\d,.]*/g))
    assert.ok(prices.has(match), `agent docs: ${match} is not a price in pricing.ts`);
});

const oldCents = new Set([2000, 9900, 25000]);
test("no page shows a retired price: $20, $99 or $250 a month, or a self-host license price", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { plans } = await vite.ssrLoadModule("@talkto/api/pricing");
  for (const plan of Object.values(plans))
    assert.ok(
      !oldCents.has(plan.monthlyCents),
      `pricing.ts still has a retired price for ${plan.name}`,
    );
  const { renderPublic, publicPages } = await vite.ssrLoadModule("/src/prerender.tsx");
  for (const { path } of publicPages)
    assert.doesNotMatch(
      words(renderPublic(path)),
      // Self-host licenses were $50, $250 and $1,000, then $100, $299 and $1,500 a year.
      /\$(20|99|250|50|1,000|100|299|1,500)\b/,
      `${path} shows a retired price`,
    );
});

const starterBlock = /<div class="lp-starter"[\s\S]*?<\/div>/g;
test("the free trial appears only when the environment offers it, in its fact-sheet words", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { renderPublic, publicPages } = await vite.ssrLoadModule("/src/prerender.tsx");
  const { plans, starter } = await vite.ssrLoadModule("@talkto/api/pricing");
  const count = starter.messages.toLocaleString("en-US");
  const allowances = new Set(
    Object.values(plans).map((plan) => plan.messages.toLocaleString("en-US")),
  );
  const offer = { messages: starter.messages, servers: starter.servers };
  for (const { path } of publicPages) {
    // Built pages carry no offer: the Worker's /v1/offers answer adds it at runtime.
    const built = renderPublic(path);
    assert.doesNotMatch(built, starterBlock, `${path}: prerendered without the free start`);
    assert.doesNotMatch(
      words(built),
      /\bfree\b|credit card|starter/i,
      `${path}: no free-start words`,
    );

    const html = renderPublic(path, offer);
    const blocks = html.match(starterBlock) ?? [];
    if (path === "/" || path === "/pricing") assert.equal(blocks.length, 1, `${path}: one offer`);
    else assert.equal(blocks.length, 0, `${path}: the offer belongs to pricing only`);
    const rest = withoutAttributed(path, words(without(html, starterBlock)));
    for (const term of stale)
      assert.doesNotMatch(rest, term, `${path}: stale term outside the offer`);
    for (const block of blocks) {
      const text = words(block).trim();
      assert.ok(
        text.startsWith(`Free trial: ${count} messages. No credit card. No time limit.`),
        `${path}: the specification's offer line`,
      );
      assert.match(text, /One starter server, once per person\./);
      assert.match(text, /do not refill/);
      assert.match(text, /Nothing is charged automatically\./);
      assert.match(text, /Leftover messages carry over when you choose a plan\./);
      assert.match(
        block,
        /<a class="lp-button lp-starter-action" href="\/app">Start free trial →<\/a>/,
      );
      for (const [, n] of text.matchAll(/([\d,]+)(?: free)? messages/g))
        assert.equal(n, count, `${path}: free-start numbers come from pricing.ts`);
      // The offer is the one place that says "free trial" (KEY_DECISIONS.md, November 13).
      for (const term of stale.filter((rule) => !rule.test("free") && !rule.test("trial")))
        assert.doesNotMatch(text, term, `${path}: stale term in the offer`);
      assert.doesNotMatch(text, /\$\d/, `${path}: no price in the offer`);
    }
    for (const [, n] of rest.matchAll(/([\d,]+) messages/g))
      assert.ok(allowances.has(n), `${path}: ${n} messages outside the offer is a plan allowance`);
  }
});

test("the Free plan is the first card where the environment offers it, with its terms in the plan details", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { renderPublic, publicPages } = await vite.ssrLoadModule("/src/prerender.tsx");
  const { free, history, plans } = await vite.ssrLoadModule("@talkto/api/pricing");
  const count = free.messages.toLocaleString("en-US");
  const offer = { messages: free.messages, servers: free.servers, historyDays: history.free.days };
  const freeCard = /<div class="lp-plan" data-plan="free">[\s\S]*?<\/div>/g;
  const freeLines = /<(?:li|p) [^>]*data-offer="free"[^>]*>[\s\S]*?<\/(?:li|p)>/g;
  for (const { path } of publicPages) {
    const html = renderPublic(path, offer);
    // No box above the plans: the Free plan is a card, so the trial's box never shows with it.
    assert.doesNotMatch(html, starterBlock, `${path}: no offer box with the Free plan`);
    const cards = html.match(freeCard) ?? [];
    if (path !== "/" && path !== "/pricing") {
      assert.equal(cards.length, 0, `${path}: the Free plan belongs to pricing only`);
      assert.doesNotMatch(html, freeLines, `${path}: no Free terms`);
      continue;
    }
    assert.equal(cards.length, 1, `${path}: one Free card`);
    assert.equal(
      words(cards[0]).trim(),
      `Free $0 / month 1 person ${count} messages a month ${history.free.days} days of history${path === "/pricing" ? " 2 GB of file storage" : ""}`,
      `${path}: the Free card's lines`,
    );
    const order = [...html.matchAll(/data-plan="(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(order, ["free", ...Object.keys(plans)], `${path}: Free first`);
    // One clear action: "Start free" in the action row, nowhere else.
    assert.equal(html.match(/>Start free →</g)?.length, 1, `${path}: one Start free link`);
    assert.doesNotMatch(html, />Get started →</, `${path}: Start free replaces Get started`);
    const terms = words((html.match(freeLines) ?? []).join(" "));
    assert.match(terms, /no credit card/);
    assert.match(terms, /once per person/);
    assert.match(terms, /Nothing is charged automatically\./);
    assert.doesNotMatch(terms, /\btrial\b|carry over|No time limit/i, `${path}: not the trial`);
    for (const [, n] of terms.matchAll(/([\d,]+) messages/g))
      assert.equal(n, count, `${path}: Free plan numbers come from pricing.ts`);
    assert.doesNotMatch(terms, /\$\d/, `${path}: no price in the terms`);
    // "Free" may appear only on its card, in its terms and on the action.
    const allowed = /<a class="lp-button" href="\/app">Start free →<\/a>/g;
    const rest = withoutAttributed(
      path,
      words(without(without(without(html, freeCard), freeLines), allowed)),
    );
    for (const term of stale)
      assert.doesNotMatch(rest, term, `${path}: stale term outside the Free plan`);
  }
});

test("paid plans are their listed allowance, with no bonus on top", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { renderPublic, publicPages } = await vite.ssrLoadModule("/src/prerender.tsx");
  const { plans } = await vite.ssrLoadModule("@talkto/api/pricing");
  // The owner removed the beta bonus (KEY_DECISIONS.md, November 16, 2026).
  for (const { path } of publicPages) {
    const text = words(renderPublic(path));
    assert.doesNotMatch(text, /\bbeta\b|\bbonus\b|% more|March 31, 2027/i, `${path}: no bonus`);
    if (path !== "/" && path !== "/pricing") continue;
    for (const key of Object.keys(plans)) {
      const messages = `${plans[key].messages.toLocaleString("en-US")} messages a month`;
      assert.ok(text.includes(messages), `${path}: ${plans[key].name} ${messages}`);
    }
  }
});

test("the Terms and Privacy are published: linked from every footer, indexed, and final", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { renderPublic, publicPages, pageDocument } =
    await vite.ssrLoadModule("/src/prerender.tsx");
  const { legalPages } = await vite.ssrLoadModule("/src/landing-parts.tsx");
  assert.deepEqual(
    legalPages.map(({ path }) => path),
    ["/terms", "/privacy"],
  );
  for (const { path } of legalPages) {
    const text = words(renderPublic(path));
    assert.doesNotMatch(
      text,
      /\bdraft\b|not yet in effect|\breview\b/i,
      `${path}: no draft notice`,
    );
    assert.doesNotMatch(text, /\[OWNER\b|OWNER:/, `${path}: no owner blank`);
    // The history-per-plan text takes effect when it is deployed: the release commit replaces the
    // placeholder with that day, and the production preflight refuses to deploy it unreplaced.
    assert.match(
      text,
      /Effective date: (?:\[DEPLOY DATE\]|[A-Z][a-z]+ \d{1,2}, \d{4})(?!\S)/,
      `${path}: the effective date`,
    );
    // Each plan's history, as the pricing page says it.
    if (path === "/terms")
      assert.match(
        text,
        /90 days on Shop, 1 year on Studio, and 30 days with the monthly allowance/,
      );
    assert.doesNotMatch(text, /indefinitely, for now/, `${path}: history follows the plan now`);
    // Hosted file sharing is R2 transfers only since November 16, 2026.
    assert.doesNotMatch(text, /\bGit\b/, `${path}: no Git file sharing`);
  }
  const template = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const legalPaths = legalPages.map(({ path }) => path);
  for (const { path } of publicPages) {
    const html = renderPublic(path);
    const footer = html.match(/<footer class="fb-foot"[\s\S]*?<\/footer>/)?.[0] ?? "";
    assert.ok(footer, `${path}: a footer`);
    for (const legal of legalPaths)
      assert.ok(footer.includes(`href="${legal}"`), `${path}: the footer links ${legal}`);
    const document = pageDocument(template, path);
    assert.doesNotMatch(document, /name="robots"/, `${path}: indexable`);
    assert.doesNotMatch(document, /content="Draft /, `${path}: no draft description`);
    assert.ok(document.includes(html), `${path}: the document carries the page`);
    // Link previews (iMessage, Slack, X, LinkedIn): this page's own title, description and
    // address, and the shared card at an absolute address.
    const meta = (key) =>
      document.match(new RegExp(`<meta\\s+property="${key}"\\s+content="([^"]*)"`))?.[1];
    const page = publicPages.find((candidate) => candidate.path === path);
    assert.equal(meta("og:title"), path === "/" ? "TalkTo" : `${page.name} · TalkTo`, path);
    assert.equal(meta("og:description"), page.description, `${path}: og:description`);
    assert.equal(meta("og:url"), new URL(path, "https://talkto.sh").href, `${path}: og:url`);
    assert.equal(meta("og:image"), "https://talkto.sh/og.png", `${path}: og:image`);
    assert.match(document, /<meta name="twitter:card" content="summary_large_image" \/>/);
  }
  const card = await readFile(new URL("../public/og.png", import.meta.url));
  assert.deepEqual(
    [card.readUInt32BE(16), card.readUInt32BE(20)],
    [1200, 630],
    "og.png is the 1200x630 card that index.html declares",
  );
});

test("Feedback is only a quiet footer link to the dashboard, never in a public header or body", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { renderPublic, publicPages } = await vite.ssrLoadModule("/src/prerender.tsx");
  for (const { path } of publicPages) {
    const html = renderPublic(path);
    const footer = html.match(/<footer class="fb-foot"[\s\S]*?<\/footer>/)?.[0] ?? "";
    assert.deepEqual(
      [...footer.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>Feedback<\/a>/g)].map(([, href]) => href),
      ["/app?feedback=1"],
      `${path}: one Feedback link in the footer, opening the dialog in the dashboard`,
    );
    assert.doesNotMatch(
      html.replace(footer, ""),
      /feedback/i,
      `${path}: no Feedback outside the footer`,
    );
  }
});

test("Home and Pricing give each plan's message history from pricing.ts", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { renderPublic } = await vite.ssrLoadModule("/src/prerender.tsx");
  const { historyLabel } = await vite.ssrLoadModule("@talkto/api/pricing");
  assert.deepEqual(["shop", "studio", "factory"].map(historyLabel), [
    "90 days of history",
    "1 year of history",
    "All history, archived after 1 year",
  ]);
  // The cards say "All history" for Factory; the archive is explained in the docs' Pricing.
  for (const path of ["/", "/pricing"]) {
    const text = words(renderPublic(path));
    for (const label of ["90 days of history", "1 year of history", "All history"])
      assert.match(text, new RegExp(label), `${path}: ${label}`);
  }
  assert.match(
    words(renderPublic("/access")),
    /Message history follows your plan: 90 days on Shop and 1 year on Studio\. Factory keeps all of it/,
  );
  // The owner, November 17, 2026: the fine print moved off the site, to one link.
  const pricing = renderPublic("/pricing");
  assert.match(pricing, /<a class="tm-link pr-limits" href="\/docs\/pricing\/">/);
  assert.doesNotMatch(words(pricing), /History follows your plan|storage pool|Fair limits/);
});

test("Pricing gives each plan's reads a month from pricing.ts in plain words, with no always-on gloss", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { renderPublic } = await vite.ssrLoadModule("/src/prerender.tsx");
  const { readsLabel, reads } = await vite.ssrLoadModule("@talkto/api/pricing");
  // The owner's November 16 read budgets (KEY_DECISIONS.md).
  assert.deepEqual(
    Object.entries(reads).map(([key, r]) => [key, r.monthly, r.perMinute, r.slowPerMinute]),
    [
      ["free", 500000, 20, 1],
      ["shop", 2000000, 120, 3],
      ["studio", 10000000, 600, 10],
      ["factory", 20000000, 1500, 30],
    ],
  );
  // The docs plan table keeps the gloss (apps/docs/src/generate.ts); the site does not.
  assert.deepEqual(["shop", "studio", "factory"].map(readsLabel), [
    "2M reads a month — about 20 always-on agents",
    "10M reads a month — about 100 always-on agents",
    "20M reads a month — about 200 always-on agents",
  ]);
  // The owner, November 17, 2026: the gloss told people nothing. Pricing says it plainly.
  for (const path of ["/", "/pricing"])
    assert.doesNotMatch(words(renderPublic(path)), /always-on/, `${path}: no always-on gloss`);
  assert.doesNotMatch(words(renderPublic("/pricing")), /Reads included/, "reads are in the docs");
});

/*
  Self-host licenses are no longer sold (owner decision, November 19, 2026). Pricing's last band
  says what the source license allows instead (docs/site-facts.md, claims 55 and 56), and no page
  sells a license, links a checkout or shows the retired license page.
*/
test("Pricing explains self-hosting under Apache 2.0 and sells no self-host license", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { renderPublic, publicPages } = await vite.ssrLoadModule("/src/prerender.tsx");
  const pricing = await vite.ssrLoadModule("@talkto/api/pricing");
  assert.deepEqual(
    Object.keys(pricing).filter((name) => /license/i.test(name)),
    [],
    "pricing.ts sells no license",
  );
  assert.ok(
    publicPages.every(({ path }) => path !== "/self-host-license"),
    "the license page is gone",
  );
  for (const { path } of publicPages) {
    const built = renderPublic(path);
    const text = words(built);
    assert.doesNotMatch(built, /buy\.stripe\.com|checkout\.stripe\.com/, `${path}: no buy link`);
    assert.doesNotMatch(built, /self-host-license/, `${path}: no link to the retired license page`);
    assert.doesNotMatch(
      text,
      /\byearly\b|billed yearly|Self-Host License|private repository|GitHub username|\bBuy\b/,
      `${path}: nothing sells a self-host license`,
    );
    if (path !== "/pricing") {
      assert.doesNotMatch(text, /Host it yourself/, `${path}: self-hosting is on Pricing`);
      continue;
    }
    assert.match(text, /Host it yourself Run TalkTo yourself\./);
    for (const line of [
      "The TalkTo source is available under the Apache License 2.0.",
      "Self-hosting instructions are coming.",
      "You may use, change and self-host it for any purpose.",
      "You may share it and build on it, including in products you sell.",
      "Keep its license and copyright notices when you share it.",
    ])
      assert.ok(text.includes(line), `/pricing: ${line}`);
    // No promise beyond what the repository provides today: no guide, support or updates.
    assert.doesNotMatch(
      text,
      /Cloudflare account|WorkOS account|no message limits|updates as we ship|security updates/,
    );
    assert.match(
      built,
      /<a class="lp-button lp-jump" href="#self-host">Self-host ↓<\/a>/,
      "/pricing: the jump to the note",
    );
  }
});
