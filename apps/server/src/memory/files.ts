import * as M from "@talkto/api/models";
import * as T from "@talkto/api/tasks";
import type * as Store from "./store.js";

/**
 * What a claim carries from memory (docs/swarm-server-spec.md, 14.4): the root `AGENTS.md` in full,
 * then the files the task's labels route to, within the server's budget in estimated tokens.
 */

const encoder = new TextEncoder();
/** UTF-8 bytes of a string. */
export const bytes = (text: string) => encoder.encode(text).length;
/** TalkTo's estimate of claim memory's size in tokens: UTF-8 bytes of its JSON ÷ 4, rounded up. */
export const tokensOf = (memory: T.ClaimMemory) => Math.ceil(bytes(JSON.stringify(memory)) / 4);
/** The `tokens` value a size estimate assumes before the real count is known (5 digits). */
const placeholderTokens = M.Count.make(99_999);

/**
 * The labels a file's front matter lists: `labels: [e2e, api]`, or a YAML list under `labels:`.
 * Anything else in the front matter is ignored; a file without front matter has none.
 */
export const frontMatterLabels = (text: string): ReadonlyArray<string> => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const front = match?.[1];
  if (front === undefined) return [];
  const lines = front.split(/\r?\n/);
  const at = lines.findIndex((line) => /^labels\s*:/.test(line));
  if (at < 0) return [];
  const inline = (lines[at] ?? "").replace(/^labels\s*:\s*/, "").trim();
  const clean = (value: string) =>
    value
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim()
      .toLowerCase();
  const listed: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!/^\s+-/.test(line)) break;
    listed.push(line.replace(/^\s+-\s*/, ""));
  }
  const values = inline.length > 0 ? inline.replace(/^\[|\]$/g, "").split(",") : listed;
  return [...new Set(values.map(clean).filter((value) => value.length > 0))].slice(0, 16);
};

/** One item of the root's map: the paths it names in backticks, and what it says of the first. */
export interface MapItem {
  readonly paths: ReadonlyArray<string>;
  readonly about: string;
  readonly text: string;
}
/**
 * The root's map: each list item (`- `path`: what it holds`), with its indented continuation
 * lines, that names at least one path in backticks.
 */
