import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, lazy, Suspense } from "react";
import { prerender } from "react-dom/static";
import { createServer as createVite } from "vite";

// A tab from an earlier release loads a screen whose files the latest deploy removed
// (Sentry TALKTO-WEB-J). Chrome's message for a missing module, and Vite's for missing CSS.
const missingModule = () =>
  new TypeError(
    "Failed to fetch dynamically imported module: https://talkto.sh/assets/dashboard-old.js",
  );
const missingCss = () =>
  new Error("Unable to preload CSS for https://talkto.sh/assets/dashboard-old.css");

/** Give the module a tab's sessionStorage and location, and count reloads. */
function browserTab(t) {
  const stored = new Map();
  const tab = { reloads: 0 };
  const globals = {
    sessionStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, String(value)),
    },
    location: { reload: () => tab.reloads++ },
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
  return tab;
}

const settled = (promise) =>
  Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
  ]);

/** The errors React reports while rendering a lazy screen behind Suspense. */
async function renderErrors(load) {
  const Screen = lazy(load);
  const errors = [];
  // A screen that never settles stops after a second, and reports the abort instead.
  await prerender(createElement(Suspense, { fallback: "Loading…" }, createElement(Screen)), {
    signal: AbortSignal.timeout(1_000),
    onError: (error) => {
      errors.push(error);
    },
  });
  return errors;
}

test("a screen missing after a deploy reloads the tab once, then shows the error", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { loadChunk } = await vite.ssrLoadModule("/src/stale-chunks.ts");
  const tab = browserTab(t);
  let now = Date.parse("2026-11-19T17:38:45.000Z");
  t.mock.method(Date, "now", () => now);

  // First failure: one reload, and the screen keeps loading instead of failing.
  assert.equal(await settled(loadChunk(() => Promise.reject(missingModule()))), "pending");
  assert.equal(tab.reloads, 1);

  // The same failure right after the reload reaches React's error handling unchanged.
  now += 5_000;
  const failure = missingCss();
  assert.deepEqual(await renderErrors(() => loadChunk(() => Promise.reject(failure))), [failure]);
  assert.equal(tab.reloads, 1);

  // A later deploy, outside the window, reloads again.
  now += 60_000;
  assert.equal(await settled(loadChunk(() => Promise.reject(missingCss()))), "pending");
  assert.equal(tab.reloads, 2);

  // A screen that loads is unaffected.
  const screen = { default: () => "Dashboard" };
  assert.equal(await loadChunk(() => Promise.resolve(screen)), screen);
});

test("other screen failures reach the error boundary without a reload", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { loadChunk } = await vite.ssrLoadModule("/src/stale-chunks.ts");
  const tab = browserTab(t);
  const broken = new TypeError("Cannot read properties of undefined (reading 'id')");
  assert.deepEqual(await renderErrors(() => loadChunk(() => Promise.reject(broken))), [broken]);
  assert.equal(tab.reloads, 0);
});

test("a tab without sessionStorage shows the error instead of risking a reload loop", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { loadChunk } = await vite.ssrLoadModule("/src/stale-chunks.ts");
  const tab = browserTab(t);
  globalThis.sessionStorage = {
    getItem: () => {
      throw new DOMException("Storage is disabled", "SecurityError");
    },
    setItem: () => undefined,
  };
  const failure = missingModule();
  await assert.rejects(
    loadChunk(() => Promise.reject(failure)),
    (error) => error === failure,
  );
  assert.equal(tab.reloads, 0);
});
