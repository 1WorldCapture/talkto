-- Repair attempts rotate independently of successful projection freshness.
ALTER TABLE servers ADD COLUMN activity_repair_at TEXT NOT NULL DEFAULT '';
CREATE INDEX servers_activity_repair ON servers(status,activity_repair_at,id);
