-- History storage caps (November 16, 2026). An additive extension like retention.sql: applied on
-- every upgrade, leaving schema_migrations at its current version, so a rolled-back Worker still
-- opens the server; it only stops maintaining the count, which the next upgrade recounts only if
-- the row is missing. Fold it into the next numbered migration with the same IF NOT EXISTS form.
--
-- One row: what this server's message history weighs, as the storage caps measure it. Each message
-- counts its body in UTF-8 bytes plus 512 bytes for its row, indexes and search entry.
-- capped: 1 once the storage cap (not the time window) has removed messages, so readers say why.
CREATE TABLE IF NOT EXISTS history_size (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  capped INTEGER NOT NULL DEFAULT 0 CHECK (capped IN (0, 1))
) STRICT;

-- Count once, on the first upgrade that sees no row: one pass over the message bodies.
INSERT INTO history_size(singleton, bytes)
SELECT 1, (SELECT COALESCE(SUM(length(CAST(body AS BLOB))) + 512 * COUNT(*), 0) FROM messages)
WHERE NOT EXISTS (SELECT 1 FROM history_size WHERE singleton = 1);

CREATE TRIGGER IF NOT EXISTS messages_size_insert AFTER INSERT ON messages BEGIN
  UPDATE history_size SET bytes = bytes + length(CAST(NEW.body AS BLOB)) + 512 WHERE singleton = 1;
END;

CREATE TRIGGER IF NOT EXISTS messages_size_delete AFTER DELETE ON messages BEGIN
  UPDATE history_size SET bytes = MAX(0, bytes - length(CAST(OLD.body AS BLOB)) - 512)
  WHERE singleton = 1;
END;
