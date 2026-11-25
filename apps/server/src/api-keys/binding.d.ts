// `wrangler types` reads the default wrangler.jsonc, which does not declare it: each deployment
// may set it. Optional.
interface Env {
  /**
   * How many seconds a checked API key is reused per isolate (0–300, default 30). A revoked key
   * can keep working this long on other isolates; 0 reads D1 on every request that uses a key.
   */
  readonly TALKTO_API_KEY_CACHE_SECONDS?: string;
  /**
   * 32 random bytes, base64 or base64url. Tags new API keys so a made-up key is refused without a
   * D1 read. Rotating it, or setting it where keys already exist, ends every existing key.
   */
  readonly TALKTO_API_KEY_SECRET?: string;
}
