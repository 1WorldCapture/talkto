import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer as createVite } from "vite";
import { brandMisspellings, testedClaim, words } from "./copy-rules.mjs";

/*
  The Connect agents dialog's per-agent setup (agentGuides in landing-parts.tsx), checked against
  the agent guide the same way public-copy.test.mjs checks the Setup page: every command, entry,
  link, typed word and on-screen name must be in that agent's guide, rendered for the same
  deployment. Run for the hosted deployment and for another one, since plugin setups differ.
*/

const decode = (text) =>
  text
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

test("every dialog recipe matches the agent guide", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const doc = await vite.ssrLoadModule("@talkto/api/documentation");
  const parts = await vite.ssrLoadModule("/src/landing-parts.tsx");
  const { brandMarks } = await vite.ssrLoadModule("/src/agent-brand-marks.tsx");
  // The walkthrough the Connect agents dialog renders (agent-walkthrough.tsx).
  const { Walkthrough, StepContent, planOf } = await vite.ssrLoadModule(
    "/src/agent-walkthrough.tsx",
  );
  const raw = await readFile(new URL("../../server/src/instructions.md", import.meta.url), "utf8");
  // The docs site's agent pages: every Full guide link must land on one, at a real section.
  const { agentPages } = await vite.ssrLoadModule(
    new URL("../../docs/src/agents.ts", import.meta.url).pathname,
  );
  const pages = new Map(agentPages.map((page) => [page.slug, page]));
  const anchor = (title) =>
    title
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, "")
      .replaceAll(" ", "-");
  assert.equal(parts.agentsIndexUrl, "/docs/agents/");

  const ids = parts.agentGuides.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length, "agent ids are unique slugs");
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]*$/, `${id} is a lowercase slug`);
  assert.equal(ids.at(-1), "mcp", "Another tool comes last");
  const common = parts.agentGuides.filter((guide) => guide.common);
  assert.ok(common.length >= 6, "the common agents show first");
  // The main grid: plugin tools lead, and one tile per vendor (mark), so the Claude app never sits
  // beside Claude Code. Same-vendor variants wait under More agents with their own names.
  const plugins = ["claude-code", "opencode", "pi"];
  assert.deepEqual(
    common.slice(0, plugins.length).map(({ id }) => id),
    plugins,
    "plugin tools come first",
  );
  assert.equal(new Set(common.map(({ mark }) => mark)).size, common.length, "one tile per vendor");
  const claudeApp = parts.agentGuides.find(({ id }) => id === "claude");
  assert.equal(claudeApp.common, false, "the Claude app is under More agents");
  assert.equal(claudeApp.name, "Claude app", "the Claude app says it is the app");
  const names = parts.agentGuides.map(({ name }) => name.toLowerCase());
  assert.equal(new Set(names).size, names.length, "every tile has its own name");

  for (const origin of [parts.siteOrigin, "https://talkto.example"]) {
    const mcpUrl = doc.mcpEndpoint(origin);
    const guide = doc.renderDocumentation(raw, origin);
    const headings = new Set([...guide.matchAll(/^### (.+)$/gm)].map((m) => m[1]));
    for (const agent of parts.agentGuides) {
      const at = `${agent.name} (${origin}): `;
      assert.ok(headings.has(agent.docs), `${at}the guide has "### ${agent.docs}"`);
      assert.ok(brandMarks.includes(agent.mark), `${at}${agent.mark} is a brand mark`);
      assert.doesNotMatch(agent.mark, /kiro/, `${at}the brand kit allows no Kiro mark`);
      const url = parts.agentGuideUrl(agent.id);
      const [, slug, section] = url.match(/^\/docs\/agents\/([a-z0-9-]+)\/(?:#(.+))?$/) ?? [];
      const page = pages.get(slug);
      assert.ok(page, `${at}Full guide ${url} is a docs page`);
      if (agent.page === undefined) assert.equal(slug, agent.id, `${at}the id is the docs slug`);
      assert.ok(
        page.parts.some(({ heading }) => heading === agent.docs),
        `${at}the docs page covers "### ${agent.docs}"`,
      );
      if (section)
        assert.ok(
          page.parts.some(({ title }) => anchor(title) === section),
          `${at}#${section} is a section of ${slug}`,
        );

      const setup = agent.setup(mcpUrl);
      const extraTitles = new Set(setup.extras.map(({ title }) => title));
      const steps = [
        ...setup.steps,
        ...setup.extras.flatMap(({ steps }) => steps),
        ...(setup.wake?.steps ?? []),
      ];
      // A connect-way that names another recipe names a real one; waking appears only where the
      // guide documents it, and Auto-start only where the routine's link is pasted.
      for (const way of agent.ways ?? [])
        if (way.guide !== undefined)
          assert.ok(ids.includes(way.guide), `${at}way "${way.title}" opens ${way.guide}`);
      if (setup.wake !== undefined)
        assert.ok(
          setup.wake.steps.some(({ text }) => text.includes("**Auto-start**")) ===
            setup.wake.autoStart,
          `${at}Auto-start appears exactly when the wake is pasted there`,
        );
      const texts = [...steps.map(({ text }) => text), ...(setup.notes ?? [])];
      for (const step of steps) {
        for (const line of step.lines ?? [])
          assert.ok(guide.includes(line), `${at}the guide gives "${line}"`);
        if (step.link)
          assert.ok(
            guide.includes(step.link.href) ||
              [parts.cursorLink, doc.vscodeWebInstallLink(mcpUrl)].includes(step.link.href),
            `${at}${step.link.href} is the guide's link`,
          );
        if (step.link?.href.startsWith("cursor:"))
          assert.equal(step.link.href, doc.cursorInstallLink(mcpUrl));
        if (step.link?.href.startsWith("https://vscode.dev"))
          assert.equal(step.link.href, doc.vscodeWebInstallLink(mcpUrl));
      }
      for (const text of texts) {
        for (const [, typed] of text.matchAll(/`([^`]+)`/g))
          assert.ok(guide.includes(typed) || typed === mcpUrl, `${at}the guide has \`${typed}\``);
        for (const [, name] of text.matchAll(/\*\*([^*]+)\*\*/g))
          assert.ok(
            guide.includes(`**${name}`) || guide.includes(name) || extraTitles.has(name),
            `${at}the guide names **${name}**`,
          );
      }
      const pluginNote = (setup.notes ?? []).some((note) => note.includes("talkto.sh"));
      if (agent.how === "Plugin" && ["claude", "opencode", "pi"].includes(agent.id))
        assert.equal(
          pluginNote,
          mcpUrl !== doc.pluginDefaultMcpUrl,
          `${at}the plugin note shows only away from talkto.sh`,
        );

      // The rendered step: every code block and inline code is from the guide; no tested label.
      // The plan, then every step's page, with "Answers on its own" chosen so the wake steps render.
      const noop = () => {};
      const plan = renderToStaticMarkup(
        createElement(Walkthrough, {
          guide: agent,
          mcpUrl,
          serverName: "Release",
          prompt: "Join Release.",
          waking: true,
          setWaking: noop,
          switchGuide: noop,
          joined: null,
          autoStart: () => null,
          finish: noop,
          chooseAnother: noop,
        }),
      );
      // One page is one thing to do, under a short title of its own.
      for (const waking of [true, false]) {
        const titles = planOf(agent, setup, "Release", waking, false).map((step) => step.title);
        assert.equal(new Set(titles).size, titles.length, `${at}each step has its own title`);
        for (const title of titles) {
          assert.doesNotMatch(title, /\.$|Another tool/, `${at}"${title}" reads as a title`);
          assert.ok(title.split(" ").length <= 7, `${at}"${title}" is short`);
        }
        assert.ok(titles.at(-1) !== undefined, `${at}the walkthrough has steps`);
      }
      const html = [
        plan,
        ...planOf(agent, setup, "Release", true, false).map((step) =>
          renderToStaticMarkup(
            createElement(StepContent, {
              step,
              guide: agent,
              setup,
              mcpUrl,
              prompt: "Join Release.",
              joined: { id: "joined", name: "release-agent" },
              check: undefined,
              autoStart: () => null,
              copyClassName: "btn",
            }),
          ),
        ),
      ].join("");
      for (const [, code] of html.matchAll(/<code>([\s\S]*?)<\/code>/g)) {
        const text = decode(code);
        assert.ok(
          guide.includes(text) || text === mcpUrl,
          `${at}rendered "${text}" is in the guide`,
        );
      }
      assert.doesNotMatch(html, /live[- ]tested/i, `${at}no Live-tested label`);
      assert.deepEqual(
        [...words(html).matchAll(testedClaim)].map((m) => m[0]),
        [],
        `${at}no tested claim`,
      );
      assert.deepEqual(
        [
          ...words(
            html.replace(/<code>[\s\S]*?<\/code>|<textarea[\s\S]*?<\/textarea>/g, " "),
          ).matchAll(brandMisspellings),
        ].map((m) => m[0]),
        [],
        `${at}agent names as their makers write them (docs/brand-names.md)`,
      );
      assert.doesNotMatch(html, /\bsupported\b/i, `${at}no support claim`);
      assert.ok(html.includes(`href="${url.replaceAll("&", "&amp;")}"`), `${at}links its guide`);
    }
  }
});

// The TalkTo hooks are their own recommended step for a tool that offers them, after the join and
// last of all, so Skip and Done both end the walkthrough. A tool without hooks never gets it.
test("the hooks step comes only for hooks tools, after the join, as the last step", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { planOf } = await vite.ssrLoadModule("/src/agent-walkthrough.tsx");
  const { agentGuides } = await vite.ssrLoadModule("/src/landing-parts.tsx");
  const guides = await vite.ssrLoadModule("@talkto/api/agent-guides");
  const mcpUrl = "https://talkto.sh/mcp";
  const withHooks = [];
  for (const guide of agentGuides) {
    const setup = guide.setup(mcpUrl);
    const offers = guides.hooksOf(setup) !== null;
    if (offers) withHooks.push(guide.id);
    for (const waking of [true, false])
      for (const skipInstall of [false, true]) {
        const at = `${guide.id} (waking ${waking}, skipInstall ${skipInstall}): `;
        const kinds = planOf(guide, setup, "Release", waking, skipInstall).map((step) => step.kind);
        const hooks = kinds.indexOf("hooks");
        assert.equal(hooks >= 0, offers, `${at}hooks step only where the guide offers hooks`);
        if (!offers) continue;
        assert.equal(kinds.filter((kind) => kind === "hooks").length, 1, at);
        assert.ok(hooks > kinds.indexOf("join"), `${at}after the join`);
        assert.equal(hooks, kinds.length - 1, `${at}the last step`);
      }
  }
  assert.ok(
    withHooks.includes("codex") && !withHooks.includes("claude-code"),
    "Codex, not Claude Code",
  );
  // The install page no longer folds the hooks away: they have their own step.
  const codex = agentGuides.find((guide) => guide.id === "codex");
  const [install] = planOf(codex, codex.setup(mcpUrl), "Release", true, false);
  assert.equal(install.kind, "install");
});

// Setup (onboarding.tsx) gives one message per agent. It names the tool's own install file, which
// must exist for that tool and tell the agent to wait for the join prompt this message is.
test("setup's message for each agent names its real install file and its slot's key", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { slotPrompt } = await vite.ssrLoadModule("/src/onboarding.tsx");
  const { agentGuides } = await vite.ssrLoadModule("/src/landing-parts.tsx");
  const guides = await vite.ssrLoadModule("@talkto/api/agent-guides");
  const O = await vite.ssrLoadModule("@talkto/api/onboarding");
  const runId = "a1b2c3d4-0000-4e5f-8a9b-1c2d3e4f5a6b";
  const server = { id: "3f6c1f4e-8a43-4b8e-9f52-1c2d3e4f5a6b", name: "Release" };
  for (const origin of ["https://talkto.sh", "https://talkto.example"]) {
    const mcpUrl = `${origin}/mcp`;
    for (const [index, guide] of agentGuides.entries()) {
      const slot = index % 2;
      const message = slotPrompt({ server, mcpUrl, runId, slot, guide });
      const at = `${guide.name} (${origin}): `;
      assert.ok(
        message.includes(`requestKey "${O.agentRequestKey(runId, slot)}"`),
        `${at}the slot's request key`,
      );
      if (guide.id === "mcp") {
        assert.ok(message.includes(`connect ${mcpUrl}`), `${at}Another tool connects the address`);
        continue;
      }
      const url = guides.installGuideUrl(origin, guide.id);
      assert.ok(message.includes(`read ${url} and follow it`), `${at}names its install file`);
      const file = guides.installGuide(new URL(url).pathname, origin);
      assert.ok(file, `${at}the install file exists`);
      assert.match(file, /join prompt/, `${at}the install file waits for the join prompt`);
      assert.deepEqual(
        [...words(message).matchAll(brandMisspellings)].map((m) => m[0]),
        [],
        `${at}agent names as their makers write them`,
      );
    }
  }
});
