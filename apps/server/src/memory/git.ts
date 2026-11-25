import { Effect, Schema } from "effect";

/**
 * TalkTo's own Git writer for memory (docs/swarm-server-spec.md, 14.7): it builds blob, tree and
 * commit objects, packs them, and frames one receive-pack request whose old ID makes the ref
 * update a compare-and-swap. TalkTo writes only to seed a new repository with the template and to
 * restore `main` after a force push or a deletion; agents write with real Git.
 *
 * The pack's objects use zlib's stored blocks (no compression): every Git server accepts them, the
 * objects are a few kilobytes, and a test can read the pack back without an inflater.
 */

const encoder = new TextEncoder();
const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const unhex = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};
const sha1 = (bytes: Uint8Array) =>
  Effect.promise(() => crypto.subtle.digest("SHA-1", bytes)).pipe(Effect.map(hex));

export type ObjectType = "blob" | "tree" | "commit";
export interface GitObject {
  readonly type: ObjectType;
  readonly body: Uint8Array;
  readonly id: string;
}
const typeCode: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3 };

/** One Git object and its ID: the SHA-1 of `<type> <size>\0<body>`. */
export const object = (type: ObjectType, body: Uint8Array) =>
  sha1(concat([encoder.encode(`${type} ${body.byteLength}\0`), body])).pipe(
    Effect.map((id): GitObject => ({ type, body, id })),
  );

