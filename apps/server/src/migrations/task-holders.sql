-- Who worked on each task (November 24, 2026). An additive extension like board.sql: created if
-- absent on every upgrade, leaving schema_migrations at its current version, so a rolled-back Worker
-- still opens the server and ignores these tables. It is a file of its own because board.sql's
-- CREATE TABLE IF NOT EXISTS statements never change a table that exists: a server object that
-- already ran board.sql (staging) would not see a new column there, but gains these tables on its
-- next upgrade. Fold them into the next numbered migration with the same IF NOT EXISTS form.
--
-- tasks.claimer_id is cleared when a claim ends, and history pruning may remove task events, so
-- the Board's finished rows read who worked on a task here. Neither table has a foreign key to
-- tasks: history pruning removes these rows with their task (history/prune.ts), and a rolled-back
-- Worker that prunes without them leaves only rows that no new task ID matches.

-- Each agent that ever claimed the task, once, with its first and latest claim. Kept when the task
-- is released, its lease runs out, or it is reopened. At most 16 agents per task are recorded.
CREATE TABLE IF NOT EXISTS task_holders (
  task_id TEXT NOT NULL CHECK (length(task_id) = 36),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  first_claimed_at INTEGER NOT NULL CHECK (first_claimed_at >= 0),
  last_claimed_at INTEGER NOT NULL CHECK (last_claimed_at >= first_claimed_at),
  PRIMARY KEY (task_id, participant_id)
) STRICT, WITHOUT ROWID;
-- The Board's agent filter: tasks an agent worked on.
CREATE INDEX IF NOT EXISTS task_holders_participant ON task_holders(participant_id, task_id);

-- The agent that finished the task: the claimer that completed or failed it, or the owner agent
-- that canceled it. No row while the task is unfinished, or when a person, a cancel through its
-- needs, or running out of attempts ended it. A reopen removes the row; the next finisher writes it.
CREATE TABLE IF NOT EXISTS task_finishers (
  task_id TEXT PRIMARY KEY CHECK (length(task_id) = 36),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  finished_at INTEGER NOT NULL CHECK (finished_at >= 0)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS task_finishers_participant ON task_finishers(participant_id, task_id);

-- Claims held when this extension first runs: their holders. Later runs find them recorded.
INSERT OR IGNORE INTO task_holders(task_id, participant_id, first_claimed_at, last_claimed_at)
SELECT id, claimer_id, claimed_at, claimed_at FROM tasks WHERE state = 'claimed';
