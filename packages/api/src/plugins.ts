import { Schema } from "effect";

/**
 * TalkTo's plugins report their name and version when they call TalkTo, so the server can tell a
 * plugin that a newer release exists and the dashboard can show "Update available" on the agent.
 *
 * - Plugins that call `get_updates` (Claude Code, OpenCode, Pi, Hermes Agent) send the optional
 *   `plugin` field, as in `claude-code/0.3.0`. Its page answers with `latestPluginVersion`.
 * - talkto-hooks and the OpenClaw plugin check a signal link over plain HTTP, so they send the
 *   same text in the `TalkTo-Plugin` header. The counts answer with `latestPluginVersion`.
 *
 * The server records the newest report per participant. Agents never set the field themselves.
 */

/** Each plugin in the talkto-sh/talkto-plugin repository, by the folder it ships from. */
export const pluginNames = [
  "claude-code",
  "opencode",
  "pi",
  "hermes",
  "openclaw",
  "hooks",
] as const;
/** One plugin of the repository. */
export type PluginName = (typeof pluginNames)[number];

/**
 * The newest published version of each plugin. The release process (docs/plugin-release.md,
 * `pnpm plugin:release`) bumps these with the plugin manifests, and a test keeps them equal.
 */
export const latestPluginVersions = {
  "claude-code": "0.3.5",
  opencode: "0.3.5",
  pi: "0.3.5",
  hermes: "0.3.5",
  openclaw: "0.3.2",
  hooks: "0.4.1",
} as const satisfies { readonly [K in PluginName]: string };

/** The HTTP header talkto-hooks and the OpenClaw plugin send on signal link checks. */
export const pluginHeader = "talkto-plugin";

/** The public page that lists every release and how to update each agent. */
export const updatesPath = "/docs/updates/";

/** Where each plugin's update steps are on the updates page. */
export const updateAnchors = {
  "claude-code": "claude-code",
  opencode: "opencode",
  pi: "pi",
  hermes: "hermes-agent",
  openclaw: "openclaw",
  hooks: "talkto-hooks",
} as const satisfies { readonly [K in PluginName]: string };

const versionPattern = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;
const releasePattern = /^([a-z][a-z0-9-]{0,31})\/(\d{1,4}\.\d{1,4}\.\d{1,4})$/;

/** A plugin version, three numbers as in `0.3.0`. */
export const PluginVersion = Schema.String.check(Schema.isPattern(versionPattern));
/** Parsed plugin version. */
export type PluginVersion = typeof PluginVersion.Type;

/**
 * A plugin and its version, as in `claude-code/0.3.0`. Any lowercase name is accepted, so a plugin
 * newer than this server still reports; only the names above get `latestPluginVersion`.
 */
export const PluginRelease = Schema.String.check(Schema.isPattern(releasePattern)).annotate({
  description:
    "Set only by TalkTo's own plugins: the plugin and its version, as in claude-code/0.3.0. Leave it out.",
});
/** Parsed plugin report. */
export type PluginRelease = typeof PluginRelease.Type;

/** One plugin report, split. */
export interface Report {
  readonly name: string;
  readonly version: PluginVersion;
}

/** Split a report into its name and version; null when it is not one. */
export const parseRelease = (text: string): Report | null => {
  const found = releasePattern.exec(text);
  const name = found?.[1];
  const version = found?.[2];
  return name === undefined || version === undefined ? null : { name, version };
};

const parts = (version: string): ReadonlyArray<number> | null => {
  const found = versionPattern.exec(version);
  return found === null ? null : found.slice(1).map(Number);
};

/** Negative when `left` is older than `right`, zero when equal, positive when newer. */
export const compareVersions = (left: string, right: string): number => {
  const a = parts(left) ?? [0, 0, 0];
  const b = parts(right) ?? [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const isPluginName = (name: string): name is PluginName =>
  pluginNames.some((known) => known === name);

/** The newest published version of a plugin, or null for a name this server does not know. */
export const latestVersionOf = (name: string): PluginVersion | null =>
  isPluginName(name) ? latestPluginVersions[name] : null;

/** The newer version a plugin should update to, or null when it is current or unknown. */
export const updateFor = (report: Report): PluginVersion | null => {
  const latest = latestVersionOf(report.name);
  return latest !== null && compareVersions(report.version, latest) < 0 ? latest : null;
};

/** The updates page section for one plugin, or the page itself for an unknown name. */
export const updatesLink = (origin: string, name: string): string =>
  `${origin}${updatesPath}${isPluginName(name) ? `#${updateAnchors[name]}` : ""}`;
