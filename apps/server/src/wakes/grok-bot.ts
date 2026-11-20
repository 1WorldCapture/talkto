import { Effect } from "effect";
import * as W from "@talkto/api/wake";
import type { Adapter } from "./kind.js";
import * as Policy from "./policy.js";

/**
 * Grok Bot routines, webhook trigger.
 * Request: https://docs.x.ai/grok-bot/skills-routines-and-automations — POST to the routine's
 * "POST to" URL with `Authorization: Bearer <key>` and an optional JSON body, which the Bot receives
 * with the routine instruction. 200 means a run started.
 * Limits: same page — 200 runs an hour per routine, 300 an hour across a person's routines.
 * Host: the official page names none; see `W.addresses.grok_bot`.
 * No idempotency key is documented, so a lost response is never retried.
 */
export const adapter: Adapter = {
  kind: "grok_bot",
  policy: {
    ...W.addresses.grok_bot,
    minIntervalMs: 60_000,
    maxAttempts: 4,
    retryOnTimeout: false,
  },
  checkToken: () => null,
  request: (delivery) =>
    Effect.succeed({
      policy: adapter.policy,
      url: delivery.url,
      headers: {
        authorization: `Bearer ${delivery.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        source: "talkto",
        text: Policy.sentence(delivery.notice),
        ...delivery.notice,
      }),
    }),
};
