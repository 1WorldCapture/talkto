/*
  The site shell for the dashboard's client-side routes. Static assets answer unknown paths with
  the nearest 404.html and a 404 status (`not_found_handling: "404-page"`), so /docs/* gets the docs
  site's own 404 page. The dashboard's routes are not files: `run_worker_first` sends them here,
  and the Worker answers with the shell, index.html, and a 200. Keep this list and
  `run_worker_first` in wrangler*.jsonc in step; test/asset-routing.test.mjs checks both.
*/

/** Paths the dashboard's router owns (apps/web/src/router.tsx): /app, /app/… and /onboarding. */
export const isShellPath = (path: string) =>
  path === "/app" || path.startsWith("/app/") || path === "/onboarding";

/** The shell from static assets, with the request's method and conditional headers. */
export const serveShell = (request: Request, assets: Fetcher) =>
  assets.fetch(new Request(new URL("/", request.url), request));

/**
 * The public website's pages (`publicPages` in apps/web/src/landing-parts.tsx). A self-hosted copy
 * has no public website, so its Wrangler config runs the Worker first for these and the Worker
 * sends them to the dashboard.
 */
export const sitePages = ["/", "/teams", "/setup", "/access", "/pricing", "/terms", "/privacy"];
/** Whether a path is one of the public website's pages, with or without a trailing slash. */
export const isSitePage = (path: string) =>
  sitePages.includes(path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);
