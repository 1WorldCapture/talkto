-- Retain admission/idempotency history while permanently removing server content.
ALTER TABLE servers ADD COLUMN deletion_requested_at TEXT;
ALTER TABLE servers ADD COLUMN deletion_completed_at TEXT;
CREATE INDEX servers_pending_deletion ON servers(deletion_completed_at,deletion_requested_at);
