// `wrangler types` reads the default wrangler.jsonc, which declares neither binding: they exist only
// where a deployment configures them (staging first). Both are optional and probed at composition.
interface Env {
  /** Workers Analytics Engine dataset that receives one data point per read or poll. */
  readonly READ_EVENTS?: AnalyticsEngineDataset;
  /** Workers rate-limit binding keyed by organization; the backstop limit is set in its config. */
  readonly ORGANIZATION_READS?: RateLimit;
  readonly TALKTO_READ_LIMITS?: string;
  readonly TALKTO_PARTICIPANT_READS_PER_MINUTE?: string;
  readonly TALKTO_STORAGE_UNPAID_BYTES?: string;
}
