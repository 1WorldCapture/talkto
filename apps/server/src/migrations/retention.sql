-- History retention (November 16, 2026). An additive extension like renames.sql: applied on every
-- upgrade, leaving schema_migrations at its current version, so a rolled-back Worker still opens
-- the server. Fold it into the next numbered migration with the same IF NOT EXISTS form.
--
-- Messages stay immutable: no UPDATE is ever allowed. The only DELETE allowed is the retention
-- prune, which first raises history_retention.deletable_through to the newest sequence it removes,
-- in the same transaction. Any other DELETE still aborts with message_immutable, as before. A
-- rolled-back Worker never deletes messages, so the guarded trigger changes nothing for it; it
-- only finds fewer old messages, which every reader already treats as the start of history.
--
-- One row: the window this server last applied and where its stored history now begins.
-- deletable_through: the highest sequence the prune may remove (the guard above).
-- pruned_through_seq / pruned_through_at: the newest message removed so far, by sequence and by
-- creation time; NULL until the first removal. Readers report history before that time as gone.
-- plan / days / archived: the window applied at the last removal, as readers describe it.
CREATE TABLE IF NOT EXISTS history_retention (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  deletable_through INTEGER NOT NULL DEFAULT 0 CHECK (deletable_through >= 0),
  pruned_through_seq INTEGER CHECK (pruned_through_seq >= 1),
  pruned_through_at INTEGER CHECK (pruned_through_at >= 0),
  plan TEXT CHECK (plan IN ('free', 'shop', 'studio', 'factory')),
  days INTEGER CHECK (days >= 1),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  removed INTEGER NOT NULL DEFAULT 0 CHECK (removed >= 0)
) STRICT;

INSERT OR IGNORE INTO history_retention(singleton) VALUES (1);

-- Replace the unconditional delete guard with the retention guard. DROP is a no-op after the first
-- upgrade; CREATE IF NOT EXISTS keeps later upgrades from touching the trigger again.
DROP TRIGGER IF EXISTS messages_immutable_delete;
CREATE TRIGGER IF NOT EXISTS messages_retention_delete BEFORE DELETE ON messages
WHEN OLD.seq > (SELECT deletable_through FROM history_retention WHERE singleton = 1)
BEGIN
  SELECT RAISE(ABORT, 'message_immutable');
END;

-- Keep search consistent: an external-content FTS5 index must be told the removed row's text.
CREATE TRIGGER IF NOT EXISTS messages_retention_search AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', OLD.seq, OLD.body);
END;
