/**
 * `TALKTO_BOARD`: `on` lists the task tools on every MCP connection and lets swarm servers use
 * their board. Anything else (the default) answers `board_off` everywhere and lists no tool, so a
 * deployment ships the code before it offers the board. Read synchronously at composition, like
 * the wake settings, because MCP listing needs it before any request runs.
 */
export const fromEnv = (env: Env): boolean => env.TALKTO_BOARD === "on";
/**
 * `TALKTO_MEMORY`: `on` (with `TALKTO_BOARD=on` and a `MEMORY_ARTIFACTS` binding) gives every
 * swarm server memory, with no switch per server (docs/swarm-server-spec.md, 14). It is the
 * operator's kill switch: anything else, or no binding, leaves every reply as it is without memory
 * on every server: claims carry none (and still work), the memory tools are not listed, and memory
 * settings are refused.
 */
export const memoryFromEnv = (env: Env): boolean =>
  fromEnv(env) && env.TALKTO_MEMORY === "on" && env.MEMORY_ARTIFACTS !== undefined;
/** The switch alone, for a server object whose store is chosen at composition (memory/bindings.ts). */
export const memorySwitchFromEnv = (env: Env): boolean =>
  fromEnv(env) && env.TALKTO_MEMORY === "on";
/**
 * `TALKTO_FREE_CLAIM_CAP`: `off` creates Free swarm servers without a claim cap, as before; anything
 * else (the default) starts them at `freeClaimCap` (packages/api/src/pricing.ts).
 */
export const freeClaimCapFromEnv = (env: Env): boolean => env.TALKTO_FREE_CLAIM_CAP !== "off";
