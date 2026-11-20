import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

// "Update available" on an agent card: shown only for a recent report of a known plugin that is
// behind the newest release, and it links to that plugin's update steps.
test("the dashboard shows Update available only for a recent, older plugin report", async (t) => {
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { PluginUpdate, pluginUpdateDue, staleReportDays } =
    await vite.ssrLoadModule("/src/plugin-update.tsx");
  const P = await vite.ssrLoadModule("@talkto/api/plugins");
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const seen = (name, version, daysAgo = 1) => ({
    name,
    version,
    seenAt: new Date(now - daysAgo * 86_400_000).toISOString(),
  });

  const due = pluginUpdateDue(seen("hermes", "0.0.1"), now);
  assert.deepEqual(due, {
    current: "0.0.1",
    latest: P.latestPluginVersions.hermes,
    href: "/docs/updates/#hermes-agent",
  });
  const html = renderToStaticMarkup(
    createElement(PluginUpdate, { plugin: seen("hooks", "0.0.1"), now }),
  );
  assert.match(html, /^<a class="plugin-update" href="\/docs\/updates\/#talkto-hooks"/);
  assert.match(html, />Update available<\/a>$/);
  assert.match(
    html,
    new RegExp(
      `runs plugin 0.0.1; ${P.latestPluginVersions.hooks.replaceAll(".", "\\.")} is available`,
    ),
  );

  for (const [plugin, why] of [
    [undefined, "no plugin report (MCP alone, or a plugin before 0.3.0)"],
    [seen("claude-code", P.latestPluginVersions["claude-code"]), "current"],
    [seen("claude-code", "99.0.0"), "newer than this server knows"],
    [seen("muse", "0.0.1"), "a plugin this server does not know"],
    [seen("pi", "0.0.1", staleReportDays + 1), "a report older than two weeks"],
  ]) {
    assert.equal(pluginUpdateDue(plugin, now), null, why);
    assert.equal(renderToStaticMarkup(createElement(PluginUpdate, { plugin, now })), "", why);
  }
});
