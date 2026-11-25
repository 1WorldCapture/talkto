import { lazy, Suspense } from "react";
import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { Schema, SchemaGetter } from "effect";
import * as D from "@talkto/api/dashboard";
import * as M from "@talkto/api/models";
import { PublicPage, publicPages } from "./public.js";
import { AgentSymbols } from "./agent-symbols.js";
import { loadChunk } from "./stale-chunks.js";

const Dashboard = lazy(() =>
  loadChunk(() => import("./dashboard.js")).then((module) => ({ default: module.Dashboard })),
);
const Onboarding = lazy(() =>
  loadChunk(() => import("./onboarding.js")).then((module) => ({ default: module.Onboarding })),
);
/**
 * Free text in the URL. The router reads each search value as JSON first, so a hand-typed
 * `?query=10080` (or `true`, `null`) arrives as a number, boolean or null; read it back as text.
 */
const Text = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value) => String(value)),
    encode: SchemaGetter.passthrough(),
  }),
);
const Search = Schema.Struct({
  query: Schema.optional(Text),
  cursor: Schema.optional(Text),
  channel: Schema.optional(Schema.String),
  tab: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  // The Board's task list (board.tsx): its tab, agent and label filters.
  list: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  label: Schema.optional(Text),
  billing: Schema.optional(Schema.Literals(["return", "cancel"])),
  connect: Schema.optional(Schema.Literal("agents")),
  // `?feedback=1` (the public footer's link) opens the Feedback dialog once, then is removed.
  feedback: Schema.optional(Schema.Literal(1)),
  range: Schema.optional(D.TimelineRange),
  at: Schema.optional(M.Timestamp),
  start: Schema.optional(M.Timestamp),
  end: Schema.optional(M.Timestamp),
  message: Schema.optional(M.Count),
}).check(
  D.feedWindowCheck,
  Schema.makeFilter(
    (value) => {
      if (value.start === undefined || value.end === undefined) return true;
      if (value.at === undefined || value.end > value.at) return false;
      const duration =
        value.range === "hour" ? 3_600_000 : value.range === "week" ? 604_800_000 : 86_400_000;
      return (
        new Date(value.start).getTime() >= Math.max(0, new Date(value.at).getTime() - duration)
      );
    },
    { message: "The selected interval must fit within the timeline window." },
  ),
);
/** Parsed dashboard navigation, including a shareable timeline selection. */
export type DashboardSearch = typeof Search.Type;
const root = createRootRoute({
  validateSearch: (input) => Schema.decodeUnknownSync(Search)(input),
  component: () => (
    <>
      <AgentSymbols />
      <main id="stage">
        <Outlet />
      </main>
    </>
  ),
  errorComponent: () => (
    <main className="session-panel">
      <h1>This page could not be opened.</h1>
      <a href="/app">Return to organizations</a>
    </main>
  ),
  notFoundComponent: () => (
    <p className="session-panel">
      Page not found. <a href="/">TalkTo home</a>
    </p>
  ),
});
const publicRoutes = publicPages.map((page) =>
  createRoute({
    getParentRoute: () => root,
    path: page.path,
    component: () => <PublicPage page={page.path} />,
  }),
);
const dashboard = () => (
  <Suspense
    fallback={
      <p className="session-panel" role="status">
        Loading…
      </p>
    }
  >
    <Dashboard />
  </Suspense>
);
const appRoute = createRoute({ getParentRoute: () => root, path: "/app", component: dashboard });
const appPages = createRoute({ getParentRoute: () => root, path: "/app/$", component: dashboard });

const onboarding = createRoute({
  getParentRoute: () => root,
  path: "/onboarding",
  component: () => (
    <Suspense
      fallback={
        <p className="session-panel" role="status">
          Loading setup…
        </p>
      }
    >
      <Onboarding />
    </Suspense>
  ),
});

/** Navigation owns URLs; Query remains the only remote-data cache. */
export function createAppRouter() {
  return createRouter({
    routeTree: root.addChildren([...publicRoutes, appRoute, appPages, onboarding]),
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
