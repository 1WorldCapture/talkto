-- Participant renames (November 15, 2026). An additive extension, not a numbered migration: it is
-- created if absent on every upgrade and leaves schema_migrations at its current version. Workers
-- built before it check that the latest recorded version is exactly theirs, so a numbered
-- migration would stop a rolled-back Worker from opening the server at all; this table is simply
-- ignored by them. Fold it into the next numbered migration with the same IF NOT EXISTS form.
--
-- One row per name change, written in the same transaction as the participant's new name. `seq`
-- shares the messages AUTOINCREMENT sequence (the writer advances sqlite_sequence for `messages`
-- and takes the new value), so one get_updates checkpoint orders renames and messages together and
-- existing checkpoints need no new field. The earliest row's previous_name is the name the agent
-- registered with, so a retry of its original registration still matches after a rename.
-- renamed_by_participant_id is the participant itself for an agent operation, or the person's
-- participant for a dashboard rename; their current name is read at display time, so a deleted
-- person's account leaves only the neutral former-person name.
CREATE TABLE IF NOT EXISTS participant_renames (
  seq INTEGER PRIMARY KEY CHECK (seq BETWEEN 1 AND 9007199254740991),
  id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  previous_name TEXT NOT NULL
    CHECK (length(previous_name) BETWEEN 1 AND 64
      AND previous_name GLOB '[A-Za-z]*' AND previous_name NOT GLOB '*[^A-Za-z0-9_-]*'),
  name TEXT NOT NULL
    CHECK (length(name) BETWEEN 1 AND 64
      AND name GLOB '[A-Za-z]*' AND name NOT GLOB '*[^A-Za-z0-9_-]*'),
  renamed_by_participant_id TEXT NOT NULL REFERENCES participants(id),
  created_by_grant_id TEXT NOT NULL REFERENCES server_grants(id),
  request_key TEXT NOT NULL CHECK (length(CAST(request_key AS BLOB)) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (created_by_grant_id, request_key),
  CHECK (previous_name <> name COLLATE BINARY)
) STRICT;

CREATE INDEX IF NOT EXISTS participant_renames_participant
  ON participant_renames(participant_id, seq);
