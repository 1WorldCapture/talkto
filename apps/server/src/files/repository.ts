import { Clock, DateTime, Effect } from "effect";
import * as M from "@talkto/api/models";
import * as Store from "../persistence.js";
import * as Model from "./model.js";

/**
 * The server repository as people see it, ensured and recorded the first time anyone looks.
 *
 * A recorded row answers without reaching the store: the dashboard reads this on every server
 * view, and every agent access rewrites the row from the store, so a relocated remote reaches
 * people at the next access. Only the first look, before any agent has asked for access, pays
 * the ensure; so does a look after the row stopped parsing, which persistence reads as missing
 * and this rewrites. The store call stays between the two transactions.
 *
 * @param serverId - The server whose repository is described.
 * @returns The recorded or newly ensured repository.
 */
export const describe = Effect.fn("Files.describeRepository")(function* (serverId: M.ServerId) {
  const persistence = yield* Store.Persistence;
  const store = yield* Model.FileStore;
  const recorded = yield* persistence.transaction("fileRepository.read", (tx) =>
    tx.fileRepository(),
  );
  if (recorded !== null) return recorded;
  const repository = yield* store.ensure(serverId, null);
  const at = M.Timestamp.make(
    DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
  );
  yield* persistence.transaction("fileRepository.record", (tx) =>
    tx.setFileRepository(repository, at),
  );
  return repository;
});
