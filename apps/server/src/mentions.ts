import * as M from "@talkto/api/models";

/**
 * `@name` where a participant name can start: at the start of the text or after a character that
 * cannot be part of a name, an address or a path, so `ana@example.com` and `pkg/@scope` mention
 * nobody. Names start with a letter and continue with letters, digits, `_` and `-`.
 */
const tagged = /(?<![A-Za-z0-9_.@/\\-])@([A-Za-z][A-Za-z0-9_-]{0,63})/g;
/** Code is quoted text: a name inside backticks or a fenced block is never a mention. */
const code = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
/** Bound the lookups one message can cause, whatever its length. */
const maxTags = 64;

/**
 * The names a message tags, in order, each with the shorter reading first tried when trailing `-`
 * or `_` might be punctuation: `@ana-` tries `ana-`, then `ana`. Matching against participants,
 * ignoring case as names are unique, is the caller's job.
 */
export const tags = (body: string): ReadonlyArray<ReadonlyArray<M.Name>> => {
  const seen = new Set<string>();
  const found: Array<ReadonlyArray<M.Name>> = [];
  for (const match of body.replace(code, " ").matchAll(tagged)) {
    const name = match[1];
    if (name === undefined) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const trimmed = name.replace(/[-_]+$/, "");
    // A name starts with a letter, so trimming never empties it.
    found.push((trimmed === name ? [name] : [name, trimmed]).map((item) => M.Name.make(item)));
    if (found.length >= maxTags) break;
  }
  return found;
};
