-- Personal API keys (docs/dashboard-api.md, "API keys"). Additive only: older Workers never read
-- this table. A key acts as the WorkOS user who made it; it is never an identity of its own.
-- `secret_hash` is the SHA-256 of the whole secret, hex; the secret itself is never stored.
-- `prefix` is the secret's first 11 characters ("tk_" and 8), shown so a person can recognise a key.
-- `access` is 'read' or 'full'. `account_id` limits the key to one organization, or is NULL for all.
-- Times are epoch milliseconds. `last_used_at` is written at most once every 5 minutes per key.
-- Numbered 0028: production has 0024-0025, the public copy 0025-0026, the swarm board 0027.
CREATE TABLE api_keys (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 name TEXT NOT NULL,
 prefix TEXT NOT NULL,
 secret_hash TEXT NOT NULL,
 access TEXT NOT NULL CHECK (access IN ('read', 'full')),
 account_id TEXT,
 created_at INTEGER NOT NULL,
 last_used_at INTEGER,
 expires_at INTEGER,
 revoked_at INTEGER
) STRICT;
CREATE UNIQUE INDEX api_keys_secret ON api_keys(secret_hash);
CREATE INDEX api_keys_user ON api_keys(user_id, created_at) WHERE revoked_at IS NULL;
