-- The task board of a swarm server (spec: docs/swarm-server-spec.md). An additive extension like
-- renames.sql: created if absent on every upgrade, leaving schema_migrations at its current
-- version, so a rolled-back Worker still opens the server and ignores these tables. Fold them into
-- the next numbered migration with the same IF NOT EXISTS form.

-- One row once the board was first switched on; no row means it never was. `enabled` is the
-- authority for every task operation (D1's servers.board is a copy for the server list).
-- channel_id: the board channel that holds every task's thread. A server created as a swarm
-- server has no participant or grant yet, and every channel but General needs a creator, so the
-- channel is created by the first create_tasks call (or the person switching the board on); NULL
-- until then. next_number: the next task's short number (T-1, T-2, ...). claim_cap: most tasks
-- claimed at once on this server; NULL is no cap.
CREATE TABLE IF NOT EXISTS board_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  channel_id TEXT UNIQUE REFERENCES conversations(id),
  next_number INTEGER NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  claim_cap INTEGER CHECK (claim_cap BETWEEN 1 AND 100),
  changed_by_participant_id TEXT REFERENCES participants(id),
  changed_at INTEGER NOT NULL CHECK (changed_at >= 0)
) STRICT;

-- One row per create_tasks call (or one person's New task). It holds the request key, so a retry
-- returns the same tasks, and it counts open tasks so the owner gets one summary when all finish.
CREATE TABLE IF NOT EXISTS task_batches (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  owner_participant_id TEXT NOT NULL REFERENCES participants(id),
  created_by_grant_id TEXT NOT NULL REFERENCES server_grants(id),
  request_key TEXT NOT NULL CHECK (length(CAST(request_key AS BLOB)) BETWEEN 1 AND 128),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  task_count INTEGER NOT NULL CHECK (task_count BETWEEN 1 AND 25),
  open_count INTEGER NOT NULL CHECK (open_count BETWEEN 0 AND task_count),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  finished_at INTEGER CHECK (finished_at >= created_at),
  UNIQUE (created_by_grant_id, request_key),
  CHECK ((open_count = 0) = (finished_at IS NOT NULL))
) STRICT;

-- The current state of each task. Rows are updated in place; task_events keeps the history. A
-- failed task can be reopened (by its owner agent or a person); the tasks canceled because it
-- failed then return to waiting. Reopening clears the outcome and the attempts.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  number INTEGER NOT NULL UNIQUE CHECK (number >= 1),
  batch_id TEXT NOT NULL REFERENCES task_batches(id),
  title TEXT NOT NULL
    CHECK (length(CAST(title AS BLOB)) BETWEEN 1 AND 200 AND instr(title, char(10)) = 0),
  brief_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  state TEXT NOT NULL
    CHECK (state IN ('waiting', 'ready', 'claimed', 'blocked', 'completed', 'failed', 'canceled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low')),
  owner_participant_id TEXT NOT NULL REFERENCES participants(id),
  assignee_id TEXT REFERENCES participants(id),
  -- The lease. epoch counts claims and never goes down; token is a fencing token, not a secret
  -- (agents on one server already share read access to everything).
  claimer_id TEXT REFERENCES participants(id),
  lease_token TEXT CHECK (length(lease_token) = 22),
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_seconds INTEGER CHECK (lease_seconds BETWEEN 60 AND 900),
  claimed_at INTEGER CHECK (claimed_at >= 0),
  lease_expires_at INTEGER CHECK (lease_expires_at >= 0),
  -- Expired leases so far; at max_attempts the task fails (reason attempts_exhausted).
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- The holder's last thread note (or the claim, if none since). The Board's Stalled list.
  last_note_at INTEGER CHECK (last_note_at >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  -- A block: what the worker asked and who asked it. Cleared when a person decides.
  block_kind TEXT CHECK (block_kind IN ('needs_input', 'needs_approval')),
  block_message_id TEXT REFERENCES messages(id),
  blocked_by_participant_id TEXT REFERENCES participants(id),
  blocked_at INTEGER CHECK (blocked_at >= 0),
  -- Groups similar asks into one Needs you row (4.4). Optional; cleared with the block.
  block_key TEXT CHECK (length(block_key) BETWEEN 1 AND 64 AND block_key NOT GLOB '*[^a-z0-9._-]*'),
  -- The last person decision, kept after the task moves on: the proof that a person approved.
  decision TEXT CHECK (decision IN ('answered', 'approved', 'declined')),
  decided_by_participant_id TEXT REFERENCES participants(id),
  decided_at INTEGER CHECK (decided_at >= 0),
  -- The end: one line for cards, events and the lead; details are a thread message.
  outcome_summary TEXT CHECK (length(CAST(outcome_summary AS BLOB)) BETWEEN 1 AND 280),
  outcome_reason TEXT CHECK (outcome_reason IN
    ('by_claimer', 'by_person', 'by_owner', 'need_failed', 'attempts_exhausted')),
  outcome_message_id TEXT REFERENCES messages(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  ready_at INTEGER CHECK (ready_at >= created_at),
  finished_at INTEGER CHECK (finished_at >= created_at),
  CHECK ((state = 'claimed') = (claimer_id IS NOT NULL AND lease_token IS NOT NULL
    AND lease_seconds IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state = 'blocked') = (block_kind IS NOT NULL AND blocked_by_participant_id IS NOT NULL
    AND blocked_at IS NOT NULL)),
  CHECK ((state IN ('completed', 'failed', 'canceled')) = (finished_at IS NOT NULL)),
  CHECK (state NOT IN ('completed', 'failed') OR outcome_summary IS NOT NULL)
) STRICT;

-- Claim order: tasks assigned to the claimer, then priority, then oldest ready.
CREATE INDEX IF NOT EXISTS tasks_ready
  ON tasks(assignee_id, priority, ready_at, number) WHERE state = 'ready';
-- The alarm's next lease expiry, and the claim cap's count.
CREATE INDEX IF NOT EXISTS tasks_leases ON tasks(lease_expires_at) WHERE state = 'claimed';
CREATE INDEX IF NOT EXISTS tasks_claimer ON tasks(claimer_id) WHERE state = 'claimed';
-- Counts per state, the Board's task list and read_tasks filters.
CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state, updated_at);
-- The Board's Stalled list: longest silence first.
CREATE INDEX IF NOT EXISTS tasks_silence ON tasks(last_note_at) WHERE state = 'claimed';
-- "Finished in the last hour": completed tasks by finish time.
CREATE INDEX IF NOT EXISTS tasks_finished ON tasks(finished_at) WHERE state = 'completed';
-- Needs you: oldest first, and grouping by key.
CREATE INDEX IF NOT EXISTS tasks_blocked ON tasks(blocked_at) WHERE state = 'blocked';
CREATE INDEX IF NOT EXISTS tasks_block_key ON tasks(block_key, block_kind) WHERE state = 'blocked';
CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner_participant_id, state);
-- History pruning keeps each task's result and question while the task is kept.
CREATE INDEX IF NOT EXISTS tasks_outcome_message ON tasks(outcome_message_id)
  WHERE outcome_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_block_message ON tasks(block_message_id)
  WHERE block_message_id IS NOT NULL;

