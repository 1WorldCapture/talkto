import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { start } from "../test/platform-harness.mjs";

// Real local Worker/D1/DO/session seams; external identity and agent clients are controlled.
const cleanup = [];
const app = await start({ after: (fn) => cleanup.push(fn) });
// Own the preview assets so staging builds cannot replace them or enable live telemetry.
const root = await mkdtemp(resolve(tmpdir(), "talkto-onboarding-"));
cleanup.push(() => rm(root, { recursive: true, force: true }));
await promisify(execFile)("pnpm", ["exec", "vite", "build", "--outDir", root], {
  cwd: resolve("../web"),
  env: { ...process.env, VITE_SENTRY_DSN: "", VITE_SENTRY_ENVIRONMENT: "test" },
});
const port = Number(process.env.TALKTO_PREVIEW_PORT ?? 5175);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid preview port");
const origin = `http://localhost:${port}`;
// The same preview at 127.0.0.1, for browsers whose automation may load only loopback addresses.
const origins = new Set([origin, `http://127.0.0.1:${port}`]);
let offline = false;
let drop = false;
const mime = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".html": "text/html",
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    const user = url.searchParams.get("user") ?? "user_alice";
    if (url.pathname === "/__test/offline") {
      offline = url.searchParams.get("value") === "true";
      res.end("set");
      return;
    }
    if (url.pathname === "/__test/drop") {
      drop = true;
      res.end("armed");
      return;
    }
    if (url.pathname === "/__test/state") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(await app.call(user, "GET", "/v1/onboarding")));
      return;
    }
    if (url.pathname === "/__test/agent") {
      const state = await app.call(user, "GET", "/v1/onboarding");
      const index = Number(url.searchParams.get("slot") ?? 0);
      const account = await app.call(user, "GET", `/v1/accounts/${state.run.setup.accountId}`);
      await app.mcp(await app.mcpToken(account.organizationId, user), "register_participant", {
        serverId: state.run.setup.serverId,
        agentType: [...state.run.agents, ...(state.run.moreAgents ?? [])][index].agentType,
        name: url.searchParams.get("name") ?? (index === 0 ? "release-guide" : "design-partner"),
        requestKey: `onboarding:${state.run.id}:agent:${index}`,
      });
      res.end("joined through MCP");
      return;
    }
    if (url.pathname === "/__test/accept") {
      const state = await app.call(user, "GET", "/v1/onboarding");
      await app.control("accept-invitation", { id: state.run.invitation.id, userId: "user_bob" });
      res.end("accepted by controlled provider");
      return;
    }
    if (url.pathname === "/__test/login" || url.pathname === "/auth/login") {
      const flow = await app.browserLogin(user, "30m");
      const callback = await flow.callback();
      const target = url.searchParams.get("return_to");
      res.writeHead(303, {
        location: target === "/onboarding" ? target : "/app",
        "set-cookie": callback.headers.getSetCookie(),
      });
      res.end();
      return;
    }
    if (
      url.pathname.startsWith("/v1/") ||
      url.pathname.startsWith("/auth/") ||
      url.pathname === "/instructions"
    ) {
      const bytes = [];
      for await (const chunk of req) bytes.push(chunk);
      const response = offline
        ? null
        : await app.raw(url.pathname + url.search, {
            method: req.method,
            headers: {
              cookie: req.headers.cookie ?? "",
              "content-type": "application/json",
              origin: origins.has(req.headers.origin ?? "")
                ? "https://talkto.test"
                : (req.headers.origin ?? ""),
            },
            body: bytes.length ? Buffer.concat(bytes) : undefined,
            redirect: "manual",
          });
      if (offline || (drop && req.method === "POST" && url.pathname === "/v1/onboarding")) {
        drop = false;
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "storage_unavailable",
              message: "Temporary test interruption. Your saved progress can be reloaded.",
            },
            meta: {
              requestId: randomUUID(),
              serverTime: new Date().toISOString(),
              instructions: { url: "https://talkto.test/instructions", text: "Test instructions" },
            },
          }),
        );
        return;
      }
      const headers = Object.fromEntries(response.headers);
      delete headers["set-cookie"];
      if (url.pathname === "/auth/logout" && response.status === 303) headers.location = "/";
      res.writeHead(response.status, { ...headers, "set-cookie": response.headers.getSetCookie() });
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const path = resolve(root, `.${url.pathname}`);
    if (!path.startsWith(`${root}/`) && path !== root) {
      res.writeHead(404);
      res.end();
      return;
    }
    const asset = extname(path) ? path : `${root}/index.html`;
    res.setHeader("content-type", mime[extname(asset)] ?? "application/octet-stream");
    res.end(await readFile(asset));
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end("Test fixture failed");
  }
});
server.listen(port, "127.0.0.1", () => console.log(`${origin}/onboarding`));
process.on("SIGINT", async () => {
  server.close();
  for (const dispose of cleanup) await dispose();
  process.exit(0);
});