interface Entry {
  readonly mode: "100644" | "40000";
  readonly name: string;
  readonly id: string;
}
/** Tree entries sort by name, a folder compared as if its name ended in "/". */
const treeBody = (entries: ReadonlyArray<Entry>) => {
  const key = (entry: Entry) => (entry.mode === "40000" ? `${entry.name}/` : entry.name);
  const sorted = entries.toSorted((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return concat(
    sorted.flatMap((entry) => [encoder.encode(`${entry.mode} ${entry.name}\0`), unhex(entry.id)]),
  );
};

/** The tree of a set of files (`path` → text), with every object it needs; null when empty. */
export const tree = Effect.fn("MemoryGit.tree")(function* (
  files: ReadonlyArray<{ readonly path: string; readonly text: string }>,
) {
  const objects: GitObject[] = [];
  const build = Effect.fnUntraced(function* (
    items: ReadonlyArray<readonly [path: string, text: string]>,
  ): Effect.fn.Return<string | null> {
    const entries: Entry[] = [];
    const folders = new Map<string, Array<readonly [string, string]>>();
    for (const [path, text] of items) {
      const [head = "", ...rest] = path.split("/");
      if (rest.length === 0) {
        const blob = yield* object("blob", encoder.encode(text));
        objects.push(blob);
        entries.push({ mode: "100644", name: head, id: blob.id });
      } else {
        const folder = folders.get(head) ?? [];
        folder.push([rest.join("/"), text]);
        folders.set(head, folder);
      }
    }
    for (const [name, inside] of folders) {
      const id = yield* build(inside);
      if (id !== null) entries.push({ mode: "40000", name, id });
    }
    if (entries.length === 0) return null;
    const made = yield* object("tree", treeBody(entries));
    objects.push(made);
    return made.id;
  });
  const root = yield* build(files.map((file) => [file.path, file.text] as const));
  return { root, objects };
});

/** A commit by TalkTo. `at` is epoch milliseconds. */
export const commit = (input: {
  readonly tree: string;
  readonly parents: ReadonlyArray<string>;
  readonly message: string;
  readonly at: number;
}) => {
  const who = `TalkTo <memory@talkto.invalid> ${Math.floor(input.at / 1000)} +0000`;
  const parents = input.parents.map((parent) => `parent ${parent}\n`).join("");
  return object(
    "commit",
    encoder.encode(
      `tree ${input.tree}\n${parents}author ${who}\ncommitter ${who}\n\n${input.message.trim()}\n`,
    ),
  );
};

/** Adler-32, the checksum ending a zlib stream. */
const adler32 = (bytes: Uint8Array) => {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  return Uint8Array.of((b >>> 8) & 255, b & 255, (a >>> 8) & 255, a & 255);
};
/** A zlib stream of stored (uncompressed) deflate blocks. */
export const stored = (bytes: Uint8Array) => {
  const parts: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  let offset = 0;
  do {
    const length = Math.min(65_535, bytes.byteLength - offset);
    const final = offset + length >= bytes.byteLength ? 1 : 0;
    parts.push(
      Uint8Array.of(final, length & 255, length >>> 8, ~length & 255, (~length >>> 8) & 255),
      bytes.subarray(offset, offset + length),
    );
    offset += length;
  } while (offset < bytes.byteLength);
  parts.push(adler32(bytes));
  return concat(parts);
};
/** A version 2 pack of `objects`, each whole (no deltas). An empty pack updates a ref only. */
export const pack = Effect.fn("MemoryGit.pack")(function* (objects: ReadonlyArray<GitObject>) {
  const count = objects.length;
  const parts: Uint8Array[] = [
    encoder.encode("PACK"),
    Uint8Array.of(0, 0, 0, 2),
    Uint8Array.of((count >>> 24) & 255, (count >>> 16) & 255, (count >>> 8) & 255, count & 255),
  ];
  for (const item of objects) {
    let size = item.body.byteLength;
    const head: number[] = [];
    let byte = (typeCode[item.type] << 4) | (size & 15);
    size = Math.floor(size / 16);
    while (size > 0) {
      head.push(byte | 128);
      byte = size & 127;
      size = Math.floor(size / 128);
    }
    head.push(byte);
    parts.push(Uint8Array.from(head), stored(item.body));
  }
  const body = concat(parts);
  return concat([body, unhex(yield* sha1(body))]);
});
const pktLine = (text: string) => {
  const payload = encoder.encode(text);
  return concat([encoder.encode((payload.byteLength + 4).toString(16).padStart(4, "0")), payload]);
};
export const mainRef = "refs/heads/main";
/** One receive-pack request: move `ref` from `old` to `next` only if it is still `old`. */
export const receivePack = Effect.fn("MemoryGit.receivePack")(function* (input: {
  readonly old: string;
  readonly next: string;
  readonly objects: ReadonlyArray<GitObject>;
}) {
  return concat([
    pktLine(`${input.old} ${input.next} ${mainRef}\0report-status agent=talkto-memory\n`),
    encoder.encode("0000"),
    yield* pack(input.objects),
  ]);
});
/** Whether a receive-pack report says the pack unpacked and `main` moved. */
export const accepted = (report: string) =>
  /unpack ok/.test(report) && new RegExp(`(^|[^a-z])ok ${mainRef}`).test(report);

/**
 * One protocol-v2 fetch of a single object by its ID (`want <hash>`, no haves, no thin pack), so
 * the reply's pack holds that object whole. This is how TalkTo reads a file's bytes: the binding's
 * `readBlob` and `readFile` return a Blob, which cannot cross RPC at compatibility date 2026-09-08.
 */
export const wantRequest = (hash: string) =>
  concat([
    pktLine("command=fetch\n"),
    pktLine("agent=talkto-memory\n"),
    encoder.encode("0001"),
    pktLine("no-progress\n"),
    pktLine(`want ${hash}\n`),
    pktLine("done\n"),
    encoder.encode("0000"),
  ]);
/** A fetch reply TalkTo cannot read as the one object it asked for. */
export class Unreadable extends Schema.TaggedError<Unreadable>()("MemoryGitUnreadable", {
  message: Schema.String,
}) {}
const unreadable = (message: string) => new Unreadable({ message });
const decoder = new TextDecoder();
/** The pack inside a v2 fetch reply: the `packfile` section's side band 1, joined. */
const packOf = (reply: Uint8Array) => {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let inPack = false;
  while (offset + 4 <= reply.byteLength) {
    const length = Number.parseInt(decoder.decode(reply.subarray(offset, offset + 4)), 16);
    if (!Number.isFinite(length)) return null;
    if (length < 4) {
      // A flush (0000), delimiter (0001) or response end (0002).
      offset += 4;
      if (length === 0) break;
      continue;
    }
    const payload = reply.subarray(offset + 4, offset + length);
    offset += length;
    if (!inPack) {
      if (decoder.decode(payload).trim() === "packfile") inPack = true;
      continue;
    }
    const band = payload[0];
    if (band === 1) parts.push(payload.subarray(1));
    if (band === 3) return null;
  }
  return inPack ? concat(parts) : null;
};
const inflate = (bytes: Uint8Array) =>
  Effect.tryPromise({
    try: async () =>
      new Uint8Array(
        await new Response(
          new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")),
        ).arrayBuffer(),
      ),
    catch: () => unreadable("The object did not inflate."),
  });
/**
 * The bytes of the one blob a `wantRequest` reply carries, checked against its ID. The pack has
 * exactly one whole object, so its zlib stream runs to the pack's 20-byte trailer.
 */
export const readWanted = Effect.fn("MemoryGit.readWanted")(function* (
  reply: Uint8Array,
  hash: string,
) {
  const packed = packOf(reply);
  if (packed === null || decoder.decode(packed.subarray(0, 4)) !== "PACK")
    return yield* unreadable("The reply has no pack.");
  const count =
    ((packed[8] ?? 0) << 24) |
    ((packed[9] ?? 0) << 16) |
    ((packed[10] ?? 0) << 8) |
    (packed[11] ?? 0);
  if (count !== 1) return yield* unreadable("The pack does not hold exactly one object.");
  let offset = 12;
  let byte = packed[offset] ?? 0;
  const type = (byte >> 4) & 7;
  let size = byte & 15;
  let shift = 4;
  offset += 1;
  while ((byte & 128) !== 0) {
    byte = packed[offset] ?? 0;
    size += (byte & 127) * 2 ** shift;
    shift += 7;
    offset += 1;
  }
  if (type !== typeCode.blob) return yield* unreadable("The object is not a whole blob.");
  const body = yield* inflate(packed.subarray(offset, packed.byteLength - 20));
  if (body.byteLength !== size) return yield* unreadable("The blob has the wrong size.");
  const made = yield* object("blob", body);
  if (made.id !== hash) return yield* unreadable("The blob does not match its ID.");
  return body;
});
