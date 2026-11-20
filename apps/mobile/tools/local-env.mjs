import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";

// Copy the local development server's generated token (apps/server/.dev.vars, written by
// pnpm setup:local) into apps/mobile/.env.local, which Expo loads in development and git ignores.
// Other lines in .env.local are kept. The token is never printed.
const source = new URL("../../server/.dev.vars", import.meta.url);
const target = new URL("../.env.local", import.meta.url);
const name = "EXPO_PUBLIC_TALKTO_LOCAL_TOKEN";

let vars;
try {
  vars = parseEnv(await readFile(source, "utf8"));
} catch {
  throw new Error("Run pnpm setup:local first: apps/server/.dev.vars is missing.");
}
const token = vars.TALKTO_LOCAL_TOKEN;
if (token === undefined || !/^[a-f0-9]{64}$/.test(token))
  throw new Error("apps/server/.dev.vars has no valid TALKTO_LOCAL_TOKEN. Run pnpm setup:local.");

const existing = await readFile(target, "utf8").catch(() => "");
const kept = existing.split("\n").filter((line) => line !== "" && !line.startsWith(`${name}=`));
await writeFile(target, [...kept, `${name}=${token}`, ""].join("\n"), { mode: 0o600 });
console.log("Wrote the local server token to apps/mobile/.env.local. It was not printed.");
