import { createServer } from "node:http";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { migratePlatform } from "./platform-migrations.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const build = resolve(here("../../../.runtime/dist/render"));
const config = JSON.parse(await readFile(resolve(build, "runtime.json"), "utf8"));
const origin = process.env.RENDER_EXTERNAL_URL ?? process.env.TALKTO_SERVICE_ORIGIN;
const port = Number(process.env.PORT ?? 10000);
const persistence = process.env.TALKTO_DATA_DIR ?? "/var/data/talkto";
const required = [
  "BETTER_AUTH_SECRET",
  "TALKTO_OWNER_EMAILS",
  "TALKTO_SIGNAL_KEY",
  "TALKTO_API_KEY_SECRET",
].filter((name) => !process.env[name]?.trim());
if (!/^https:\/\/[^\s/]+$/.test(origin ?? "")) {
  throw new Error("Set RENDER_EXTERNAL_URL or TALKTO_SERVICE_ORIGIN to the public HTTPS origin.");
}
if (required.length > 0) throw new Error(`Missing required environment: ${required.join(", ")}`);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");

await mkdir(persistence, { recursive: true });
const files = await readdir(build);
const modules = [
  { type: "ESModule", path: resolve(build, "worker.js") },
  ...files
    .filter((name) => name.endsWith(".sql") || name.endsWith(".md"))
    .map((name) => ({ type: "Text", path: resolve(build, name) })),
];
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    name: "talkto",
    modules,
    modulesRoot: build,
    compatibilityDate: config.compatibilityDate,
    compatibilityFlags: config.compatibilityFlags,
    resourcePersistencePath: persistence,
    resourceTmpPath: process.env.TALKTO_TMP_DIR,
    durableObjects: {
      SERVERS: { className: "TalkToServer", useSQLite: true },
      QUOTAS: { className: "WorkspaceQuota", useSQLite: true },
    },
    d1Databases: { PLATFORM: "talkto-platform" },
    ratelimits: config.ratelimits,
    assets: {
      directory: resolve(here("../../web/dist")),
      binding: "ASSETS",
      routerConfig: { has_user_worker: true },
      run_worker_first: config.assets.run_worker_first,
      assetConfig: { not_found_handling: config.assets.not_found_handling },
    },
    bindings: {
      TALKTO_SELF_HOSTED: "true",
      TALKTO_SERVICE_ORIGIN: origin,
      TALKTO_AUTH_PROVIDER: "better-auth",
      TALKTO_OWNER_EMAILS: process.env.TALKTO_OWNER_EMAILS,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
      TALKTO_SIGNAL_KEY: process.env.TALKTO_SIGNAL_KEY,
      TALKTO_API_KEY_SECRET: process.env.TALKTO_API_KEY_SECRET,
      TALKTO_UNPAID_SERVER_LIMIT: "1",
      TALKTO_SERVER_CREATIONS_PER_HOUR: "20",
      TALKTO_ORGANIZATION_CREATIONS_PER_HOUR: "5",
      TALKTO_UNPAID_SERVER_DAILY_LIMIT: "1000",
      TALKTO_INVITATION_PAID_DAILY_LIMIT: "200",
      TALKTO_INVITATION_RECIPIENT_COOLDOWN_MINUTES: "10",
      TALKTO_INVITATION_RECIPIENT_DAILY_LIMIT: "3",
      TALKTO_READ_LIMITS: "on",
      TALKTO_PARTICIPANT_READS_PER_MINUTE: "300",
      TALKTO_BOARD: "off",
      SENTRY_ENVIRONMENT: "render",
    },
  }),
);

let stopping = false;
let maintenance;
const close = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(maintenance);
  server.close();
  await runtime.dispose();
};

try {
  await runtime.ready;
  const applied = await migratePlatform(await runtime.getD1Database("PLATFORM"));
  console.info(`Platform migrations ready (${applied} applied)`);
} catch (error) {
  await runtime.dispose();
  throw error;
}

const server = createServer(async (incoming, outgoing) => {
  if (stopping) {
    outgoing.writeHead(503, { connection: "close" });
    outgoing.end();
    return;
  }
  try {
    const path = incoming.url ?? "/";
    if (path === "/cdn-cgi" || path.startsWith("/cdn-cgi/")) {
      outgoing.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      outgoing.end("Not found\n");
      return;
    }
    const headers = new Headers();
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
      const name = incoming.rawHeaders[index];
      const value = incoming.rawHeaders[index + 1];
      if (name.toLowerCase() === "host") continue;
      headers.append(name, value);
    }
    headers.set("host", new URL(origin).host);
    // Render terminates TLS. TalkTo must see the public HTTPS origin, and clients cannot spoof IP.
    const forwarded = incoming.headersDistinct["x-forwarded-for"] ?? [];
    const clientAddress = forwarded
      .flatMap((value) => value.split(","))
      .at(-1)
      ?.trim();
    headers.set("cf-connecting-ip", clientAddress || incoming.socket.remoteAddress || "");
    headers.set("x-forwarded-proto", "https");
    const method = incoming.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : incoming;
    const response = await runtime.dispatchFetch(new URL(path, origin), {
      method,
      headers,
      body,
      duplex: "half",
      redirect: "manual",
    });
    const responseHeaders = Object.fromEntries(response.headers);
    delete responseHeaders["set-cookie"];
    outgoing.writeHead(response.status, {
      ...responseHeaders,
      "set-cookie": response.headers.getSetCookie(),
    });
    if (response.body === null) outgoing.end();
    else {
      const reader = response.body.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (!outgoing.write(next.value)) await new Promise((done) => outgoing.once("drain", done));
      }
      outgoing.end();
    }
  } catch (error) {
    console.error("Render ingress failed", error);
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  }
});

const worker = await runtime.getWorker();
let maintaining = false;
const runMaintenance = async () => {
  if (maintaining || stopping) return;
  maintaining = true;
  try {
    await worker.scheduled({ cron: "* * * * *", scheduledTime: new Date() });
  } catch (error) {
    console.error("Scheduled maintenance failed", error);
  } finally {
    maintaining = false;
  }
};
maintenance = setInterval(runMaintenance, 60_000);
maintenance.unref();
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    void close().then(() => process.exit(0));
  });
}
await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(port, "0.0.0.0", resolveListen);
});
console.info(`TalkTo listening on 0.0.0.0:${port}; data: ${persistence}`);
