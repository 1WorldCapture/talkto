import { Effect } from "effect";
import * as W from "@talkto/api/wake";
import type { Adapter } from "./kind.js";
import * as Policy from "./policy.js";

/**
 * Claude Code routines, API trigger.
 * Request: https://platform.claude.com/docs/en/api/claude-code/routines-fire —
 * `POST https://api.anthropic.com/v1/claude_code/routines/trig_…/fire`, `Authorization: Bearer
 * sk-ant-oat01-…`, `anthropic-version`, optional `{"text": …}` (at most 65,536 characters). There is
 * no idempotency key, so a lost response is never retried.
 * Limits: https://code.claude.com/docs/en/routines — 30 fires an hour per routine (shared with Run
 * now) and 100 API fires an hour per account. One attempt every 2 minutes stays at 30 an hour.
 * The routine sees the text inside a `<routine-fire-payload>` block marked untrusted; its saved
 * prompt must say to call get_updates when it sees a TalkTo wake.
 */
export const adapter: Adapter = {
  kind: "claude_routine",
  policy: {
    ...W.addresses.claude_routine,
    minIntervalMs: 120_000,
    maxAttempts: 4,
    retryOnTimeout: false,
  },
  checkToken: (token) =>
    token.startsWith("sk-ant-oat01-")
      ? null
      : "A routine token starts with sk-ant-oat01-. Generate one under the routine's API trigger; an API key does not work.",
  request: (delivery) =>
    Effect.succeed({
      policy: adapter.policy,
      url: delivery.url,
      headers: {
        authorization: `Bearer ${delivery.secret}`,
        "anthropic-version": "2023-06-01",
        // The fire reference accepts requests with or without it; the routines guide sends it.
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: Policy.sentence(delivery.notice) }),
    }),
};
