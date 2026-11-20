import type * as A from "@talkto/api/agent";
import * as E from "@talkto/api/errors";
import * as Configuration from "./configuration.js";
import * as WakeSettings from "./wakes/settings.js";

/** Optional features a deployment may offer; agents branch on the reported set. */
export type Capability = A.Capability;
/** Pure view of what the bound environment offers, so catalogs and context replies agree with composition. */
export const capabilities = (env: Env): ReadonlySet<Capability> => {
  const found = new Set<Capability>();
  if (env.ARTIFACTS !== undefined || Configuration.localRemote(env) !== null) found.add("files");
  if (Configuration.r2Settings(env) !== null) found.add("transfers");
  const wakes = WakeSettings.fromEnv(env);
  if (wakes.events) found.add("wakes");
  if (wakes.tokens) found.add("wake_tokens");
  return found;
};
/** The Git sharing tools, offered only with the `files` capability. */
export const gitSharingTools: ReadonlySet<string> = new Set(["get_files_access", "share_file"]);
/**
 * The answer to a Git sharing call on a deployment without the `files` capability. Hosted TalkTo
 * retired Git sharing on 2026-11-16, and agents, plugins and cached tool lists still name the
 * tools, so the answer points at transfers where they are offered instead of an unknown tool.
 * `absent` is a deployment fact, never reported as an incident.
 */
export const gitSharingAbsent = (found: ReadonlySet<Capability>) =>
  new E.FilesUnavailable({
    message: found.has("transfers")
      ? "Git file sharing (get_files_access and share_file) has ended on this deployment. Send a file with prepare_transfer and then complete_transfer; get_pack_command packs a folder first. Accept an offer with fetch_transfer. Files announced by earlier share messages can no longer be fetched."
      : "File sharing is not available on this deployment. Paste the content into a message if it fits.",
    operation: "files",
    reason: "absent",
  });
