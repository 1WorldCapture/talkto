import instructions from "./instructions.md";

/**
 * The agent guide as this deployment serves it. Swarm memory's lines sit between `<!-- memory -->`
 * and `<!-- /memory -->` in instructions.md (docs/swarm-server-spec.md, 14): they ship only where
 * the deployment offers memory (`TALKTO_MEMORY=on` and a `MEMORY_ARTIFACTS` binding), so agents
 * elsewhere never read about it. The markers themselves never reach an agent.
 */
export const agentGuide = (memory: boolean): string =>
  memory
    ? instructions.replace(/\n+<!-- \/?memory -->\n+/gu, "\n")
    : instructions.replace(/\n+<!-- memory -->\n[\s\S]*?<!-- \/memory -->\n+/gu, "\n");