-- Prerequisites. Needs are fixed at creation, so a cycle can only form inside one batch.
CREATE TABLE IF NOT EXISTS task_needs (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  need_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, need_id),
  CHECK (task_id <> need_id)
) STRICT, WITHOUT ROWID;
-- "Which tasks need this one", walked when a task completes, fails or is canceled.
CREATE INDEX IF NOT EXISTS task_needs_need ON task_needs(need_id, task_id);

-- Labels for routing, such as role=reviewer. The primary key serves "ready tasks with label L".
CREATE TABLE IF NOT EXISTS task_labels (
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 96
    AND label GLOB '[a-z0-9]*' AND label NOT GLOB '*[^a-z0-9._/=-]*'),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (label, task_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS task_labels_task ON task_labels(task_id, label);

-- Every change of a task's state, assignee or priority. `seq` shares the messages AUTOINCREMENT
-- sequence, like participant_renames, so one get_updates checkpoint orders messages, renames and
-- task events together. Rows are never updated. actor_kind 'system' covers lease expiry, needs
-- done, need_failed cascades, removals and attempts_exhausted (see `reason`).
CREATE TABLE IF NOT EXISTS task_events (
  seq INTEGER PRIMARY KEY CHECK (seq BETWEEN 1 AND 9007199254740991),
  id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('created', 'ready', 'claimed', 'released', 'expired',
    'blocked', 'unblocked', 'completed', 'failed', 'canceled', 'assigned', 'reprioritized',
    'reopened', 'batch_finished')),
  state TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent', 'person', 'system')),
  actor_participant_id TEXT REFERENCES participants(id),
  reason TEXT CHECK (length(reason) <= 32),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK ((actor_kind = 'system') = (actor_participant_id IS NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, seq);

-- Who receives each event in get_updates with tasks "mine", computed when the event is written,
-- like message_mentions. wakes = 1 marks the events that also wake the participant (section 6).
CREATE TABLE IF NOT EXISTS task_event_recipients (
  participant_id TEXT NOT NULL REFERENCES participants(id),
  seq INTEGER NOT NULL REFERENCES task_events(seq),
  wakes INTEGER NOT NULL CHECK (wakes IN (0, 1)),
  PRIMARY KEY (participant_id, seq)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS task_event_recipients_seq ON task_event_recipients(seq);

-- The thread: messages in the board channel that belong to a task. A sibling row beside an
-- immutable message, inserted in the same transaction, like message_priority.
CREATE TABLE IF NOT EXISTS task_messages (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  seq INTEGER NOT NULL UNIQUE REFERENCES messages(seq),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('brief', 'note', 'question', 'answer', 'decision',
    'result', 'failure', 'cancel'))
) STRICT;
CREATE INDEX IF NOT EXISTS task_messages_task ON task_messages(task_id, seq);

-- Thread messages delivered through get_updates with tasks "mine": the task's owner, assignee and
-- holder, sender excluded. The same shape and use as message_mentions.
CREATE TABLE IF NOT EXISTS task_message_recipients (
  participant_id TEXT NOT NULL REFERENCES participants(id),
  seq INTEGER NOT NULL REFERENCES messages(seq),
  wakes INTEGER NOT NULL CHECK (wakes IN (0, 1)),
  PRIMARY KEY (participant_id, seq)
) STRICT, WITHOUT ROWID;

-- An agent that asked for work and found none. It is woken when matching work becomes ready.
-- One row per agent; a later empty claim replaces it, a claim or an hour removes it.
CREATE TABLE IF NOT EXISTS task_interests (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id),
  labels TEXT NOT NULL CHECK (json_valid(labels) AND json_type(labels) = 'array'),
  since INTEGER NOT NULL CHECK (since >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > since),
  woken_seq INTEGER CHECK (woken_seq >= 1)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS task_interests_since ON task_interests(since);

-- Idempotency for claim_task, update_task and people's task actions: what each request key did.
-- A retry with the same key and input returns the same result (for a claim: the same lease, if
-- the caller still holds it).
CREATE TABLE IF NOT EXISTS task_requests (
  created_by_grant_id TEXT NOT NULL REFERENCES server_grants(id),
  request_key TEXT NOT NULL CHECK (length(CAST(request_key AS BLOB)) BETWEEN 1 AND 128),
  operation TEXT NOT NULL CHECK (operation IN ('claim', 'update', 'person')),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  task_id TEXT REFERENCES tasks(id),
  epoch INTEGER CHECK (epoch >= 0),
  event_seq INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (created_by_grant_id, request_key)
) STRICT, WITHOUT ROWID;

-- Defend the state machine at the SQL seam (section 3.1 lists the allowed moves). The service
-- refuses first with a typed error; this trigger catches a bug, never an expected request.
CREATE TRIGGER IF NOT EXISTS tasks_transition BEFORE UPDATE OF state ON tasks
WHEN OLD.state <> NEW.state AND NOT (
  (OLD.state = 'waiting' AND NEW.state IN ('ready', 'canceled')) OR
  (OLD.state = 'ready' AND NEW.state IN ('claimed', 'canceled')) OR
  (OLD.state = 'claimed' AND NEW.state IN ('ready', 'blocked', 'completed', 'failed', 'canceled')) OR
  (OLD.state = 'blocked' AND NEW.state IN ('ready', 'canceled')) OR
  (OLD.state = 'failed' AND NEW.state IN ('ready', 'waiting')) OR
  (OLD.state = 'canceled' AND NEW.state = 'waiting' AND OLD.outcome_reason = 'need_failed')
)
BEGIN
  SELECT RAISE(ABORT, 'task_transition_invalid');
END;

-- A new epoch on every claim, never a lower one.
CREATE TRIGGER IF NOT EXISTS tasks_epoch BEFORE UPDATE OF lease_epoch ON tasks
WHEN NEW.lease_epoch < OLD.lease_epoch
BEGIN
  SELECT RAISE(ABORT, 'task_epoch_regressed');
END;

-- History size (history-size.sql): a task row weighs 512 bytes plus its title and summary; an
-- event 128 bytes. Thread messages are already counted as messages.
CREATE TRIGGER IF NOT EXISTS tasks_size_insert AFTER INSERT ON tasks BEGIN
  UPDATE history_size SET bytes = bytes + 512 + length(CAST(NEW.title AS BLOB)) WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS tasks_size_delete AFTER DELETE ON tasks BEGIN
  UPDATE history_size SET bytes = MAX(0, bytes - 512 - length(CAST(OLD.title AS BLOB))
    - COALESCE(length(CAST(OLD.outcome_summary AS BLOB)), 0)) WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS tasks_size_outcome AFTER UPDATE OF outcome_summary ON tasks
WHEN OLD.outcome_summary IS NULL AND NEW.outcome_summary IS NOT NULL BEGIN
  UPDATE history_size SET bytes = bytes + length(CAST(NEW.outcome_summary AS BLOB)) WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS tasks_size_outcome_cleared AFTER UPDATE OF outcome_summary ON tasks
WHEN OLD.outcome_summary IS NOT NULL AND NEW.outcome_summary IS NULL BEGIN
  UPDATE history_size SET bytes = MAX(0, bytes - length(CAST(OLD.outcome_summary AS BLOB)))
    WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS task_events_size_insert AFTER INSERT ON task_events BEGIN
  UPDATE history_size SET bytes = bytes + 128 WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS task_events_size_delete AFTER DELETE ON task_events BEGIN
  UPDATE history_size SET bytes = MAX(0, bytes - 128) WHERE singleton = 1;
END;
