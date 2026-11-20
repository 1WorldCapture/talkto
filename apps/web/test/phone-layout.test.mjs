import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createServer as createVite } from "vite";
import { decode } from "./copy-rules.mjs";

/*
  The phone layout (720px wide or less; docs/site-facts.md, "Phones"): a shorter header with Setup
  and Access in the footer, no llms.txt links, and short agent lists with a "More agents" button.
  Wider screens keep every list whole, in its own order. The markup carries both; the stylesheets
  pick one by width, so this test reads both.
*/

const popular = [
  "Claude Code",
  "Codex",
  "Muse",
  "Hermes",
  "OpenClaw",
  "OpenCode",
  "Pi",
  "Grok",
  "Antigravity",
];

/** The text of each `<li>` in a list's markup, with its attributes. */
const items = (list) =>
  [...list.matchAll(/<li([^>]*)>([\s\S]*?)<\/li>/g)].map(([, attributes, body]) => ({
    name: decode(body.replaceAll("<!-- -->", "").replace(/<[^>]+>/g, "")).trim(),
    rest: attributes.includes("data-rest"),
  }));

/** Every agent list on a rendered page: the whole list and the phone list with its button. */
const agentLists = (html) =>
  [
    ...html.matchAll(
      /<ul class="([^"]*) pa-wide"[^>]*>([\s\S]*?)<\/ul><div class="pa-phone">(<ul id="([^"]+)" class="([^"]*)"[^>]*>([\s\S]*?)<\/ul>)(<button[^>]*>[\s\S]*?<\/button>)?<\/div>/g,
    ),
  ].map(([, wideClass, wide, , id, phoneClass, phone, button]) => ({
    wideClass,
    wide: items(wide).map(({ name }) => name),
    id,
    phoneClass,
    phone: items(phone),
    button: button ?? "",
  }));

/** The declarations of `selector` inside the stylesheet's `@media` block opened by `media`. */
function rule(css, selector, media) {
  let scope = css;
  if (media !== undefined) {
    const start = css.indexOf(`@media ${media} {`);
    assert.ok(start >= 0, `a "@media ${media}" block`);
    let depth = 0;
    let end = css.indexOf("{", start);
    for (; end < css.length; end += 1) {
      if (css[end] === "{") depth += 1;
      if (css[end] === "}" && (depth -= 1) === 0) break;
    }
    scope = css.slice(css.indexOf("{", start) + 1, end);
  } else {
    // Top-level rules only: drop every @media block.
    scope = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  }
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return scope.match(new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

test("one popular list, read by every agent list; phones show it first and wider screens keep each list's order", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { popularAgents, phoneOrder } = await vite.ssrLoadModule("/src/popular-agents.tsx");
  const { directoryNames } = await vite.ssrLoadModule("/src/teams.tsx");
  const { mcpTools } = await vite.ssrLoadModule("/src/setup-page.tsx");
  const { renderPublic } = await vite.ssrLoadModule("/src/prerender.tsx");
  assert.deepEqual([...popularAgents], popular, "the owner's popular agents, in the owner's order");

  const directory = directoryNames.map((name) => ({ name }));
  assert.deepEqual(
    phoneOrder(directory).popular.map(({ name }) => name),
    popular,
    "Home's grid has every popular agent",
  );
  assert.deepEqual(
    phoneOrder(mcpTools).popular.map(({ name }) => name),
    ["Codex", "Muse", "Hermes", "OpenClaw", "Grok", "Antigravity"],
    "the Setup tool rows show the popular agents they have, in the popular order",
  );
  for (const list of [directory, mcpTools]) {
    const { popular: shown, rest } = phoneOrder(list);
    assert.equal(shown.length + rest.length, list.length, "no agent is lost");
    assert.deepEqual(
      rest.map(({ name }) => name),
      list.map(({ name }) => name).filter((name) => !popular.includes(name)),
      "the rest keep the list's own order",
    );
  }

  const pages = {
    "/": [{ className: "tm-grid", names: directoryNames }],
    "/setup": [
      { className: "su-tools su-tools-links", names: mcpTools.map(({ name }) => name) },
      { className: "su-tools", names: mcpTools.map(({ name }) => name) },
    ],
  };
  for (const [path, expected] of Object.entries(pages)) {
    const lists = agentLists(renderPublic(path));
    assert.equal(lists.length, expected.length, `${path}: every agent list is short on phones`);
    for (const [index, { className, names }] of expected.entries()) {
      const list = lists[index];
      const where = `${path} ${className}`;
      assert.equal(list.wideClass, className, `${where}: the whole list keeps its style`);
      assert.equal(list.phoneClass, className, `${where}: the phone list looks the same`);
      assert.deepEqual(list.wide, names, `${where}: wider screens show every agent in order`);
      const shown = list.phone.filter(({ rest }) => !rest).map(({ name }) => name);
      const hidden = list.phone.filter(({ rest }) => rest).map(({ name }) => name);
      assert.deepEqual(
        shown,
        popular.filter((name) => names.includes(name)),
        `${where}: phones show the popular agents first, in the popular order`,
      );
      assert.ok(shown.length <= 9, `${where}: two or three rows on a phone`);
      assert.deepEqual(
        hidden,
        names.filter((name) => !popular.includes(name)),
        `${where}: the rest follow in the list's order, hidden until asked for`,
      );
      assert.deepEqual(
        list.phone.map(({ name }) => name),
        [...shown, ...hidden],
        `${where}: popular before the rest`,
      );
      // A real button, collapsed at first, naming how many it hides and the list it opens.
      assert.match(list.button, /^<button class="pa-more" type="button"/, `${where}: a button`);
      assert.match(list.button, /aria-expanded="false"/, `${where}: collapsed at first`);
      assert.ok(list.button.includes(`aria-controls="${list.id}"`), `${where}: controls its list`);
      assert.match(
        decode(list.button.replaceAll("<!-- -->", "")),
        new RegExp(`>More agents \\(${hidden.length}\\)</button>$`),
        `${where}: "More agents (N)"`,
      );
    }
  }
});

test("phones get Teams, Pricing and Docs in the header, and Setup and Access first in the footer", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { renderPublic, publicPages } = await vite.ssrLoadModule("/src/prerender.tsx");
  for (const { path } of publicPages) {
    const html = renderPublic(path);
    const header = html.match(/<nav class="fb-nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
    const footer = html.match(/<nav class="fb-foot-links"[\s\S]*?<\/nav>/)?.[0] ?? "";
    const links = (nav) =>
      [...nav.matchAll(/<a\b([^>]*)>([^<]+)<\/a>/g)].map(([, attributes, name]) => ({
        name,
        className: attributes.match(/class="([^"]*)"/)?.[1] ?? "",
        current: attributes.includes('aria-current="page"'),
      }));
    const top = links(header);
    assert.deepEqual(
      top.map(({ name }) => name),
      ["Teams", "Setup", "Access", "Pricing", "Docs", "llms.txt"],
      `${path}: wider screens keep the whole header`,
    );
    assert.deepEqual(
      top.filter(({ className }) => className !== "fb-nav-wide").map(({ name }) => name),
      ["Teams", "Pricing", "Docs", "llms.txt"],
      `${path}: phones keep Teams, Pricing and Docs (llms.txt is hidden on phones everywhere)`,
    );
    const bottom = links(footer);
    assert.deepEqual(
      bottom.slice(0, 2).map(({ name, className }) => [name, className]),
      [
        ["Setup", "fb-foot-phone"],
        ["Access", "fb-foot-phone"],
      ],
      `${path}: Setup and Access lead the footer's links, for phones`,
    );
    for (const [name, href] of [
      ["Setup", "/setup"],
      ["Access", "/access"],
    ]) {
      assert.equal(
        top.find((link) => link.name === name)?.current,
        path === href,
        `${path}: the header marks ${name} current only on its page`,
      );
      assert.equal(
        bottom.find((link) => link.name === name)?.current,
        path === href,
        `${path}: the footer marks ${name} current only on its page`,
      );
    }
    assert.ok(
      bottom.some(({ name }) => name === "llms.txt"),
      `${path}: wider screens keep llms.txt in the footer`,
    );
  }
});

