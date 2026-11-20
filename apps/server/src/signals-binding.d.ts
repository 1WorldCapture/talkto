// `wrangler types` reads the default wrangler.jsonc, which declares neither: the key is a Worker
// secret and the rate limit a binding that each deployment configures. Both are optional.
interface Env {
  /**
   * 32 random bytes, base64 or base64url. Tags new signal links so the Worker admits a check
   * without reading D1; without it every check takes the cached server existence check.
   */
  readonly TALKTO_SIGNAL_KEY?: string;
  /** Workers rate-limit binding keyed by network; counts failed signal checks only. */
  readonly SIGNAL_FAILURES?: RateLimit;
}
