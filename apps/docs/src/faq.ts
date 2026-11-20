/*
  FAQPage structured data (https://schema.org/FAQPage) for a page with `faq: true` in its
  frontmatter. Each `###` heading is a question and the prose under it, up to the next heading, is
  its answer. It is read from the page's own Markdown, so the questions and answers are written
  once. Components (lines starting with "<") and code blocks are left out of the answers.
*/
import type { HeadElement } from "@cloudflare/nimbus-docs/types";

export interface FaqItem {
  readonly question: string;
  readonly answer: string;
}

/** Markdown inline syntax as plain text: links keep their text, code and emphasis lose their marks. */
const plain = (markdown: string) =>
  markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** The questions and answers of a page body, in order. */
export function faqItems(body: string): ReadonlyArray<FaqItem> {
  const items: Array<{ question: string; lines: Array<string> }> = [];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const question = /^### (.+)$/.exec(line)?.[1];
    if (question !== undefined) items.push({ question: plain(question), lines: [] });
    else if (/^#{1,2} /.test(line)) items.push({ question: "", lines: [] });
    else if (!line.trimStart().startsWith("<")) items.at(-1)?.lines.push(line);
  }
  return items
    .filter(({ question }) => question !== "")
    .map(({ question, lines }) => ({ question, answer: plain(lines.join("\n")) }));
}

/** The page's FAQPage JSON-LD, as a head element. */
export function faqHead(body: string): HeadElement {
  const data = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqItems(body).map(({ question, answer }) => ({
      "@type": "Question",
      name: question,
      acceptedAnswer: { "@type": "Answer", text: answer },
    })),
  };
  return {
    tag: "script",
    attrs: { type: "application/ld+json" },
    // "<" escaped, so no answer can close the script element.
    content: JSON.stringify(data).replaceAll("<", "\\u003c"),
  };
}