test("the stylesheets hide llms.txt, the header's Setup and Access and the long lists on phones only", async () => {
  const read = (file) => readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
  const landing = await read("landing.css");
  const layout = await read("landing-layout.css");
  const phone = "(max-width: 720px)";
  const phoneWithScript = "(max-width: 720px) and (scripting: enabled)";
  const hidden = /display:\s*none/;

  assert.match(
    rule(landing, ".lp .lp-docs > .lp-llms", phone),
    hidden,
    "no llms.txt link on phones",
  );
  assert.doesNotMatch(
    rule(landing, ".lp .lp-docs > .lp-llms"),
    hidden,
    "llms.txt stays on wider screens",
  );
  // The phone header shows its Docs pair's links with `.fb-nav .lp-docs > a`; the hiding rule must
  // outrank it (three classes against two and an element) or the header keeps llms.txt.
  assert.match(rule(layout, ".fb-nav .lp-docs > a", phone), /display:\s*inline-flex/);

  assert.match(rule(layout, ".fb-nav > a.fb-nav-wide", phone), hidden, "header: phones only");
  assert.doesNotMatch(rule(layout, ".fb-nav > a.fb-nav-wide"), hidden, "header: wider screens");
  assert.match(rule(layout, ".fb-foot-links > a.fb-foot-phone"), hidden, "footer: not on wide");
  assert.match(
    rule(layout, ".fb-foot-links > a.fb-foot-phone", phone),
    /display:\s*inline/,
    "footer: Setup and Access show on phones",
  );

  assert.match(rule(landing, ".pa-phone"), hidden, "wider screens never show the phone list");
  assert.match(rule(landing, ".lp .pa-wide", phoneWithScript), hidden, "phones: no whole list");
  assert.match(rule(landing, ".lp .pa-phone", phoneWithScript), /display:\s*grid/);
  assert.match(
    rule(landing, ".lp .pa-phone:not([data-expanded]) [data-rest]", phoneWithScript),
    hidden,
    "phones hide the rest until the button opens them",
  );
  // The phone breakpoint is the site's existing one.
  assert.ok(layout.includes(`@media ${phone} {`), "landing-layout.css keeps its 720px breakpoint");
});
