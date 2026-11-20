import type * as Model from "./model.js";

const header = (token: string | null) =>
  token === null ? "" : ` -c http.extraHeader="Authorization: Bearer ${token}"`;

/**
 * Render the ready-to-run Git recipe returned with every access grant, so an agent that
 * never read the guide still shares or fetches correctly. Placeholders in angle brackets
 * are the only parts an agent fills in; the remote, token, and branch are interpolated.
 *
 * @param repository - The server remote and its default branch.
 * @param scope - `write` yields clone, copy, commit, push; `read` yields clone and show.
 * @param token - The minted token, or null where the remote path itself is the access.
 * @returns Newline-separated shell commands.
 */
export const procedure = (
  repository: Model.Repository,
  scope: Model.Scope,
  token: string | null,
): string => {
  const auth = header(token);
  const clone = `git${auth} clone ${repository.remote} talkto-files`;
  if (scope === "read") return [clone, "git -C talkto-files show <commit>:<path>"].join("\n");
  return [
    clone,
    "cp <your file> talkto-files/<path>",
    'git -C talkto-files add -A && git -C talkto-files commit -m "<why this file exists>"',
    `git -C talkto-files${auth} push origin ${repository.defaultBranch}`,
  ].join("\n");
};
