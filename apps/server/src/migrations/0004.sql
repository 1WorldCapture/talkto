-- Server files: one Git remote per server, a ledger of minted tokens, and file
-- references beside immutable messages. Messages stay immutable; a share is a
-- sibling row inserted in the same transaction as its message.
CREATE TABLE file_repository (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  remote TEXT NOT NULL CHECK (length(CAST(remote AS BLOB)) BETWEEN 1 AND 2048),
  default_branch TEXT NOT NULL CHECK (length(CAST(default_branch AS BLOB)) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

-- token_id is the store's identifier used for revocation; plaintext tokens are never stored.
-- expires_at is NULL only where the remote itself is the access (local deployments).
CREATE TABLE file_tokens (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  token_id TEXT NOT NULL CHECK (length(CAST(token_id AS BLOB)) BETWEEN 1 AND 512),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  grant_id TEXT NOT NULL REFERENCES server_grants(id),
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  expires_at INTEGER CHECK (expires_at >= issued_at),
  revoked_at INTEGER CHECK (revoked_at >= issued_at)
) STRICT;

CREATE INDEX file_tokens_live_grant ON file_tokens(grant_id) WHERE revoked_at IS NULL;

-- seq mirrors messages.seq so the newest-first share listing walks an index of shares only.
CREATE TABLE message_shares (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  seq INTEGER NOT NULL UNIQUE REFERENCES messages(seq),
  path TEXT NOT NULL CHECK (length(CAST(path AS BLOB)) BETWEEN 1 AND 1024 AND instr(path, char(0)) = 0),
  commit_hash TEXT NOT NULL CHECK (length(commit_hash) = 40),
  ref TEXT NOT NULL CHECK (length(CAST(ref AS BLOB)) BETWEEN 1 AND 256),
  bytes INTEGER CHECK (bytes >= 0)
) STRICT;

CREATE INDEX message_shares_path ON message_shares(path);
