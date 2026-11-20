import { Effect } from "effect";
import * as Model from "./model.js";

/**
 * TalkTo Local: one bare repository on this machine; the path is the access, so no token is
 * minted. The remote is configuration, so `ensure` answers from it on every call and ignores the
 * recorded row: a relocated repository reaches the next access.
 */
export const make = (remote: string) =>
  Model.FileStore.of({
    ensure: () => Effect.succeed({ remote, defaultBranch: "main" }),
    mint: () => Effect.succeed({ id: "local", token: null, expiresAt: null }),
    revoke: () => Effect.void,
    remove: () => Effect.void,
  });
