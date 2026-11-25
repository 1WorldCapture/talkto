-- Results of finished tasks: files and links (docs/swarm-task-results-scope.md). An additive
-- extension like task-holders.sql: created if absent on every upgrade, leaving schema_migrations
-- at its current version, so a rolled-back Worker still opens the server and ignores these tables.
-- No foreign key to tasks or file_transfers: history pruning removes those rows on its own
-- schedule, and a rolled-back Worker prunes without knowing these tables exist. Fold them into the
-- next numbered migration with the same IF NOT EXISTS form.

-- One row per attempt a claimer completed or failed. epoch is the claim's epoch, which the task's
-- completed or failed event also carries, so each event reads its own attempt's result.
CREATE TABLE IF NOT EXISTS task_results (
  task_id TEXT NOT NULL CHECK (length(task_id) = 36),
  epoch INTEGER NOT NULL CHECK (epoch >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('completed', 'failed')),
  summary TEXT NOT NULL CHECK (length(CAST(summary AS BLOB)) BETWEEN 1 AND 280),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  -- Typed links as the schema validated them; [] when none. At most 10.
  links TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(links) AND json_type(links) = 'array'
    AND json_array_length(links) <= 10),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (task_id, epoch)
) STRICT, WITHOUT ROWID;

-- The files of one result, in the order given. A copy of each offer, so the task still names the
-- file after file_transfers loses its row.
CREATE TABLE IF NOT EXISTS task_result_files (
  task_id TEXT NOT NULL CHECK (length(task_id) = 36),
  epoch INTEGER NOT NULL CHECK (epoch >= 1),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 7),
  transfer_id TEXT NOT NULL CHECK (length(transfer_id) = 36),
  name TEXT NOT NULL CHECK (length(CAST(name AS BLOB)) BETWEEN 1 AND 255),
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  file_count INTEGER CHECK (file_count >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  message_id TEXT NOT NULL CHECK (length(message_id) = 36),
  PRIMARY KEY (task_id, epoch, position),
  UNIQUE (task_id, epoch, transfer_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS task_result_files_transfer ON task_result_files(transfer_id);

-- A task's results go with it, whichever Worker prunes it: the trigger lives in the database, so
-- a rolled-back Worker's removeTasks cleans these rows too and leaves no orphans.
CREATE TRIGGER IF NOT EXISTS task_results_cleanup AFTER DELETE ON tasks BEGIN
  DELETE FROM task_result_files WHERE task_id = OLD.id;
  DELETE FROM task_results WHERE task_id = OLD.id;
END;

-- History size (history-size.sql): 128 bytes a result plus its summary and links; 256 bytes a file.
CREATE TRIGGER IF NOT EXISTS task_results_size_insert AFTER INSERT ON task_results BEGIN
  UPDATE history_size SET bytes = bytes + 128 + length(CAST(NEW.summary AS BLOB))
    + length(CAST(NEW.links AS BLOB)) WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS task_results_size_delete AFTER DELETE ON task_results BEGIN
  UPDATE history_size SET bytes = MAX(0, bytes - 128 - length(CAST(OLD.summary AS BLOB))
    - length(CAST(OLD.links AS BLOB))) WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS task_result_files_size_insert AFTER INSERT ON task_result_files BEGIN
  UPDATE history_size SET bytes = bytes + 256 WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS task_result_files_size_delete AFTER DELETE ON task_result_files BEGIN
  UPDATE history_size SET bytes = MAX(0, bytes - 256) WHERE singleton = 1;
END;
