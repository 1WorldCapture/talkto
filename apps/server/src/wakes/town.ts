import { Effect } from "effect";
import * as W from "@talkto/api/wake";
import type { Adapter } from "./kind.js";
import * as Policy from "./policy.js";

/**
 * Town routines, webhook trigger.
 * Request: https://www.town.com/docs/routines/stock-routines/webhooks — POST to the Webhook card's
 * URL (`…/workflow-webhooks/whk_…`) with `Authorization: Bearer whsec_…`, `Content-Type:
 * application/json`, an optional `X-Town-Idempotency-Key`, and `{"data": …}`. 202 means a run was
 * created; 404 covers an unknown or disabled endpoint and a wrong secret alike.
 * Limits: rate and size limits exist but no numbers are published; one attempt a minute is used.
 * Host: the page shows only `https://your-town-url/…`; see `W.addresses.town`.
 * The idempotency key makes a retry after a lost response safe.
 */
export const adapter: Adapter = {
  kind: "town",
  policy: {
    ...W.addresses.town,
    minIntervalMs: 60_000,
    maxAttempts: 5,
    retryOnTimeout: true,
  },
  checkToken: (token) =>
    token.startsWith("whsec_")
      ? null
      : "A Town webhook secret starts with whsec_. Copy it from the routine's Webhook card.",
  request: (delivery) =>
    Effect.succeed({
      policy: adapter.policy,
      url: delivery.url,
      headers: {
        authorization: `Bearer ${delivery.secret}`,
        "content-type": "application/json",
        "x-town-idempotency-key": delivery.attemptId,
      },
      body: JSON.stringify({
        data: { source: "talkto", text: Policy.sentence(delivery.notice), ...delivery.notice },
      }),
    }),
};
