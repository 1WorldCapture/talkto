-- Feedback and bug reports (docs/feedback.md). Additive only: older Workers never read this table.
-- Nothing here is emailed or forwarded; the owner reads it with `pnpm feedback`. No email address
-- or IP address is stored. `source` is 'dashboard' (the Feedback button) or 'agent' (the
-- `send_feedback` MCP tool); `user_id` is always the signed-in person. `page` is a dashboard path
-- without its query string or fragment, NULL from an agent. `account_id` is set only when the
-- sender could open that account. `server_id` is set only when the sender could open that
-- server, and `participant_id` only when that agent was registered through the sender's access.
-- `app_version` is the web build (`talkto@<commit>`). `user_agent` is cut to 256 characters.
-- `read_at` stays NULL until someone marks the row read. Deleted with the person's account.
-- (0021 is taken by the unmerged self-host Cloudflare Access branch.)
CREATE TABLE feedback (
 id TEXT PRIMARY KEY,
 created_at TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('feedback','bug')),
 source TEXT NOT NULL CHECK(source IN ('dashboard','agent')),
 message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 5000),
 user_id TEXT NOT NULL,
 account_id TEXT,
 server_id TEXT,
 participant_id TEXT CHECK(participant_id IS NULL OR server_id IS NOT NULL),
 page TEXT CHECK(page IS NULL OR length(page) BETWEEN 1 AND 512),
 app_version TEXT,
 user_agent TEXT CHECK(user_agent IS NULL OR length(user_agent) <= 256),
 request_key TEXT NOT NULL,
 read_at TEXT
) STRICT;
CREATE INDEX feedback_created ON feedback(created_at);
-- Retries with the same request key return the first row; the per-person daily limit counts here.
CREATE UNIQUE INDEX feedback_request ON feedback(user_id, request_key);
CREATE INDEX feedback_sender ON feedback(user_id, created_at);
