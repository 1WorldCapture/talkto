/*
  The agent guide, apps/server/src/instructions.md, read as sections. It is the only per-tool setup
  TalkTo has: the Worker serves it at /instructions, MCP returns it, and the website copies it. The
  docs site renders it with the same `renderDocumentation` and cuts it into pages; nothing here
  restates a setup step.
*/
import { readFileSync } from "node:fs";
import { renderDocumentation } from "@talkto/api/documentation";

/** Canonical production origin (KEY_DECISIONS.md). The docs live at its /docs. */
export const siteOrigin = "https://talkto.sh";

/** One `##` or `###` section of the guide: its heading and the Markdown under it. */
export interface GuideSection {
  readonly heading: string;
  readonly level: 2 | 3;
  readonly body: string;
}

/** Read the guide from the checkout and fill it for the production origin. */
export function readGuide(path: URL): string {
  return renderDocumentation(readFileSync(path, "utf8"), siteOrigin);
}

/** Split the guide at its `##` and `###` headings, ignoring heading-like lines in code. */
export function guideSections(markdown: string): ReadonlyArray<GuideSection> {
  const sections: Array<GuideSection> = [];
  let current: { heading: string; level: 2 | 3; lines: Array<string> } | null = null;
  let fenced = false;
  const close = () => {
    if (current !== null)
      sections.push({
        heading: current.heading,
        level: current.level,
        body: current.lines.join("\n").trim(),
      });
  };
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const heading = fenced ? null : /^(##|###) (.+)$/.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      close();
      current = { heading: heading[2], level: heading[1] === "##" ? 2 : 3, lines: [] };
    } else current?.lines.push(line);
  }
  close();
  return sections;
}

/** The `###` sections under "Connect this client": one per tool, plus a few shared steps. */
export function connectSections(markdown: string): ReadonlyArray<GuideSection> {
  const all = guideSections(markdown);
  const start = all.findIndex((section) => section.heading === "Connect this client");
  const end = all.findIndex((section, index) => index > start && section.level === 2);
  if (start < 0 || end < 0) throw new Error('instructions.md: no "## Connect this client" section');
  return all.slice(start + 1, end);
}

/** Paragraphs, lists and code blocks of a section body, split at blank lines outside code. */
export function blocks(body: string): ReadonlyArray<string> {
  const result: Array<string> = [];
  let lines: Array<string> = [];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    if (!fenced && line.trim() === "") {
      if (lines.length > 0) result.push(lines.join("\n"));
      lines = [];
    } else lines.push(line);
  }
  if (lines.length > 0) result.push(lines.join("\n"));
  return result;
}

/** The list items of a block that start with one of the labels, as in "- Codex: …". */
export function listItems(block: string, labels: ReadonlyArray<string>): ReadonlyArray<string> {
  return block
    .split("\n")
    .filter((line) =>
      labels.some((label) => line.startsWith(`- ${label}:`) || line.startsWith(`- ${label} (`)),
    );
}
