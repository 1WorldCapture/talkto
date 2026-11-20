-- Delivery priority: a sibling row beside an immutable message, inserted in the same transaction.
-- Only urgent messages have a row; absence means normal.
CREATE TABLE message_priority (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  seq INTEGER NOT NULL UNIQUE REFERENCES messages(seq),
  priority TEXT NOT NULL CHECK (priority = 'urgent')
) STRICT;
