import { renderToString } from "react-dom/server";
import { PublicPage, publicPages } from "./public.js";
import { AgentSymbols } from "./agent-symbols.js";
import type { Offer } from "./public-offers.js";

/** Build-time HTML only; the deployed application has no SSR server. */
export { publicPages };
type Path = (typeof publicPages)[number]["path"];
/** The build renders without an offer; tests may pass one to check the free-start copy. */
export const renderPublic = (path: Path, offer: Offer | null = null) =>
  renderToString(
    <>
      <AgentSymbols />
      <main id="stage">
        <PublicPage page={path} offer={offer} />
      </main>
    </>,
  );

/** The public website's address. Share previews need absolute links; the docs use the same one. */
export const siteOrigin = "https://talkto.sh";
/** index.html's tag with this name or property, however the formatter wraps it. */
const metaTag = (attribute: "name" | "property", key: string) =>
  new RegExp(`<meta\\s+${attribute}="${key}"\\s+content="[^"]*"\\s*/>`);
/**
 * One page's whole document from index.html: its prerendered body, title and description, and
 * the same title, description and address for link previews (og.png is shared by every page).
 */
export function pageDocument(template: string, path: Path): string {
  const page = publicPages.find((candidate) => candidate.path === path) ?? publicPages[0];
  const title = path === "/" ? "TalkTo" : `${page.name} · TalkTo`;
  return template
    .replace("<!--public-->", renderPublic(path))
    .replace("<title>TalkTo</title>", `<title>${title}</title>`)
    .replace(
      metaTag("name", "description"),
      `<meta name="description" content="${page.description}" />`,
    )
    .replace(metaTag("property", "og:title"), `<meta property="og:title" content="${title}" />`)
    .replace(
      metaTag("property", "og:description"),
      `<meta property="og:description" content="${page.description}" />`,
    )
    .replace(
      metaTag("property", "og:url"),
      `<meta property="og:url" content="${new URL(path, siteOrigin).href}" />`,
    );
}
