/*
  A tab keeps the release it loaded. Each deploy replaces the Worker's static assets, so an older
  tab that later loads a code-split screen asks for hashed files that no longer exist and gets a
  404 (Sentry TALKTO-WEB-J). Reloading fetches the current release at the same URL. A marker in
  sessionStorage allows one reload per short window, so a chunk that still fails after the reload
  reaches the error screen and Sentry as before.
*/

const marker = "talkto-chunk-reload";
const reloadWindowMs = 20_000;

// Chrome, Firefox and Safari's failed dynamic import, and Vite's failed CSS preload.
const loadFailure =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS for /;

/** Reload once for a chunk load failure; false when the error is unrelated or a reload just ran. */
function reloadForChunkFailure(error: Error): boolean {
  // A failed fetch of a code-split file, not a failure inside it.
  if (!loadFailure.test(error.message)) return false;
  const now = Date.now();
  try {
    const elapsed = now - Number(sessionStorage.getItem(marker));
    if (elapsed >= 0 && elapsed < reloadWindowMs) return false;
    sessionStorage.setItem(marker, String(now));
  } catch {
    // Without storage the guard cannot hold, so show the error instead of risking a reload loop.
    return false;
  }
  location.reload();
  return true;
}

/** Load a code-split module; a file missing after a deploy reloads the page instead of failing. */
export const loadChunk = <T>(load: () => Promise<T>): Promise<T> =>
  load().catch((error) => {
    if (!(error instanceof Error) || !reloadForChunkFailure(error)) throw error;
    // The page is reloading: keep the loading state instead of rendering the error screen.
    return new Promise<T>(() => undefined);
  });
