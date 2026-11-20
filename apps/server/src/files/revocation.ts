import { Clock, DateTime, Effect, Result } from "effect";
import * as M from "@talkto/api/models";
import * as Store from "../persistence.js";
import * as Telemetry from "../telemetry.js";
import * as Model from "./model.js";

/**
 * Revoke every live token whose grant has been revoked, then stamp the ledger.
 *
 * Runs after each access delivery and on every alarm-driven flush pass. Store calls stay
 * between the two transactions. A store failure leaves the row unstamped so a later pass
 * retries it; an absent store means no token could exist at the provider, so the row is
 * stamped as revoked.
 *
 * @param serverId - The server whose ledger is swept.
 * @returns The number of tokens the store could not revoke in this pass.
 */
export const revokeForRevokedGrants = Effect.fn("Files.revokeForRevokedGrants")(function* (
  serverId: M.ServerId,
) {
  const persistence = yield* Store.Persistence;
  const store = yield* Model.FileStore;
  const at = M.Timestamp.make(
    DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
  );
  const tokens = yield* persistence.transaction("fileTokens.revocable", (tx) =>
    tx.revocableFileTokens(at),
  );
  let pending = 0;
  for (const token of tokens) {
    const revoked = yield* store.revoke(serverId, token.tokenId).pipe(Effect.result);
    if (Result.isFailure(revoked) && revoked.failure._tag === "FileStoreFailure") {
      Telemetry.failure("files_unavailable", crypto.randomUUID(), revoked.failure, "files");
      pending++;
      continue;
    }
    yield* persistence.transaction("fileTokens.revoke", (tx) => tx.revokeFileToken(token.id, at));
  }
  return pending;
});
