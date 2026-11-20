import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const [method = "GET", path = "/v1/servers", json] = process.argv.slice(2);
const origin = "http://127.0.0.1:8787";
const url = new URL(path, origin);
if (url.origin !== origin || !path.startsWith("/")) {
  throw new Error("Use a local API path starting with /.");
}
const vars = parseEnv(await readFile(new URL("../apps/server/.dev.vars", import.meta.url), "utf8"));
const credential = vars.TALKTO_LOCAL_TOKEN;
if (credential === undefined || !/^[a-f0-9]{64}$/.test(credential)) {
  throw new Error("Run pnpm setup:local before making local requests.");
}
if (json !== undefined) JSON.parse(json);
const response = await fetch(url, {
  method,
  headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
  body: json,
  redirect: "error",
});
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;
