import { createServer } from "vite";
import { randomUUID } from "node:crypto";

// Local-only real HTTP failures. The browser fixture captures Sentry envelopes in memory.
const received = [];
let releaseSlow;
let signalCancellation;
let cancellationStarted = false;
const vite = await createServer({
  mode: "test",
  cacheDir: "node_modules/.vite-request-tracing-preview",
  server: { host: "127.0.0.1", port: 5218, strictPort: true, hmr: false },
  plugins: [
    {
      name: "request-tracing-fixture",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url, "http://localhost");
          res.setHeader("access-control-allow-origin", "*");
          const json = (value, status = 200) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(value));
          };
          if (url.pathname === "/__trace/received") return json(received);
          if (url.pathname === "/__trace/reset") {
            received.length = 0;
            cancellationStarted = false;
            signalCancellation = undefined;
            return json({ reset: true });
          }
          if (url.pathname === "/__trace/release") {
            releaseSlow();
            return json({ released: true });
          }
          if (url.pathname === "/__trace/wait-cancel") {
            if (cancellationStarted) return json({ ready: true });
            signalCancellation = () => json({ ready: true });
            return;
          }
          if (!url.pathname.startsWith("/v1/")) return next();
          const mode = url.searchParams.get("query");
          received.push({
            mode,
            trace: req.headers["sentry-trace"],
            traceparent: req.headers.traceparent ?? null,
          });
          if (url.pathname.includes("/billing/")) {
            const data = url.pathname.endsWith("/checkout/cancel")
              ? { status: "expired" }
              : url.pathname.endsWith("/checkout")
                ? {
                    status: "open",
                    url: "https://checkout.example.test/session",
                    expiresAt: new Date(Date.now() + 60000).toISOString(),
                  }
                : url.pathname.endsWith("/portal")
                  ? { url: "https://billing.example.test/portal" }
                  : { confirmed: true };
            return json({
              data,
              meta: {
                requestId: randomUUID(),
                serverTime: new Date().toISOString(),
                instructions: { url: "http://localhost/instructions", text: "Fixture" },
              },
            });
          }
          if (mode === "transport") return req.socket.destroy();
          if (mode === "timeout") return;
          if (mode === "cancel") {
            cancellationStarted = true;
            signalCancellation?.();
            return;
          }
          const failure = () => json({ PRIVATE_BODY: "private fixture data" }, 503);
          if (mode === "slow") {
            releaseSlow = failure;
            return;
          }
          if (["status", "retry"].includes(mode)) return failure();
          if (mode === "malformed") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("PRIVATE_BROKEN_JSON");
            return;
          }
          if (mode === "shape") return json({ PRIVATE_BODY: "invalid shape" });
          return json({
            data: {
              items: [],
              included: [],
              nextCursor: null,
              liveCursor: "test",
              caughtUp: true,
              freshness: { indexedThrough: null, pendingServers: 0 },
            },
            meta: {
              requestId: randomUUID(),
              serverTime: new Date().toISOString(),
              instructions: { url: "http://localhost/instructions", text: "PRIVATE_INSTRUCTIONS" },
            },
          });
        });
      },
    },
  ],
});
await vite.listen();
console.log("http://127.0.0.1:5218/test/request-tracing.html");
