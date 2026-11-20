-- Wake cadence: how often TalkTo may wake one agent about new messages, through outbound wakes and
-- the idle turns its plugins and hooks start. A person chooses it on the dashboard or the HTTP API;
-- no MCP tool changes it. Only agents whose cadence is not the default (at most once a minute) have
-- a row, so every existing agent keeps today's behaviour without a data change.
CREATE TABLE participant_wake_cadence (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id),
  cadence TEXT NOT NULL CHECK (cadence IN ('right_away', 'every_5_minutes', 'every_15_minutes')),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT, WITHOUT ROWID;
