import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rpc, packet } from "./mcp-wire.mjs";

/**
 * MCP output-schema snapshots, one file per production release that changed MCP tools. Hosts
 * keep the outputSchema they listed at connect time for the whole session, so every reply must
 * still match every snapshot a running session may hold. See docs/mcp-compatibility.md.
 */
export const snapshotDirectory = fileURLToPath(
  new URL("../contracts/mcp-output/", import.meta.url),
);

/** Platform harness options that turn on every optional capability, so every tool is listed. */
export const everyTool = { transfers: true, files: true, wakeKey: true, signalKey: true };

/**
 * A JSON.stringify replacer that writes object keys in sorted order at every depth, so snapshot
 * diffs stay stable; array order is kept. `Object(value) !== value` holds for null and primitives.
 */
export const sortedKeys = (_key, value) =>
  Array.isArray(value) || Object(value) !== value
    ? value
    : Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** `{ toolName: outputSchema }` from a live tools/list. */
export const outputSchemas = async (raw, credential) => {
  const listed = await packet(await raw("/mcp", rpc("tools/list", {}, credential)));
  if (listed.result === undefined) throw new Error(`tools/list failed: ${JSON.stringify(listed)}`);
  return Object.fromEntries(listed.result.tools.map((tool) => [tool.name, tool.outputSchema]));
};

/*
  Snapshot format. Every tool's schema repeats the same error branch and shared definitions, so a
  snapshot stores each repeated subschema once, under `parts`, keyed by the first 16 hex digits of
  the SHA-256 of its sorted JSON. In `tools` and in other parts, `{ "$part": key }` stands for that
  subschema. Only subschemas of at least `minimumPartBytes` that occur more than once become parts.
*/
const snapshotFormat = "mcp-output-schemas/shared-parts";
const minimumPartBytes = 256;
const canonical = (value) => JSON.stringify(value, sortedKeys);
const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
/** An object or array; JSON's other values are leaves. */
const composite = (value) => Object(value) === value;
const reference = (value) =>
  !Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "$part");
const children = (value) => (Array.isArray(value) ? value : Object.values(value));
const mapChildren = (value, f) =>
  Array.isArray(value)
    ? value.map(f)
    : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, f(child)]));

/** `{ toolName: outputSchema }` to the snapshot file's text, with shared parts stored once. */
export const packSnapshot = (schemas) => {
  const counts = new Map();
  const count = (value) => {
    if (!composite(value)) return;
    const text = canonical(value);
    counts.set(text, (counts.get(text) ?? 0) + 1);
    for (const child of children(value)) count(child);
  };
  for (const schema of Object.values(schemas)) count(schema);
  const parts = new Map();
  const encoded = new Map();
  const encode = (value) => {
    if (!composite(value)) return value;
    const text = canonical(value);
    const known = encoded.get(text);
    if (known !== undefined) return known;
    const inner = mapChildren(value, encode);
    const shared = text.length >= minimumPartBytes && counts.get(text) > 1;
    const key = digest(text);
    if (shared) parts.set(key, inner);
    const result = shared ? { $part: key } : inner;
    encoded.set(text, result);
    return result;
  };
  const tools = mapChildren(schemas, encode);
  // A subschema repeated only inside one part is referenced once: write it in place instead.
  const references = new Map();
  const tally = (value) => {
    if (!composite(value)) return;
    if (reference(value)) references.set(value.$part, (references.get(value.$part) ?? 0) + 1);
    else for (const child of children(value)) tally(child);
  };
  tally(tools);
  for (const part of parts.values()) tally(part);
  const once = (key) => references.get(key) === 1;
  const inline = (value) => {
    if (!composite(value)) return value;
    if (reference(value)) return once(value.$part) ? inline(parts.get(value.$part)) : value;
    return mapChildren(value, inline);
  };
  const kept = [...parts].filter(([key]) => !once(key)).map(([key, part]) => [key, inline(part)]);
  const snapshot = {
    format: snapshotFormat,
    parts: Object.fromEntries(kept),
    tools: mapChildren(tools, inline),
  };
  if (canonical(unpackSnapshot(snapshot)) !== canonical(schemas))
    throw new Error("A packed snapshot does not rebuild the listed schemas");
  return `${JSON.stringify(snapshot, sortedKeys, 2)}\n`;
};

/** A snapshot file's content back to `{ toolName: outputSchema }`, each part checked by its key. */
export const unpackSnapshot = (snapshot) => {
  if (snapshot.format !== snapshotFormat)
    throw new Error(`Unknown snapshot format ${JSON.stringify(snapshot.format)}`);
  const built = new Map();
  const expand = (value) => {
    if (!composite(value)) return value;
    if (!reference(value)) return mapChildren(value, expand);
    const key = value.$part;
    if (!built.has(key)) {
      if (!Object.hasOwn(snapshot.parts, key)) throw new Error(`Snapshot part ${key} is missing`);
      const full = expand(snapshot.parts[key]);
      if (digest(canonical(full)) !== key)
        throw new Error(`Snapshot part ${key} does not match its key; regenerate the snapshot`);
      built.set(key, full);
    }
    return built.get(key);
  };
  return mapChildren(snapshot.tools, expand);
};

/** Every committed snapshot, oldest first: `[{ name, schemas }]`. */
export const committedSnapshots = () =>
  readdirSync(snapshotDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const file = JSON.parse(readFileSync(join(snapshotDirectory, name), "utf8"));
      try {
        return { name, schemas: unpackSnapshot(file) };
      } catch (cause) {
        throw new Error(`contracts/mcp-output/${name}: ${cause.message}`, { cause });
      }
    });
