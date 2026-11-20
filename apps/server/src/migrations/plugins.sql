-- Plugin reports (November 16, 2026). An additive extension like renames.sql: created if absent on
-- every upgrade, leaving schema_migrations at its current version, so a rolled-back Worker still
-- opens the server and simply ignores this table. Fold it into the next numbered migration with the
-- same IF NOT EXISTS form.
--
-- One row per agent: the TalkTo plugin its sessions last reported (`claude-code`, `hooks`, …) and
-- its version, from the `plugin` field of get_updates or the `TalkTo-Plugin` header of a signal
-- link check. The row is rewritten only when the plugin or version changes, or at most once a day
-- to refresh seen_at, so polling plugins write almost nothing. It holds no message content and no
-- personal data.
CREATE TABLE IF NOT EXISTS participant_plugins (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id),
  plugin TEXT NOT NULL CHECK (length(plugin) BETWEEN 1 AND 32 AND plugin NOT GLOB '*[^a-z0-9-]*'),
  version TEXT NOT NULL CHECK (length(version) BETWEEN 5 AND 14 AND version NOT GLOB '*[^0-9.]*'),
  seen_at INTEGER NOT NULL CHECK (seen_at >= 0)
) STRICT;
