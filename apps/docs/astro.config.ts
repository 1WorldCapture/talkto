import { defineConfig } from "astro/config";
import type { AstroIntegration } from "astro";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";
import { generateContent } from "./src/generate.ts";
import { writeApiReference } from "./src/api-reference.ts";
import { siteOrigin } from "./src/guide.ts";

/**
 * Agent pages and a few partials come from instructions.md and pricing.ts (src/generate.ts).
 * They are written before Astro reads content, and again whenever the guide changes in dev.
 */
const generated: AstroIntegration = {
  name: "talkto-generated-pages",
  hooks: {
    "astro:config:setup": ({ config, addWatchFile }) => {
      generateContent(config.root);
      writeApiReference(config.root);
      addWatchFile(new URL("../server/src/instructions.md", config.root));
    },
  },
};

const nimbusConfig = defineNimbusConfig({
  site: siteOrigin,
  title: "TalkTo",
  description: "Channels and direct chats for coding agents and personal assistants.",
  locale: "en",
  // The header's GitHub button: TalkTo's public source.
  github: "https://github.com/plannotator/talkto",
  // The website's link-preview card (apps/web/public/og.png), copied so the docs serve it too.
  socialImage: "/opengraph.png",
  socialImageAlt:
    "TalkTo: messaging for agents. Codex, Claude Code and Grok Bot talking in a channel.",
  // talkto.sh's Worker owns /.well-known/*; the docs only live under /docs.
  agents: { discovery: false },
  sidebar: {
    items: [
      "index",
      "quickstart",
      { label: "Agents", autogenerate: { directory: "agents" } },
      { label: "Guides", autogenerate: { directory: "guides" } },
      { label: "Concepts", autogenerate: { directory: "concepts" } },
      { label: "Swarm servers", autogenerate: { directory: "swarms" } },
      "access",
      { label: "HTTP API", autogenerate: { directory: "api" } },
      "how-it-works",
      "self-host",
      "pricing",
      "troubleshooting",
      "faq",
      "updates",
    ],
  },
});

export default defineConfig({
  // Served by the talkto.sh Worker's static assets, next to the public site (tools/copy-into.mjs).
  base: "/docs",
  output: "static",
  vite: { plugins: [tailwindcss()] },
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  integrations: [
    generated,
    // Renders the site's colour agent marks (apps/web/src/agent-brand-marks.tsx) at build time.
    react(),
    nimbus(nimbusConfig, {
      rules: {
        "nimbus/frontmatter-shape": "error",
        "nimbus/internal-link": "error",
      },
      markdown: { hastPlugins: [tableScroll()] },
    }),
  ],
});
