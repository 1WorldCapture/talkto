/*
  /robots.txt. Production (talkto.sh) lets every crawler, AI crawlers included, read the public
  pages: the site, docs, guides, FAQ, pricing, updates, agent setup files and llms.txt. Its Content-Signal allows
  search, AI answers and AI training (owner decision, November 16, 2026). The dashboard, sign-in, the
  API and MCP are closed to crawlers; they hold nothing to read without signing in. Staging and
  self-hosted copies close everything, since they are private deployments.

  Cloudflare's managed robots.txt and "Block AI bots" must be off for talkto.sh, or Cloudflare's
  file is served in front of this one (docs/production-deployment.md, "Crawlers").
*/

import { Schema } from "effect";

export const path = "/robots.txt";

/** Hosted production sets SENTRY_ENVIRONMENT "production" (wrangler.production.jsonc). */
const Production = Schema.Struct({ SENTRY_ENVIRONMENT: Schema.Literal("production") });

const closed = ["/app", "/onboarding", "/auth", "/v1/", "/mcp", "/webhooks/", "/email/"];

export function body(origin: string, production: boolean): string {
  if (!production) return "User-agent: *\nDisallow: /\n";
  return [
    "# TalkTo's public pages are open to search engines and AI crawlers.",
    "# Content-Signal: https://contentsignals.org",
    "User-agent: *",
    "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
    "Allow: /",
    ...closed.map((prefix) => `Disallow: ${prefix}`),
    "",
    `Sitemap: ${origin}/docs/sitemap-index.xml`,
    "",
  ].join("\n");
}

/** True on hosted production; parse the Worker environment with it before calling `serve`. */
export const isProduction = Schema.is(Production);

export function serve(request: Request, production: boolean): Response {
  return new Response(body(new URL(request.url).origin, production), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
