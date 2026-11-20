import { copyFile, readFile, writeFile, rm } from "node:fs/promises";
const directory = new URL(`../${process.argv[2] ?? "dist"}/`, import.meta.url);
const renderer = new URL(`../${process.argv[3] ?? "dist-render"}/`, import.meta.url);
const { pageDocument, publicPages } = await import(new URL("prerender.js", renderer).href);
const path = new URL("index.html", directory);
const template = await readFile(path, "utf8");
for (const page of publicPages) {
  const target = page.path === "/" ? path : new URL(`${page.path.slice(1)}.html`, directory);
  await writeFile(target, pageDocument(template, page.path));
}
// Static assets answer unknown paths outside /docs with this page and a 404 status
// (apps/server/wrangler.jsonc). It is the same shell, so the router still shows its "Page not found".
await copyFile(path, new URL("404.html", directory));
await rm(renderer, { recursive: true });
