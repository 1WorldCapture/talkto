/*
  The root /llms.txt (https://llmstxt.org) and /llms-full.txt. The docs build writes llms.txt into
  the static assets with the agent guide's placeholder origin (apps/docs/src/llms.ts); the Worker
  fills in its own origin, as it does for /instructions, so staging and self-hosted copies point at
  themselves. /llms-full.txt is the same index with the whole agent guide after it. Both paths run
  the Worker first (wrangler*.jsonc); test/asset-routing.test.mjs checks every link resolves.
*/
import { renderDocumentation } from "@talkto/api/documentation";
import { agentGuide } from "./guide.js";

export const paths = ["/llms.txt", "/llms-full.txt"];
export const isLlmsPath = (path: string) => paths.includes(path);

/** The index from static assets, rendered for `origin`. A missing asset keeps its 404 response. */
export async function serve(
  request: Request,
  assets: Fetcher,
  /** Swarm memory is offered (`TALKTO_MEMORY=on` and a binding): the guide includes it (guide.ts). */
  memory = false,
): Promise<Response> {
  const url = new URL(request.url);
  const asset = await assets.fetch(new Request(new URL("/llms.txt", url)));
  if (!asset.ok) return asset;
  const index = renderDocumentation(await asset.text(), url.origin);
  const body =
    url.pathname === "/llms-full.txt"
      ? `${index}\n${renderDocumentation(agentGuide(memory), url.origin)}`
      : index;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
