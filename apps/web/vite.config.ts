import { basename } from "node:path";
import { defineConfig, loadEnv, type ServerOptions } from "vite";
import react from "@vitejs/plugin-react";

/*
  Outside a release build the release name holds the time, so every dev server's config differs
  and Vite rebuilds its dependency cache. Test files run in parallel, one process each, and only
  load modules on the server, which needs no dependency cache. Rebuilding one shared cache at once
  made tests fail and runs hang on fresh boat machines, and a full cache per file made slower
  machines time out. So tests turn the dependency optimizer off, and each test file keeps what is
  left in its own folder, named after the file.

  Tests also open no WebSocket server and watch no files. Every test's server otherwise opened
  one on Vite's fixed HMR port (24678), which only one process can hold, and watched the whole
  app folder; a server a timed-out test created after its cleanup ran kept both open.
*/
const testFile = process.env.NODE_TEST_CONTEXT === undefined ? undefined : process.argv[1];

/** APIs stay on the browser's origin in development and the deployed Worker. */
const server: ServerOptions = {
  proxy: {
    "/v1": "http://127.0.0.1:8787",
    "/auth": "http://127.0.0.1:8787",
    "/instructions": "http://127.0.0.1:8787",
    "/skill.md": "http://127.0.0.1:8787",
    "/openapi.json": "http://127.0.0.1:8787",
  },
};
if (testFile !== undefined) {
  server.ws = false;
  server.watch = null;
}

export default defineConfig(({ mode }) => ({
  // "node_modules/.vite" is Vite's own default.
  cacheDir:
    testFile === undefined ? "node_modules/.vite" : `node_modules/.vite-test/${basename(testFile)}`,
  optimizeDeps: testFile === undefined ? {} : { noDiscovery: true, include: [] },
  define: {
    // `pnpm build:production` sets TALKTO_RELEASE (talkto@<commit>) for this build and the Worker.
    __TALKTO_WEB_RELEASE__: JSON.stringify(
      loadEnv(mode, ".", "TALKTO_RELEASE").TALKTO_RELEASE ??
        `talkto-web@${new Date().toISOString()}`,
    ),
  },
  plugins: [react()],
  build: { sourcemap: "hidden" },
  server,
}));
