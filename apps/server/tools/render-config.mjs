import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig } from "wrangler";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const config = experimental_readRawConfig({
  config: here("../wrangler.selfhost.example.jsonc"),
}).rawConfig;

const ratelimits = Object.fromEntries(
  config.ratelimits.map((rateLimit, index) => [
    rateLimit.name,
    { ...rateLimit, namespace_id: String(2001 + index) },
  ]),
);

if (process.argv[2] === "config") {
  const buildConfig = {
    ...config,
    name: "talkto-render",
    main: "../apps/server/src/worker.ts",
    out_dir: "../apps/server/dist/render",
    assets: { ...config.assets, directory: "../apps/web/dist" },
    d1_databases: config.d1_databases.map((database) => ({
      ...database,
      database_id: "00000000-0000-0000-0000-000000000000",
      migrations_dir: "../apps/server/src/platform/migrations",
    })),
    account_id: undefined,
    r2_buckets: undefined,
    ratelimits: undefined,
    triggers: undefined,
  };
  await mkdir(here("../../../.runtime"), { recursive: true });
  await writeFile(
    here("../../../.runtime/wrangler.render.json"),
    `${JSON.stringify(buildConfig, null, 2)}\n`,
  );
} else {
  await writeFile(
    here("../../../.runtime/dist/render/runtime.json"),
    `${JSON.stringify(
      {
        compatibilityDate: config.compatibility_date,
        compatibilityFlags: config.compatibility_flags,
        assets: config.assets,
        ratelimits,
      },
      null,
      2,
    )}\n`,
  );
}
