import { createRequire } from "node:module";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Miniflare,
  NoOpLog,
  convertV4MiniflareOptions,
  getGlobalServices,
  serializeConfig,
} from "miniflare";
import { migratePlatform } from "./platform-migrations.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const build = resolve(here("../dist/render"));
const config = JSON.parse(await readFile(resolve(build, "runtime.json"), "utf8"));
const origin = process.env.RENDER_EXTERNAL_URL ?? process.env.TALKTO_SERVICE_ORIGIN;
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

await mkdir(persistence, { recursive: true });
const debugPath = join(tmpdir(), `talkto-workerd-${process.pid}.json`);
process.env.MINIFLARE_WORKERD_CONFIG_DEBUG = debugPath;
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
    host: "127.0.0.1",
    port: 0,
    cacheAPI: false,
    logRequests: false,
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

let workerdConfig;
try {
  await runtime.ready;
  const applied = await migratePlatform(await runtime.getD1Database("PLATFORM"));
  console.error(`Platform migrations ready (${applied} applied)`);
  workerdConfig = JSON.parse(await readFile(debugPath, "utf8"), (key, value) =>
    value?.type === "Buffer" && Array.isArray(value.data) ? Buffer.from(value.data) : value,
  );
} finally {
  await runtime.dispose();
  await rm(debugPath, { force: true });
  delete process.env.MINIFLARE_WORKERD_CONFIG_DEBUG;
}

// The production ingress replaces Miniflare's development router and proxy surface.
const ingress = `
import { DurableObject } from "cloudflare:workers";

export class RenderMaintenance extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now());
    });
  }

  async alarm() {
    try {
      const result = await this.env.APP.scheduled({
        cron: "* * * * *",
        scheduledTime: new Date(),
      });
      if (result.outcome !== "ok") console.error("TalkTo maintenance did not complete", result);
    } catch (error) {
      console.error("TalkTo maintenance failed", error);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  fetch() {
    return new Response(null, { status: 204 });
  }
}

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    if (incoming.pathname === "/cdn-cgi" || incoming.pathname.startsWith("/cdn-cgi/")) {
      return new Response("Not found\\n", { status: 404 });
    }
    // Pin this tiny scheduler so the runtime does not evict it between alarms.
    await env.MAINTENANCE.get(env.MAINTENANCE.idFromName("render-maintenance")).fetch(
      new Request("https://maintenance.internal/"),
    );
    const url = new URL(incoming.pathname + incoming.search, env.TALKTO_SERVICE_ORIGIN);
    const forwarded = new Request(url, request);
    forwarded.headers.set("host", url.host);
    forwarded.headers.set("x-forwarded-proto", "https");
    const addresses = (request.headers.get("x-forwarded-for") ?? "").split(",");
    forwarded.headers.set("cf-connecting-ip", addresses.at(-1)?.trim() || "");
    return env.APP.fetch(forwarded);
  },
};
`;
workerdConfig.services = workerdConfig.services.filter(
  (service) => !["MINIFLARE_DEV_CONTROL", "email:store", "email:store-disk"].includes(service.name),
);
const entry = workerdConfig.services.find((service) => service.name === "core:entry");
entry.worker.durableObjectStorage = getGlobalServices({
  sharedOptions: {},
  allWorkerRoutes: new Map(),
  fallbackWorkerName: undefined,
  tmpPath: tmpdir(),
  log: new NoOpLog(),
  proxyBindings: [],
  durableObjectClassNames: new Map(),
}).find((service) => service.name === "core:entry").worker.durableObjectStorage;
for (const binding of entry.worker.bindings) {
  if (binding.name === "TRIGGER_HANDLERS") binding.json = "true";
}
entry.worker.bindings = entry.worker.bindings.filter(
  (binding) =>
    !["MINIFLARE_DEV_CONTROL", "MINIFLARE_EMAIL_STORE"].includes(binding.name) &&
    !binding.name.startsWith("MINIFLARE_PROXY:cache-internal:"),
);
workerdConfig.services.push({
  name: "talkto:ingress",
  worker: {
    compatibilityDate: config.compatibilityDate,
    compatibilityFlags: ["service_binding_extra_handlers"],
    modules: [{ name: "ingress.mjs", esModule: ingress }],
    bindings: [
      { name: "APP", service: { name: "assets:rpc-proxy:talkto" } },
      { name: "TALKTO_SERVICE_ORIGIN", text: origin },
      {
        name: "MAINTENANCE",
        durableObjectNamespace: {
          className: "RenderMaintenance",
          serviceName: "talkto:ingress",
        },
      },
    ],
    durableObjectNamespaces: [
      {
        className: "RenderMaintenance",
        uniqueKey: "talkto-RenderMaintenance",
        preventEviction: true,
      },
    ],
    durableObjectStorage: entry.worker.durableObjectStorage,
  },
});
workerdConfig.sockets = [
  {
    name: "entry",
    service: { name: "talkto:ingress" },
    http: {},
  },
];

if (process.argv[2] === "--config") {
  process.stdout.write(serializeConfig(workerdConfig));
} else {
  const miniflarePath = createRequire(import.meta.url).resolve("miniflare");
  const { spawn } = await import("node:child_process");
  const workerd = createRequire(miniflarePath)("workerd").default;
  const port = Number(process.env.PORT ?? 10000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
  const child = spawn(
    workerd,
    ["serve", "--binary", "--experimental", `--socket-addr=entry=0.0.0.0:${port}`, "-"],
    { stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, TZ: "UTC" } },
  );
  child.stdin.end(serializeConfig(workerdConfig));
  child.once("error", (error) => {
    console.error("Could not start workerd", error);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) console.error(`workerd exited (${signal})`);
    process.exitCode = code ?? 1;
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => child.kill(signal));
  }
  console.info(`TalkTo listening on 0.0.0.0:${port}; data: ${persistence}`);
}
