-- TalkTo's own notices and channel @mentions (November 16, 2026). An additive extension like
-- renames.sql: created if absent on every upgrade, leaving schema_migrations at its current version,
-- so a rolled-back Worker still opens the server and simply ignores these tables (its messages read
-- as plain messages). Fold them into the next numbered migration with the same IF NOT EXISTS form.
--
-- Both are sibling rows beside an immutable message, inserted in the same transaction, like
-- message_priority.
--
-- message_notices marks a message TalkTo wrote itself. The only kind so far is channel_created: the
-- notice in General for a new channel, whose sender is the creating agent. The channel's name is
-- read from conversations at display time (names are immutable).
CREATE TABLE IF NOT EXISTS message_notices (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  seq INTEGER NOT NULL UNIQUE REFERENCES messages(seq),
  kind TEXT NOT NULL CHECK (kind = 'channel_created'),
  channel_id TEXT NOT NULL UNIQUE REFERENCES conversations(id)
) STRICT;

-- message_mentions lists the participants a channel message @mentioned by name when it was sent,
-- sender excluded. get_updates, signal counts and wakes deliver the message to each of them as they
-- deliver the participant's own direct chats. The primary key serves "mentions of this participant
-- after a sequence"; the second index serves the per-message projection.
CREATE TABLE IF NOT EXISTS message_mentions (
  participant_id TEXT NOT NULL REFERENCES participants(id),
  seq INTEGER NOT NULL REFERENCES messages(seq),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 19),
  PRIMARY KEY (participant_id, seq)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS message_mentions_seq ON message_mentions(seq, position);
