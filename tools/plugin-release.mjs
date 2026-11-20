// Sets the version of TalkTo's plugins for a release (docs/plugin-release.md):
//
//   pnpm plugin:release 0.4.0                   every plugin
//   pnpm plugin:release 0.4.0 claude-code hooks only these
//   pnpm plugin:release --check                 print each plugin's versions; fail when any differ
//
// For each plugin it writes the version into every manifest that carries one and into the
// constant the plugin reports to TalkTo, then the server's `latestPluginVersions` in
// packages/api/src/plugins.ts, then refreshes the plugin copies (core/sync.mjs, hooks/sync.mjs).
// It never commits, pushes or publishes: publishing talkto-sh/talkto-plugin is a separate step.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));

/** A file and how its version is written in it. */
const json = (path) => ({ path, pattern: /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/ });
const constant = (path) => ({ path, pattern: /(export const version = ")(\d+\.\d+\.\d+)(")/ });

/**
 * Every place each plugin's version is written. Hosts read the manifests (Claude Code, Codex,
 * Gemini CLI and Antigravity notice an update only when a manifest's version changes); the plugin
 * reports the constant to TalkTo.
 */
export const plugins = {
  "claude-code": [
    json("integrations/claude-code/.claude-plugin/plugin.json"),
    json("integrations/claude-code/package.json"),
    constant("integrations/claude-code/hooks/version.ts"),
  ],
  opencode: [
    json("integrations/opencode/package.json"),
    constant("integrations/opencode/version.ts"),
  ],
  pi: [json("integrations/pi/package.json"), constant("integrations/pi/version.ts")],
  hermes: [
    { path: "integrations/hermes/plugin.yaml", pattern: /^(version: )(\d+\.\d+\.\d+)()$/m },
    { path: "integrations/hermes/version.py", pattern: /^(VERSION = ")(\d+\.\d+\.\d+)(")$/m },
  ],
  openclaw: [
    json("integrations/openclaw/package.json"),
    json("integrations/openclaw/openclaw.plugin.json"),
    json("integrations/openclaw.plugin.json"),
    constant("integrations/openclaw/version.mjs"),
  ],
  hooks: [
    json("integrations/hooks/package.json"),
    json("integrations/hooks/codex/.codex-plugin/plugin.json"),
    json("integrations/hooks/cursor/.cursor-plugin/plugin.json"),
    json("integrations/hooks/copilot/plugin.json"),
    json("integrations/hooks/gemini/gemini-extension.json"),
    json("integrations/hooks/gemini/plugin.json"),
    json("integrations/hooks/claude-format/.claude-plugin/plugin.json"),
    constant("integrations/hooks/src/talkto-hook.mjs"),
  ],
};

/**
 * The repository's own packages: the root package.json is the manifest Pi and OpenClaw read from
 * a git install, and the core is shared by Claude Code, OpenCode and Pi. They take the newest
 * version of the release.
 */
const shared = [json("integrations/package.json"), json("integrations/core/package.json")];

const server = {
  path: "packages/api/src/plugins.ts",
  pattern: (name) =>
    new RegExp(`(\\n  ${name.includes("-") ? `"${name}"` : name}: ")(\\d+\\.\\d+\\.\\d+)(")`),
};

const versionPattern = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

const read = (file) => {
  const found = file.pattern.exec(readFileSync(repo(file.path), "utf8"));
  if (found === null) throw new Error(`${file.path}: no version found`);
  return found[2];
};
const write = (file, version) => {
  const text = readFileSync(repo(file.path), "utf8");
  if (!file.pattern.test(text)) throw new Error(`${file.path}: no version found`);
  writeFileSync(repo(file.path), text.replace(file.pattern, `$1${version}$3`));
};

/** Each plugin's versions as written in its files and in the server's list. */
export const versionsOf = () =>
  Object.fromEntries(
    Object.entries(plugins).map(([name, files]) => [
      name,
      {
        files: Object.fromEntries(files.map((file) => [file.path, read(file)])),
        server: read({ path: server.path, pattern: server.pattern(name) }),
      },
    ]),
  );

/** Plugins whose files or server entry disagree, with what each says. */
export const mismatches = () =>
  Object.entries(versionsOf()).filter(
    ([, { files, server: latest }]) => !Object.values(files).every((value) => value === latest),
  );

/** Newer than: three numbers each. */
const newer = (a, b) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (x[index] !== y[index]) return x[index] > y[index];
  return false;
};

/** Set `version` for `names` (every plugin when empty). */
export const release = (version, names) => {
  if (!versionPattern.test(version)) throw new Error(`"${version}" is not a version like 0.4.0`);
  const chosen = names.length === 0 ? Object.keys(plugins) : names;
  for (const name of chosen) if (!(name in plugins)) throw new Error(`unknown plugin "${name}"`);
  for (const name of chosen) {
    const current = read({ path: server.path, pattern: server.pattern(name) });
    if (!newer(version, current))
      throw new Error(`${name} is already at ${current}; a release must raise it`);
  }
  for (const name of chosen) {
    for (const file of plugins[name]) write(file, version);
    write({ path: server.path, pattern: server.pattern(name) }, version);
  }
  for (const file of shared) if (newer(version, read(file))) write(file, version);
  execFileSync(process.execPath, [repo("integrations/core/sync.mjs")], { stdio: "inherit" });
  execFileSync(process.execPath, [repo("integrations/hooks/sync.mjs")], { stdio: "inherit" });
  return chosen;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [first, ...rest] = process.argv.slice(2);
  if (first === undefined || first === "--check") {
    for (const [name, { files, server: latest }] of Object.entries(versionsOf()))
      console.log(`${name}: server ${latest}; ${[...new Set(Object.values(files))].join(", ")}`);
    const wrong = mismatches();
    if (wrong.length > 0) {
      console.error(`Versions differ for: ${wrong.map(([name]) => name).join(", ")}`);
      process.exit(1);
    }
  } else {
    const done = release(first, rest);
    console.log(
      [
        `Set ${done.join(", ")} to ${first}.`,
        "Next (docs/plugin-release.md): add the release to apps/docs/src/content/docs/updates.mdx,",
        "run pnpm check, commit, and hand the commit to whoever publishes talkto-sh/talkto-plugin.",
      ].join("\n"),
    );
  }
}
