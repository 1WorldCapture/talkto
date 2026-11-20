import { Clock, Effect } from "effect";
import type * as M from "@talkto/api/models";
import * as Signals from "./signals.js";
import * as Starter from "./starter/inbox.js";

/** Entries each isolate-local memory keeps; the oldest leaves first. */
const remembered = 10_000;
/** How long a server existence answer is reused: a server lives long, a miss may be a new one. */
const foundMs = 10 * 60_000;
const missingMs = 60_000;
const servers = new Map<string, { readonly found: boolean; readonly until: number }>();
const blockedUntil = new Map<string, number>();
/** Insertion order is age: refresh moves an entry to the end, overflow drops the oldest. */
const remember = <V>(memory: Map<string, V>, key: string, value: V) => {
  memory.delete(key);
  memory.set(key, value);
  if (memory.size <= remembered) return;
  const oldest = memory.keys().next();
  if (oldest.done !== true) memory.delete(oldest.value);
};

/**
 * Whether the directory knows a server that is not being deleted: one primary-key read, reused
 * per isolate. An unavailable directory admits the check, because the server object still
 * checks the secret and hooks must keep working while D1 is down.
 */
const exists = Effect.fn("SignalGuard.exists")(
  function* (database: D1Database, serverId: M.ServerId) {
    const now = yield* Clock.currentTimeMillis;
    const cached = servers.get(serverId);
    if (cached !== undefined && cached.until > now) return cached.found;
    const row = yield* Effect.tryPromise(() =>
      database
        .prepare("SELECT 1 AS found FROM servers WHERE id=? AND deletion_requested_at IS NULL")
        .bind(serverId)
        .first(),
    );
    const found = row !== null;
    remember(servers, serverId, { found, until: now + (found ? foundMs : missingMs) });
    return found;
  },
  Effect.orElseSucceed(() => true),
);

/**
 * The hosted Worker's guard for one signal check, before any server object is woken:
 * - a link tagged with `TALKTO_SIGNAL_KEY` is admitted with no D1 read;
 * - any other link (minted before the key, without one, or guessed) is admitted only when D1
 *   knows its server, so an unknown server ID never instantiates a Durable Object;
 * - failed checks count against `SIGNAL_FAILURES` per network (an IPv4 address or an IPv6 /64);
 *   over the limit, that network's checks answer 429 for a period. Without the binding, or
 *   without an edge-supplied address, nothing is counted.
 */
export const make = (env: Env, request: Request): Signals.Guard => {
  // Edge-supplied, never a client header: Cloudflare overwrites cf-connecting-ip.
  const address = request.headers.get("cf-connecting-ip");
  const network = address === null || address === "" ? null : Starter.network(address);
  const key = Signals.signalKey(env.TALKTO_SIGNAL_KEY);
  const limiter = env.SIGNAL_FAILURES;
  return {
    blocked: Clock.currentTimeMillis.pipe(
      Effect.map((now) => network !== null && (blockedUntil.get(network) ?? 0) > now),
    ),
    admit: Effect.fn("SignalGuard.admit")(function* (link) {
      if (key !== null && (yield* Signals.tagged(key, link))) return true;
      return yield* exists(env.PLATFORM, link.serverId);
    }),
    failed: Effect.gen(function* () {
      if (network === null || limiter === undefined) return false;
      const outcome = yield* Effect.promise(() =>
        limiter.limit({ key: network }).catch(() => ({ success: true })),
      );
      if (outcome.success) return false;
      const now = yield* Clock.currentTimeMillis;
      remember(blockedUntil, network, now + Signals.networkRetrySeconds * 1000);
      return true;
    }),
  };
};
