// Draws TalkTo's mark, "t + lamp" (docs/favicon-spec.md), and writes every icon the site, the docs
// and the mobile app use. The SVGs are written as text. The PNGs are rasterized by headless
// Chrome, the same renderer as the browser tab. The ICO is assembled here from PNGs.
//
//   pnpm icons                  (set CHROME to a Chrome or Chromium binary if it is elsewhere)
//
// The outputs are checked in; nothing in the build runs this.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const repo = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));

const ink = "#151515";
const paper = "#f2f2ee";
const night = "#0a0a0a";
const lamp = "#f01ef0";

// The mark on a 32-unit grid. Straight edges sit on even units, so on whole pixels at 16 px.
// The t follows Geist 900's t (the wordmark's font); the lamp sits on its baseline.
const t = "M4 2H12V8H18V14H12V22Q12 24 14 24H18V30H11C6.6 30 4 27.4 4 23V14H0V8H4Z";
const mark = (fill) =>
  `<path fill="${fill}" d="${t}"/><rect fill="${lamp}" x="22" y="20" width="10" height="10"/>`;
const svg = (viewBox, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;

// Browser tab: ink on light tabs, paper on dark ones.
const favicon = svg(
  "0 0 32 32",
  `<style>.t{fill:${ink}}@media (prefers-color-scheme:dark){.t{fill:${paper}}}</style>` +
    `<path class="t" d="${t}"/><rect fill="${lamp}" x="22" y="20" width="10" height="10"/>`,
);
// Home screens and installed apps: the mark on night, inside the maskable safe zone (57%).
const tile = svg(
  "-12 -12 56 56",
  `<rect x="-12" y="-12" width="56" height="56" fill="${night}"/>${mark(paper)}`,
);
// favicon.ico cannot follow the tab's theme, so it carries its own night tile. At 16 px the
// 57% tile's t would be too small, so this one is drawn on a 16-unit grid with 2 px of margin.
const smallTile = svg(
  "0 0 16 16",
  `<rect width="16" height="16" fill="${night}"/>` +
    `<path fill="${paper}" d="M3 2H6V5H8V7H6V11Q6 12 7 12H8V14H5.5C4 14 3 13 3 11.5V7H2V5H3Z"/>` +
    `<rect fill="${lamp}" x="10" y="10" width="4" height="4"/>`,
);
// Android adaptive icon foreground (on app.json's #0a0a0a): the mark inside the 66% safe zone.
const foreground = svg("-24 -24 80 80", mark(paper));
// Splash screen image (on #0a0a0a).
const splash = svg("-2 -2 36 36", mark(paper));

/** Rasterizes each SVG at its size in headless Chrome; returns PNG bytes in the same order. */
function rasterize(jobs) {
  const directory = mkdtempSync(join(tmpdir(), "talkto-icons-"));
  try {
    const page = join(directory, "render.html");
    writeFileSync(
      page,
      `<!doctype html><pre id="out"></pre><script>
const jobs = ${JSON.stringify(jobs)};
const draw = ({ svg, size }) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    canvas.getContext("2d").drawImage(image, 0, 0, size, size);
    resolve(canvas.toDataURL("image/png").slice("data:image/png;base64,".length));
  };
  image.onerror = reject;
  image.src = "data:image/svg+xml;base64," + btoa(svg);
});
Promise.all(jobs.map(draw)).then(
  (pngs) => { document.getElementById("out").textContent = "PNGS " + pngs.join(" ") + " END"; },
  (error) => { document.getElementById("out").textContent = "FAILED " + error; },
);
</script>`,
    );
    const dom = execFileSync(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--virtual-time-budget=10000",
        `--user-data-dir=${join(directory, "profile")}`,
        "--dump-dom",
        `file://${page}`,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    const found = /PNGS ([^<]*) END/.exec(dom);
    if (!found) throw new Error(`Chrome did not render the icons: ${dom.slice(0, 300)}`);
    const pngs = found[1].split(" ").map((base64) => Buffer.from(base64, "base64"));
    if (pngs.length !== jobs.length) throw new Error("Chrome returned the wrong number of icons");
    return pngs;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** An ICO file holding PNG images (supported by every browser that reads favicon.ico). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size % 256, 0);
    entry.writeUInt8(size % 256, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]);
}

const pngs = [
  { path: "apps/web/public/apple-touch-icon.png", svg: tile, size: 180 },
  { path: "apps/web/public/icon-192.png", svg: tile, size: 192 },
  { path: "apps/web/public/icon-512.png", svg: tile, size: 512 },
  { path: "apps/mobile/assets/images/icon.png", svg: tile, size: 1024 },
  { path: "apps/mobile/assets/images/android-icon-foreground.png", svg: foreground, size: 1024 },
  { path: "apps/mobile/assets/images/splash-icon.png", svg: splash, size: 256 },
];
const icoSizes = [16, 32];
const rendered = rasterize([
  ...pngs.map(({ svg, size }) => ({ svg, size })),
  ...icoSizes.map((size) => ({ svg: smallTile, size })),
]);

for (const path of ["apps/web/public/favicon.svg", "apps/docs/public/favicon.svg"])
  writeFileSync(repo(path), favicon);
pngs.forEach(({ path }, index) => writeFileSync(repo(path), rendered[index]));
writeFileSync(
  repo("apps/web/public/favicon.ico"),
  ico(icoSizes.map((size, index) => ({ size, png: rendered[pngs.length + index] }))),
);
console.log(`Wrote favicon.svg (web, docs), favicon.ico and ${pngs.length} PNGs.`);
