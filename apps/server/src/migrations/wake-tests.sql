-- Auto-start tests (November 16, 2026). An additive extension like removals.sql: created if absent
-- on every upgrade, leaving schema_migrations at its current version, so a rolled-back Worker
-- still opens the server and simply ignores this table. Fold it into the next numbered migration
-- with the same IF NOT EXISTS form.
--
-- One row per wake target a person sent a test to from the dashboard: when, and how the service
-- answered ('accepted', a delivery reason code, or 'unfinished' while the request is out). A test
-- never touches the target's own delivery state (delivered_through, due_at, last_attempt_at,
-- failures), so it changes neither the wake's checkpoint nor its cadence. Re-adding a wake gives
-- it a new id; rows whose target is gone are removed with expired targets.
CREATE TABLE IF NOT EXISTS wake_tests (
  wake_id TEXT PRIMARY KEY CHECK (length(wake_id) = 36),
  tested_at INTEGER NOT NULL CHECK (tested_at >= 0),
  outcome TEXT NOT NULL CHECK (length(outcome) BETWEEN 1 AND 64)
) STRICT, WITHOUT ROWID;
