-- Bound the derived activity index (KEY_DECISIONS.md, November 16). The minute cron now deletes
-- references older than 30 days, so each server's export progress records its newest indexed
-- message time, which outlives the references. Account search orders servers by it.
-- Older Workers name their columns and keep working; they leave this column unchanged.
ALTER TABLE activity_progress ADD COLUMN last_message_at TEXT;
-- One indexed lookup per server through UNIQUE(server_id,sequence): the newest reference's time.
UPDATE activity_progress SET last_message_at=(SELECT e.created_at FROM activity_events e
 WHERE e.server_id=activity_progress.server_id ORDER BY e.sequence DESC LIMIT 1);
-- Only account search's per-server MAX(id) used this index. Server erasure walks
-- UNIQUE(server_id,sequence); Home and the feed use the account indexes.
DROP INDEX activity_server_delivery;
