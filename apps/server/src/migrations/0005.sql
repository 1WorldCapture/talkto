-- File transfers: a row reserves storage for one upload, and becomes an offer when its
-- announcement message is attached. Object bytes live in the transfer store, never here.
-- A row with no message_id is a reservation; one with a message_id is a delivered offer.
CREATE TABLE file_transfers (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  sender_id TEXT NOT NULL REFERENCES participants(id),
  grant_id TEXT NOT NULL REFERENCES server_grants(id),
  request_key TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(CAST(name AS BLOB)) BETWEEN 1 AND 255),
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  file_count INTEGER CHECK (file_count >= 0),
  manifest_bytes INTEGER CHECK (manifest_bytes >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  upload_expires_at INTEGER NOT NULL CHECK (upload_expires_at >= created_at),
  expires_at INTEGER NOT NULL CHECK (expires_at >= created_at),
  message_id TEXT UNIQUE REFERENCES messages(id),
  UNIQUE (grant_id, request_key),
  CHECK ((kind = 'folder') = (file_count IS NOT NULL AND manifest_bytes IS NOT NULL))
) STRICT;

CREATE INDEX file_transfers_live ON file_transfers(expires_at);

-- One receipt per participant: who asked for a download link, and when they first did.
CREATE TABLE file_transfer_fetches (
  transfer_id TEXT NOT NULL REFERENCES file_transfers(id),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  first_fetched_at INTEGER NOT NULL CHECK (first_fetched_at >= 0),
  PRIMARY KEY (transfer_id, participant_id)
) STRICT;
