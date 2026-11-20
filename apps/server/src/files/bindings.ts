import { Effect, Option } from "effect";
import * as Configuration from "../configuration.js";
import * as Artifacts from "./artifacts.js";
import * as Local from "./local.js";
import * as Model from "./model.js";
import * as R2 from "./r2.js";
import * as Transfers from "./transfers.js";

/** Choose the file store the bound environment supports: Artifacts, a local bare repository, or none. */
export const configure = Effect.fn("Files.configure")(function* (env: Env) {
  if (env.ARTIFACTS !== undefined) {
    const remoteBase = yield* Configuration.readArtifactsRemoteBase(env);
    return Artifacts.make(env.ARTIFACTS, remoteBase);
  }
  const remote = yield* Configuration.readFilesRemote(env);
  return Option.match(remote, {
    onNone: () => Model.unavailable,
    onSome: (value) => Local.make(value),
  });
});
/** Choose the transfer store: R2 when fully configured, otherwise none. */
export const configureTransfers = (env: Env) => {
  const settings = Configuration.r2Settings(env);
  return settings === null ? Transfers.unavailable : R2.make(settings);
};
