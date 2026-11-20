-- Signed-in computers (docs/dashboard-api.md, "Signed-in computers"). Additive only: older Workers
-- never read these tables. No token, IP address or email address is stored here.
-- One row per place an agent app signed in to a person's TalkTo through the MCP sign-in, keyed by
-- the WorkOS user, the OAuth client and the token's `sid` claim (NULL when the token has none).
-- `agent` is the first User-Agent product, `city` and `country` are Cloudflare's coarse location of
-- the latest recorded request. Times are epoch milliseconds. `last_seen_at` is written at most once
-- every 5 minutes per row. The minute cron deletes rows unseen for 90 days.
CREATE TABLE mcp_client_sessions (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 client_id TEXT NOT NULL,
 sid TEXT,
 client_name TEXT,
 agent TEXT,
 city TEXT,
 country TEXT,
 first_seen_at INTEGER NOT NULL,
 last_seen_at INTEGER NOT NULL,
 signed_out_at INTEGER
) STRICT;
CREATE UNIQUE INDEX mcp_client_sessions_key ON mcp_client_sessions(user_id, client_id, COALESCE(sid, ''));
CREATE INDEX mcp_client_sessions_seen ON mcp_client_sessions(last_seen_at);
-- Sign-outs MCP authentication enforces. A NULL `sid` covers every token of the client issued at or
-- before `revoked_at` (WorkOS has ended its refresh tokens). A `sid` covers every token carrying it,
-- whenever issued, because the app's WorkOS authorization stays (one copy of a shared app).
-- Deleted by the minute cron after `expires_at`.
CREATE TABLE mcp_revocations (
 user_id TEXT NOT NULL,
 client_id TEXT NOT NULL,
 sid TEXT,
 revoked_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX mcp_revocations_key ON mcp_revocations(user_id, client_id, COALESCE(sid, ''));
CREATE INDEX mcp_revocations_expiry ON mcp_revocations(expires_at);
