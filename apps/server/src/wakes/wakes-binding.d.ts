// `wrangler types` reads the default wrangler.jsonc, which declares no wake key: it is a Worker
// secret set per deployment. Without it no wake is offered at all; with it, ChatGPT can subscribe.
// Stored third-party tokens additionally need TALKTO_WAKE_TOKENS=on, so a deployment can offer
// subscriptions without ever holding a pasted token.
interface Env {
  /** 32 random bytes, base64 or base64url. Encrypts every stored wake secret with AES-GCM. */
  readonly TALKTO_WAKE_KEY?: string;
  /**
   * `on` lets a person add Claude Code routine, Grok Bot and Town wakes on the TalkTo dashboard.
   * Anything else refuses them. No MCP tool ever accepts these tokens.
   */
  readonly TALKTO_WAKE_TOKENS?: string;
}
