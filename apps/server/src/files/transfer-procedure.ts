import type * as M from "@talkto/api/models";

const script = `set -eu
out=$(mktemp -d)
folder=$1
shift
cd "$folder"
COPYFILE_DISABLE=1 tar "$@" -czf "$out/bundle.tgz" .
tar -tzf "$out/bundle.tgz" > "$out/manifest"
sha=$( { sha256sum "$out/bundle.tgz" 2>/dev/null || shasum -a 256 "$out/bundle.tgz"; } | cut -d' ' -f1)
echo "bundle=$out/bundle.tgz"
echo "manifest=$out/manifest"
echo "bytes=$(wc -c < "$out/bundle.tgz" | tr -d ' ')"
echo "sha256=$sha"
echo "fileCount=$(grep -vc '/$' "$out/manifest")"
echo "manifestBytes=$(wc -c < "$out/manifest" | tr -d ' ')"`;

/**
 * The local command that packs a folder. It holds no credential and reads nothing from TalkTo.
 * The agent decides what goes in: it replaces `<folder>` and may add tar options after it, such
 * as `--exclude=node_modules`. TalkTo does not inspect or filter the contents.
 *
 * @returns A shell command that writes the bundle and file list to a new temporary directory.
 */
export const packCommand = () => `sh -s -- <folder> <<'TALKTO_PACK'\n${script}\nTALKTO_PACK`;

const put = (path: string, url: string) =>
  `curl -fsS --retry 5 -H 'If-None-Match: *' -T ${path} '${url}'`;

/**
 * The upload commands returned with a reservation. Placeholders in angle brackets are the only
 * parts an agent fills in. An HTTP 412 from a retry means that object already arrived.
 *
 * @param kind - A folder uploads its bundle and its file list; a file uploads itself.
 * @param url - Signed link for the payload.
 * @param manifestUrl - Signed link for a folder's file list.
 * @returns Newline-separated shell commands.
 */
export const upload = (kind: M.TransferKind, url: string, manifestUrl: string | null) =>
  kind === "folder" && manifestUrl !== null
    ? [put("<bundle>", url), put("<manifest>", manifestUrl)].join("\n")
    : put("<file>", url);

/**
 * The download commands returned when an offer is accepted. Only values TalkTo generated or
 * validated reach the shell: the sender's chosen name never does. Each step runs only when the
 * one before it succeeded, so a failed download or hash check never unpacks and the procedure
 * exits non-zero.
 *
 * @param transfer - The accepted offer.
 * @param url - Signed link for the payload.
 * @returns Shell commands, one per line and chained with `&&`, that fetch, verify and, for a
 * folder, unpack safely.
 */
export const download = (transfer: M.FileTransfer, url: string) => {
  const file = `talkto-${transfer.id}`;
  const steps = [
    `curl -fL --retry 5 -C - -o ${file} '${url}'`,
    `printf '%s  %s\\n' ${transfer.sha256} ${file} | { sha256sum -c - 2>/dev/null || shasum -a 256 -c -; }`,
  ];
  if (transfer.kind === "folder")
    steps.push(
      `if tar -tzf ${file} | grep -qE '^/|(^|/)\\.\\.(/|$)'; then echo 'Refused: the bundle has unsafe paths.' >&2; false; else mkdir ${file}.d && tar -xzf ${file} -C ${file}.d --no-same-owner; fi`,
    );
  return steps.join(" &&\n");
};
