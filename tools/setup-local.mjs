import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const target = new URL("../apps/server/.dev.vars", import.meta.url);
const repository = fileURLToPath(new URL("../apps/server/.talkto/files.git", import.meta.url));
const git = (args) => promisify(execFile)("git", args);

/**
 * Create (or keep) the bare repository local agents push to. Any Git failure turns file
 * sharing off for this setup and is reported on one line; the rest of the credentials are
 * still written. HEAD is set after `init` because `--initial-branch` needs Git 2.28.
 */
async function prepareFiles() {
  try {
    await git(["init", "--bare", repository]);
    await git(["-C", repository, "symbolic-ref", "HEAD", "refs/heads/main"]);
  } catch (error) {
    const detail =
      error instanceof Error && "code" in error && error.code === "ENOENT"
        ? "git was not found on PATH."
        : `git could not initialize apps/server/.talkto/files.git.${
            error instanceof Error && "stderr" in error && String(error.stderr).trim() !== ""
              ? ` ${String(error.stderr).trim()}`
              : ""
          }`;
    console.log(`File sharing is off: ${detail}`);
    return null;
  }
  return `TALKTO_FILES_REMOTE=${pathToFileURL(repository).href}\n`;
}

const files = await prepareFiles();
const content = `TALKTO_LOCAL_TOKEN=${randomBytes(32).toString("hex")}\nTALKTO_SERVER_ID=${randomUUID()}\nTALKTO_GRANT_ID=${randomUUID()}\n${files ?? ""}`;
try {
  await writeFile(target, content, { flag: "wx", mode: 0o600 });
  console.log(
    "Created local credentials in apps/server/.dev.vars. Run pnpm dev. Credentials were not printed.",
  );
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "EEXIST") {
    const existing = await readFile(target, "utf8");
    if (files !== null && !/^TALKTO_FILES_REMOTE=/m.test(existing))
      await appendFile(target, `${existing.endsWith("\n") ? "" : "\n"}${files}`);
    console.log("Existing apps/server/.dev.vars preserved. Run pnpm dev.");
  } else throw error;
}
