import * as Artifacts from "./artifacts.js";
import * as Model from "./model.js";

/**
 * Choose memory's Git store: the `MEMORY_ARTIFACTS` binding, or none. TalkTo Local binds none, so
 * memory is cleanly unavailable there (docs/swarm-server-spec.md, 14.9).
 */
export const configure = (env: Env): Model.Repositories["Service"] =>
  env.MEMORY_ARTIFACTS === undefined ? Model.unavailable : Artifacts.make(env.MEMORY_ARTIFACTS);
