/*
  Puts the built docs into the Worker's static assets, beside the public site:
  `node tools/copy-into.mjs <assets directory>` copies dist/ to <assets>/docs/ and adds the docs'
  _headers rules to <assets>/_headers, the only place Workers Static Assets reads them. It moves
  the root llms.txt the docs build writes (root-llms.txt) to <assets>/llms.txt.
  Run after the web build, which empties the assets directory.
*/
import { cp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const target = process.argv[2];
if (!target) throw new Error("usage: node tools/copy-into.mjs <assets directory>");
const assets = new URL(`${target.replace(/\/?$/, "/")}`, `file://${process.cwd()}/`);
const dist = new URL("../dist/", import.meta.url);
if (!existsSync(new URL("index.html", assets)))
  throw new Error(`${assets.pathname} has no index.html; build the public site first`);

const docs = new URL("docs/", assets);
await rm(docs, { recursive: true, force: true });
await cp(dist, docs, { recursive: true });
await rm(new URL("_headers", docs));
// The root /llms.txt (src/llms.ts), served by the Worker with its own origin filled in.
await rename(new URL("root-llms.txt", docs), new URL("llms.txt", assets));

const start = "# TalkTo docs (apps/docs/tools/copy-into.mjs)";
const end = "# End TalkTo docs";
const headers = new URL("_headers", assets);
const current = existsSync(headers) ? await readFile(headers, "utf8") : "";
const kept = current.replace(new RegExp(`${start}[\\s\\S]*?${end}\\n?`), "");
const rules = await readFile(new URL("_headers", dist), "utf8");
await writeFile(
  headers,
  `${kept}${kept && !kept.endsWith("\n") ? "\n" : ""}${start}\n${rules.trim()}\n${end}\n`,
);
console.log(`docs copied to ${docs.pathname}`);
