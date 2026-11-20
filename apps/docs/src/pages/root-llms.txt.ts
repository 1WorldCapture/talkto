/*
  The root /llms.txt, built with the docs (src/llms.ts). tools/copy-into.mjs moves it to the root
  of the Worker's assets as llms.txt, and the Worker serves it with its own origin filled in.
*/
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import guide from "../../../server/src/instructions.md?raw";
import skill from "../../../server/src/skill.md?raw";
import { rootLlms } from "../llms.ts";

export const prerender = true;

export const GET: APIRoute = async () => {
  const pages = (await getCollection("docs")).map((entry) => {
    const { title, description, sidebar } = entry.data;
    if (description === undefined)
      throw new Error(`llms.txt: docs page "${entry.id}" has no description`);
    // Pages without a sidebar order sort after the ordered ones, by title.
    const order = sidebar === false ? undefined : sidebar?.order;
    return { slug: entry.id, title, description, order: order ?? Number.MAX_SAFE_INTEGER };
  });
  const body = rootLlms({
    pages,
    guide,
    skill,
    selfHosted: process.env.TALKTO_SELF_HOSTED === "true",
  });
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
};
