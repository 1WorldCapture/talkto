import { defineCollection } from "astro:content";
// `z` re-exported from `astro:content` is deprecated; import it from
// `astro/zod` (the pattern nimbus-docs' own schema helpers document).
import { z } from "astro/zod";
import { docsCollection, partialsCollection } from "@cloudflare/nimbus-docs/content";

export const collections = {
  docs: defineCollection(
    docsCollection({
      schemaFields: {
        // Nimbus docs are agent-friendly by default. Set `audience: human`
        // to flag a page that's written primarily for human readers.
        audience: z.literal("human").optional(),
        // The agent page's slug in src/agents.ts; the layout shows that agent's mark.
        agent: z.string().optional(),
        // Questions as `###` headings, published as FAQPage structured data (src/faq.ts).
        faq: z.boolean().optional(),
      },
    }),
  ),
  partials: defineCollection(partialsCollection()),
};
