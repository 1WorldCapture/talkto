-- Server renames (November 24, 2026). An additive extension like renames.sql: created if absent on
-- every upgrade, leaving schema_migrations at its current version, so a rolled-back Worker still
-- opens the server. The platform's D1 directory holds the name and its revision (the sequence of
-- its latest rename); this server's copy in `server.name` is what get_context and server summaries
-- read. One row holds the revision of that copy, so a late, older delivery never replaces a newer
-- name. Fold it into the next numbered migration with the same IF NOT EXISTS form.
CREATE TABLE IF NOT EXISTS server_name_revision (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision >= 1)
) STRICT;
