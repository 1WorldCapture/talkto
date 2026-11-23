/**
 * Which agent joined during one walkthrough of Connect agents.
 *
 * The baseline is the server's agents in a list fetched after this walkthrough started, so an
 * agent connected earlier, in the same dialog or before it opened, never counts as this one.
 * (November 2026: connecting Antigravity right after Claude Code showed "Joined as" the Claude
 * Code agent, because the baseline came from when the dialog opened, or from a cached list.)
 */
export interface JoinBaseline {
  /** When the walkthrough started. A list fetched before then cannot be the baseline. */
  readonly since: number;
  /** The agents already on the server, once a list fetched since then has arrived. */
  readonly ids: ReadonlySet<string> | null;
}

export const startBaseline = (now: number): JoinBaseline => ({ since: now, ids: null });

/** The baseline, settled from the latest list when that list was fetched after it started. */
export const settleBaseline = (
  baseline: JoinBaseline,
  list: { readonly updatedAt: number; readonly ids: ReadonlyArray<string> } | undefined,
): JoinBaseline =>
  baseline.ids !== null || list === undefined || list.updatedAt < baseline.since
    ? baseline
    : { since: baseline.since, ids: new Set(list.ids) };

/**
 * The agent that joined since the baseline: the first of the chosen tool's type, else the first
 * newcomer, since some agents report a different type than their guide's.
 */
export const arrival = <A extends { readonly id: string; readonly agentType: string }>(
  baseline: JoinBaseline,
  agents: ReadonlyArray<A>,
  agentType: string | null,
  isAgent: (agent: A) => boolean,
): A | null => {
  const known = baseline.ids;
  if (known === null) return null;
  const newcomers = agents.filter((agent) => !known.has(agent.id) && isAgent(agent));
  return newcomers.find((agent) => agent.agentType === agentType) ?? newcomers.at(0) ?? null;
};