export const mapOf = (root: string): ReadonlyArray<MapItem> => {
  const items: string[] = [];
  for (const line of root.split(/\r?\n/)) {
    if (/^\s{0,3}[-*]\s/.test(line)) items.push(line.replace(/^\s*[-*]\s+/, ""));
    else if (/^\s+\S/.test(line) && items.length > 0)
      items[items.length - 1] = `${items.at(-1) ?? ""} ${line.trim()}`;
    else if (line.trim().length === 0 || /^#/.test(line)) items.push("");
  }
  return items.flatMap((text) => {
    const paths = [...text.matchAll(/`([A-Za-z0-9][A-Za-z0-9._/-]*)`/g)]
      .map((match) => match[1] ?? "")
      .filter((path) => path.endsWith(".md") || path.endsWith("/"));
    if (paths.length === 0) return [];
    const about = text
      .replace(/^`[^`]*`\s*[:—–-]?\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    return [{ paths, about: about.length > 300 ? `${about.slice(0, 299)}…` : about, text }];
  });
};
/** What the map says of a file: its own item, else the item of the deepest folder holding it. */
const aboutOf = (map: ReadonlyArray<MapItem>, path: string) => {
  const own = map.find((item) => item.paths[0] === path);
  if (own !== undefined) return own.about;
  const folders = map
    .filter((item) => item.paths[0]?.endsWith("/") === true && path.startsWith(item.paths[0]))
    .toSorted((a, b) => (b.paths[0]?.length ?? 0) - (a.paths[0]?.length ?? 0));
  return folders[0]?.about;
};
const word = (text: string, value: string) =>
  new RegExp(`(^|[^a-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(
    text.toLowerCase(),
  );
/**
 * Whether one task label routes to a file: a path segment named like it, its front matter, or a
 * map item that names the file and the label.
 */
const routes = (map: ReadonlyArray<MapItem>, file: Store.FileRow, label: string) => {
  const wanted = label.toLowerCase();
  const value = wanted.includes("=") ? wanted.slice(wanted.indexOf("=") + 1) : wanted;
  if (file.labels.includes(wanted) || file.labels.includes(value)) return true;
  const segments = file.path.toLowerCase().replace(/\.md$/, "").split("/");
  if (segments.includes(wanted) || segments.includes(value)) return true;
  return map.some(
    (item) =>
      item.paths.includes(file.path) &&
      (word(item.text.replaceAll(file.path, ""), wanted) ||
        word(item.text.replaceAll(file.path, ""), value)),
  );
};

/** The files a task's labels route to, in label order and then by path, never the root. */
export const matches = (
  files: ReadonlyArray<Store.FileRow>,
  labels: ReadonlyArray<string>,
): ReadonlyArray<Store.FileRow> => {
  const map = mapOf(files.find((file) => file.path === T.memoryRoot)?.text ?? "");
  const chosen: Store.FileRow[] = [];
  const seen = new Set<string>();
  for (const label of labels)
    for (const file of files)
      if (file.path !== T.memoryRoot && !seen.has(file.path) && routes(map, file, label)) {
        seen.add(file.path);
        chosen.push(file);
      }
  return chosen;
};

/**
 * The claim's memory: the root always (even past the budget), then each matching file that still
 * fits, in order; the ones that do not fit are named in `omitted`, so the agent can read them.
 */
export const deliver = (input: {
  readonly files: ReadonlyArray<Store.FileRow>;
  readonly labels: ReadonlyArray<string>;
  readonly budget: number;
  readonly version: T.MemoryVersion;
}): T.ClaimMemory => {
  const root = input.files.find((file) => file.path === T.memoryRoot)?.text ?? "";
  const map = mapOf(root);
  const matched = matches(input.files, input.labels);
  const files: T.MemoryFile[] = [];
  const omitted: T.MemoryOmitted[] = [];
  const left = (file: Store.FileRow): T.MemoryOmitted => {
    const about = aboutOf(map, file.path);
    return about === undefined || about.length === 0
      ? { path: file.path }
      : { path: file.path, about };
  };
  // Every file the labels do not route to is listed after them, with what the map says of it.
  const routed = new Set(matched.map((file) => file.path));
  const others = input.files
    .filter((file) => file.path !== T.memoryRoot && !routed.has(file.path))
    .toSorted((a, b) => (a.path < b.path ? -1 : 1))
    .map(left);
  const size = (candidate: ReadonlyArray<T.MemoryFile>, rest: ReadonlyArray<T.MemoryOmitted>) =>
    tokensOf({
      root,
      files: candidate,
      omitted: rest,
      tokens: placeholderTokens,
      version: input.version,
      note: T.memoryCompleteNote,
    });
  for (const [index, file] of matched.entries()) {
    const next = [...files, { path: file.path, text: file.text }];
    const rest = [...omitted, ...matched.slice(index + 1).map(left)];
    if (size(next, rest) <= input.budget) files.push({ path: file.path, text: file.text });
    else omitted.push(left(file));
  }
  // Routed files come first; the listing of the others fills what the budget leaves, and
  // read_memory without a path lists them all.
  for (const other of others) {
    if (size(files, [...omitted, other]) > input.budget) break;
    omitted.push(other);
  }
  // The note says when to write: before complete, while the claim still grants a write token.
  const memory = { root, files, omitted, version: input.version, note: T.memoryCompleteNote };
  return { ...memory, tokens: M.Count.make(tokensOf({ ...memory, tokens: M.Count.make(0) })) };
};

/** One file's subject line: the first line of a commit message, at most 200 characters. */
export const subjectOf = (message: string) => {
  const first = message.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const line = first.trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line.length === 0 ? "(no message)" : line;
};
