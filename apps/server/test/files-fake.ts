import { DateTime, Effect } from "effect";
import * as M from "@talkto/api/models";
import * as Model from "../src/files/model.js";

/** Everything the fake observed, in call order. */
export interface Recorded {
  readonly ensured: ReadonlyArray<M.ServerId>;
  /** The recorded remote each `ensure` was handed, null when the ledger held no readable row. */
  readonly hinted: ReadonlyArray<string | null>;
  readonly minted: ReadonlyArray<{
    readonly serverId: M.ServerId;
    readonly id: string;
    readonly scope: Model.Scope;
    readonly ttlSeconds: number;
  }>;
  readonly revoked: ReadonlyArray<{ readonly serverId: M.ServerId; readonly tokenId: string }>;
  readonly removed: ReadonlyArray<M.ServerId>;
}
/** Test-only levers over the fake's behavior, applied between calls. */
export interface Control {
  /** Serve this remote from `ensure` instead of the derived one, as a relocated store would; null restores the derived remote. */
  readonly remote?: string | null;
  /** Fail this many upcoming revocations with a `FileStoreFailure`, then succeed again. */
  readonly failRevocations?: number;
  /** Fail this many upcoming repository removals with a `FileStoreFailure`, then succeed again. */
  readonly failRemovals?: number;
}
const now = () => M.Timestamp.make(DateTime.formatIso(DateTime.nowUnsafe()));
const derived = (serverId: M.ServerId) =>
  `https://fake.artifacts.test/git/test/srv-${serverId}.git`;
const missing = (operation: string) =>
  new Model.FileStoreFailure({
    message: "The repository does not exist.",
    operation,
    provider: "fake",
    code: "NOT_FOUND",
  });
const outage = (operation: string) =>
  new Model.FileStoreFailure({
    message: "The fake store is failing on request.",
    operation,
    provider: "fake",
    code: "INTERNAL_ERROR",
  });

/** In-memory store with deterministic remotes and `fake_<n>` tokens; mirrors the hosted store's shape. */
export const make = (clock: () => M.Timestamp = now) => {
  const repositories = new Set<M.ServerId>();
  const ensured: M.ServerId[] = [];
  const hinted: (string | null)[] = [];
  const minted: Recorded["minted"][number][] = [];
  const revoked: Recorded["revoked"][number][] = [];
  const removed: M.ServerId[] = [];
  let sequence = 0;
  let relocated: string | null = null;
  let failingRevocations = 0;
  let failingRemovals = 0;
  const store = Model.FileStore.of({
    // Like the local store, the fake answers from its own state on every call so relocation
    // tests keep working; the hint is only observed.
    ensure: (serverId, recorded) =>
      Effect.sync(() => {
        repositories.add(serverId);
        ensured.push(serverId);
        hinted.push(recorded === null ? null : recorded.remote);
        return { remote: relocated ?? derived(serverId), defaultBranch: "main" };
      }),
    mint: (serverId, scope, ttlSeconds) =>
      Effect.suspend(() => {
        if (!repositories.has(serverId)) return Effect.fail(missing("get"));
        sequence++;
        const id = `fake_${sequence}`;
        minted.push({ serverId, id, scope, ttlSeconds });
        const issued = DateTime.makeUnsafe(clock());
        const expiresAt = M.Timestamp.make(
          DateTime.formatIso(DateTime.add(issued, { seconds: ttlSeconds })),
        );
        return Effect.succeed({ id, token: id, expiresAt });
      }),
    revoke: (serverId, tokenId) =>
      Effect.suspend(() => {
        if (!repositories.has(serverId)) return Effect.fail(missing("get"));
        if (failingRevocations > 0) {
          failingRevocations--;
          return Effect.fail(outage("revokeToken"));
        }
        revoked.push({ serverId, tokenId });
        return Effect.void;
      }),
    remove: (serverId) =>
      Effect.suspend(() => {
        if (failingRemovals > 0) {
          failingRemovals--;
          return Effect.fail(outage("deleteRepository"));
        }
        repositories.delete(serverId);
        removed.push(serverId);
        return Effect.void;
      }),
  });
  const recorded = (): Recorded => ({
    ensured: [...ensured],
    hinted: [...hinted],
    minted: [...minted],
    revoked: [...revoked],
    removed: [...removed],
  });
  const control = (input: Control) => {
    if (input.remote !== undefined) relocated = input.remote;
    if (input.failRevocations !== undefined) failingRevocations = input.failRevocations;
    if (input.failRemovals !== undefined) failingRemovals = input.failRemovals;
  };
  return { store, recorded, control };
};
