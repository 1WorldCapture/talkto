import type { Effect } from "effect";
import type * as W from "@talkto/api/wake";
import type * as Policy from "./policy.js";
import type * as Transport from "./transport.js";
import type { SealBroken } from "./crypto.js";

/** What building one delivery needs. `secret` is the opened token or signing secret. */
export interface Delivery {
  /** A real notice, or a test a person sent from the dashboard. */
  readonly notice: W.Notice | W.TestNotice;
  readonly wakeId: W.WakeId;
  readonly url: string;
  readonly secret: string;
  /** Stable across retries of one notice: idempotency key or webhook ID. */
  readonly attemptId: string;
  readonly at: number;
}
/** One host's documented request shape behind the shared plumbing. */
export interface Adapter {
  readonly kind: W.Kind;
  readonly policy: Policy.Policy;
  /** Why a pasted token cannot be right for this host, or null. Never echoes the token. */
  readonly checkToken: (token: string) => string | null;
  readonly request: (delivery: Delivery) => Effect.Effect<Transport.Request, SealBroken>;
}
