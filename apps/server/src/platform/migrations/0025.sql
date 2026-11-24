-- Renaming organizations and servers (November 24, 2026, docs/dashboard-api.md, "Renaming
-- organizations and servers"). Additive only: older Workers never read this table, and the names
-- they read stay in accounts.name and servers.name.
--
-- One row per name change, written in the same batch as the new name. `kind` is 'organization'
-- (target_id is the account ID) or 'server' (target_id is the server ID). `seq` orders a target's
-- renames; its latest value is the name's revision, which the server object and the WorkOS mirror
-- compare so an older name never replaces a newer one. `applied_at` is set once the mirror
-- confirmed that revision: WorkOS's organization name, or the server object's copy that agents read
-- in get_context. The minute cron retries unconfirmed rows. The earliest row's previous_name is the
-- name the target was created with, so a retry of the original create request still matches after
-- a rename. Keys are per person and target; renamed_by becomes NULL when that person deletes their
-- account. A deleted server or organization loses its rows with its name.
CREATE TABLE directory_renames (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE CHECK(length(id) = 36),
 kind TEXT NOT NULL CHECK(kind IN ('organization','server')),
 target_id TEXT NOT NULL,
 previous_name TEXT NOT NULL CHECK(length(CAST(previous_name AS BLOB)) BETWEEN 1 AND 100),
 name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 100),
 renamed_by TEXT,
 request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 renamed_at TEXT NOT NULL,
 applied_at TEXT,
 UNIQUE(kind, target_id, renamed_by, request_key),
 CHECK(previous_name <> name)
) STRICT;
CREATE INDEX directory_renames_target ON directory_renames(kind, target_id, seq);
CREATE INDEX directory_renames_pending ON directory_renames(kind, target_id) WHERE applied_at IS NULL;
CREATE INDEX directory_renames_person ON directory_renames(renamed_by) WHERE renamed_by IS NOT NULL;
