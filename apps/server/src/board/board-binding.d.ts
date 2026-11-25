// `wrangler types` reads the default wrangler.jsonc, which sets neither switch: a deployment turns
// the board on with TALKTO_BOARD=on once it is ready to offer it.
interface Env {
  /** `on` offers the task board (docs/swarm-server-spec.md); anything else keeps it off. */
  readonly TALKTO_BOARD?: string;
  /** `off` removes the task-operation limit (120 a minute per agent); on by default. */
  readonly TALKTO_TASK_LIMITS?: string;
  /** `on` offers swarm memory where `MEMORY_ARTIFACTS` is bound (docs/swarm-server-spec.md, 14). */
  readonly TALKTO_MEMORY?: string;
  /** `off` removes the monthly task-operation budget per organization; on by default. */
  readonly TALKTO_TASK_BUDGETS?: string;
  /** `off` creates Free swarm servers without the default claim cap of 4; on by default. */
  readonly TALKTO_FREE_CLAIM_CAP?: string;
}
