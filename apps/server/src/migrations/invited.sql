-- Invited agents (docs/agent-invites.md, November 25, 2026). An additive extension, not a numbered
-- migration: it is created if absent on every upgrade and leaves schema_migrations at its current
-- version, so a rolled-back Worker still opens the server and simply ignores this table.
--
-- One row per admitted agent. `id` is the invited principal's (`invited:<id>`), also its grant's ID.
-- `key_hash` is the SHA-256 of the agent's whole key, hex; the key itself is never stored, and
-- picking the key up again replaces it. Each key is bound to exactly one participant: the server
-- refuses an invited principal everything once that participant is removed. `lineage` is the JSON
-- of agent-invites' Lineage, with participant IDs and the names they had when the agent joined.
CREATE TABLE IF NOT EXISTS invited_agents (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  participant_id TEXT NOT NULL UNIQUE REFERENCES participants(id),
  key_hash TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64),
  lineage TEXT NOT NULL,
  admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0)
) STRICT, WITHOUT ROWID;
