import { DateTime } from "effect";
import type * as M from "@talkto/api/models";
import * as P from "@talkto/api/plugins";
import "./plugin-update.css";

/**
 * A report older than this no longer says what the agent runs: the agent may have stopped, moved
 * to MCP alone, or updated on a server it has not called since.
 */
export const staleReportDays = 14;
const staleMillis = staleReportDays * 86_400_000;

/** The update an agent's plugin should take, and where its steps are; null when none is due. */
export interface PluginUpdateDue {
  readonly current: P.PluginVersion;
  readonly latest: P.PluginVersion;
  /** The plugin's section of the public updates page, on this site. */
  readonly href: string;
}

/**
 * Whether an agent's last plugin report is behind the newest release. Agents without a plugin,
 * plugins before 0.3.0 (they report nothing), unknown plugins and stale reports show nothing.
 */
export function pluginUpdateDue(
  plugin: M.PluginSeen | undefined,
  now: number,
): PluginUpdateDue | null {
  if (plugin === undefined) return null;
  if (now - DateTime.toEpochMillis(DateTime.makeUnsafe(plugin.seenAt)) > staleMillis) return null;
  const latest = P.updateFor({ name: plugin.name, version: plugin.version });
  if (latest === null) return null;
  return { current: plugin.version, latest, href: P.updatesLink("", plugin.name) };
}

/** "Update available" on an agent card, linking to that plugin's update steps. */
export function PluginUpdate({
  plugin,
  now = Date.now(),
}: {
  readonly plugin: M.PluginSeen | undefined;
  readonly now?: number;
}) {
  const due = pluginUpdateDue(plugin, now);
  if (due === null) return null;
  return (
    <a
      className="plugin-update"
      href={due.href}
      title={`This agent runs plugin ${due.current}; ${due.latest} is available. See how to update.`}
    >
      Update available
    </a>
  );
}
