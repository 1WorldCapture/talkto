-- Wakes: content-free notices to a participant's cloud agent while it is not running.
-- One row per target. `sealed` is the AES-GCM ciphertext of the host token or the subscriber's
-- signing secret; the key is a Worker secret and never reaches this database. `hint` keeps the
-- last 4 characters for display. `identity` deduplicates: an MCP events subscription is keyed by
-- principal, callback URL, event name and arguments; a pasted target by participant and kind.
-- `delivered_through` is the message sequence the last wake already announced; `due_at` is set
-- by a message commit and cleared by delivery, so many messages share one wake.
CREATE TABLE wake_targets (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  identity TEXT NOT NULL UNIQUE CHECK (length(identity) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('mcp_events', 'claude_routine', 'grok_bot', 'town')),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  grant_id TEXT NOT NULL REFERENCES server_grants(id),
  url TEXT NOT NULL CHECK (url LIKE 'https://%' AND length(url) <= 2048),
  sealed TEXT NOT NULL CHECK (sealed LIKE 'v1.%'),
  hint TEXT NOT NULL CHECK (length(hint) <= 4),
  channel_ids TEXT NOT NULL CHECK (json_valid(channel_ids) AND json_type(channel_ids) = 'array'),
  direct_chats TEXT NOT NULL CHECK (direct_chats IN ('own', 'none')),
  generation TEXT NOT NULL CHECK (length(generation) = 32),
  delivered_through INTEGER NOT NULL CHECK (delivered_through >= 0),
  min_interval_ms INTEGER NOT NULL CHECK (min_interval_ms > 0),
  due_at INTEGER CHECK (due_at >= 0),
  attempt_id TEXT CHECK (length(attempt_id) BETWEEN 1 AND 64),
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  last_attempt_at INTEGER CHECK (last_attempt_at >= 0),
  last_sent_at INTEGER CHECK (last_sent_at >= 0),
  last_error TEXT CHECK (length(last_error) <= 64),
  disabled_at INTEGER CHECK (disabled_at >= 0),
  disabled_reason TEXT CHECK (length(disabled_reason) <= 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX wake_targets_participant ON wake_targets(participant_id);
CREATE INDEX wake_targets_due ON wake_targets(due_at) WHERE due_at IS NOT NULL;

-- Outbound calls per participant per hour, retries included, for the wake budget.
CREATE TABLE wake_sends (
  participant_id TEXT NOT NULL REFERENCES participants(id),
  hour INTEGER NOT NULL CHECK (hour >= 0),
  sent INTEGER NOT NULL CHECK (sent > 0),
  PRIMARY KEY (participant_id, hour)
) STRICT, WITHOUT ROWID;
