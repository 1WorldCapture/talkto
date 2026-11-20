import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { start } from "../test/platform-harness.mjs";
import { everyTool, outputSchemas, packSnapshot, snapshotDirectory } from "../test/mcp-output.mjs";

/*
  Record the MCP output schemas a release lists in contracts/mcp-output/<date>-<short commit>.json
  (format: test/mcp-output.mjs). Run it (`pnpm --filter @talkto/server mcp:snapshot`, which
  rebuilds dist/platform-test first) for each production release that changes MCP tools, and commit
  the file: test/mcp-compat.test.mjs then checks every later reply against it, as a host that
  connected under that release does. The release is HEAD, or `--commit <ref>`; either way the code
  that shapes MCP replies must match it exactly. The date is the commit's (UTC), so running it
  again for the same commit writes the same file.
*/

const { values } = parseArgs({ options: { commit: { type: "string", default: "HEAD" } } });
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", env: { ...process.env, TZ: "UTC" } }).trim();
const shaping = ["src", "../../packages/api/src"];
const differs =
  git("diff", "--name-only", values.commit, "--", ...shaping) +
  git("ls-files", "--others", "--exclude-standard", "--", ...shaping);
if (differs !== "") {
  console.error(
    `Refusing to snapshot: the code that shapes MCP replies differs from ${values.commit}:\n${differs}\nCommit it, or check out that commit's version, so the snapshot names the code it came from.`,
  );
  process.exit(1);
}
const commit = git("rev-parse", "--short=7", values.commit);
const date = git("log", "-1", "--format=%cd", "--date=format-local:%Y-%m-%d", values.commit);

const cleanups = [];
const x = await start({ after: (cleanup) => cleanups.push(cleanup) }, everyTool);
try {
  const account = await x.account();
  const schemas = await outputSchemas(x.raw, await x.mcpToken(account.organizationId));
  const text = packSnapshot(schemas);
  mkdirSync(snapshotDirectory, { recursive: true });
  const file = join(snapshotDirectory, `${date}-${commit}.json`);
  writeFileSync(file, text);
  console.log(
    `Wrote ${relative(process.cwd(), file)}: ${Object.keys(schemas).length} tools, ${Math.round(text.length / 1024)} KB. Commit it with the release.`,
  );
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
}
