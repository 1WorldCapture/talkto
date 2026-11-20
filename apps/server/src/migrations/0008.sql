-- Signal links: one content-free capability per participant, for its host's hook scripts.
-- Only the SHA-256 of the link's secret is stored. Calling create_signal again replaces the row
-- (rotation); revoke_signal deletes it. The selection is frozen like a get_updates checkpoint,
-- and boundary is the message sequence the link started counting after.
CREATE TABLE participant_signals (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  participant_id TEXT NOT NULL UNIQUE REFERENCES participants(id),
  grant_id TEXT NOT NULL REFERENCES server_grants(id),
  secret_hash TEXT NOT NULL CHECK (length(secret_hash) = 64),
  channel_ids TEXT NOT NULL CHECK (json_valid(channel_ids) AND json_type(channel_ids) = 'array'),
  direct_chats TEXT NOT NULL CHECK (direct_chats IN ('own', 'none')),
  generation TEXT NOT NULL CHECK (length(generation) = 32),
  boundary INTEGER NOT NULL CHECK (boundary >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX participant_signals_expiry ON participant_signals(expires_at);
