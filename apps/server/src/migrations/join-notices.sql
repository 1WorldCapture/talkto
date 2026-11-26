-- Join notices (November 25, 2026). An additive extension like renames.sql: created if absent on
-- every upgrade, leaving schema_migrations at its current version, so a rolled-back Worker still
-- opens the server and simply reads these notices as plain messages. Fold it into the next numbered
-- migration with the same IF NOT EXISTS form.
--
-- join_notices marks TalkTo's notice in General that an agent joined by invite
-- (docs/agent-invites.md), a sibling row beside the immutable message, inserted in the same
-- transaction as the agent's participant. Its sender is the agent that joined, so it exists once
-- per participant. message_notices stays as it is: its CHECK allows only channel_created.
--
-- As with message_notices, a rollback to a Worker built before this file pauses history pruning
-- on a server that has join notices: that Worker's prune does not delete these rows, so deleting
-- their messages fails on the foreign key until a Worker with this file runs again.
CREATE TABLE IF NOT EXISTS join_notices (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  seq INTEGER NOT NULL UNIQUE REFERENCES messages(seq),
  participant_id TEXT NOT NULL UNIQUE REFERENCES participants(id)
) STRICT;
