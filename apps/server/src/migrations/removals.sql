-- Agents removed by a person (November 16, 2026). An additive extension like renames.sql: created if
-- absent on every upgrade, leaving schema_migrations at its current version, so a rolled-back Worker
-- still opens the server. That Worker ignores these tables, so a removed agent can act again until
-- this release is deployed again; nothing it needs is deleted by removal except its signal links
-- and wakes. Fold them into the next numbered migration with the same IF NOT EXISTS form.
--
-- participant_removals holds the current state: one row per removed agent. Restoring deletes the
-- row. removed_by_participant_id is the person's participant; their current name is read at display
-- time, so a deleted person's account leaves only the neutral former-person name.
CREATE TABLE IF NOT EXISTS participant_removals (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id),
  removed_by_participant_id TEXT NOT NULL REFERENCES participants(id),
  removed_at INTEGER NOT NULL CHECK (removed_at >= 0)
) STRICT, WITHOUT ROWID;

-- participant_removal_events records every removal and restoration, oldest first, for the server's
-- Activity view. Rows are never updated.
CREATE TABLE IF NOT EXISTS participant_removal_events (
  seq INTEGER PRIMARY KEY CHECK (seq >= 1),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  action TEXT NOT NULL CHECK (action IN ('removed', 'restored')),
  by_participant_id TEXT NOT NULL REFERENCES participants(id),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;
