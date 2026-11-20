-- Initial server schema. Apply once through the versioned bootstrap.
-- One database belongs to exactly one TalkTo server. Execute the migration
-- through DurableObjectStorage.transactionSync; do not add SQL BEGIN/COMMIT.

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
) STRICT;

CREATE TABLE server (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
  name TEXT NOT NULL CHECK (length(CAST(name AS BLOB)) BETWEEN 1 AND 100),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

-- principal_key is resolved by the trusted authentication adapter. Neither it
-- nor grant IDs are agent-supplied identity fields. Revoked rows are retained.
CREATE TABLE server_grants (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  principal_key TEXT NOT NULL CHECK (length(CAST(principal_key AS BLOB)) BETWEEN 1 AND 512),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  revoked_at INTEGER CHECK (revoked_at >= created_at)
) STRICT;

CREATE UNIQUE INDEX server_grants_active_principal
  ON server_grants(principal_key) WHERE revoked_at IS NULL;

CREATE TABLE participants (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  name TEXT NOT NULL COLLATE NOCASE UNIQUE
    CHECK (length(name) BETWEEN 1 AND 64
      AND name GLOB '[A-Za-z]*' AND name NOT GLOB '*[^A-Za-z0-9_-]*'),
  agent_type TEXT NOT NULL
    CHECK (length(agent_type) BETWEEN 1 AND 64
      AND agent_type GLOB '[A-Za-z]*' AND agent_type NOT GLOB '*[^A-Za-z0-9_-]*'),
  working_directory TEXT CHECK (length(CAST(working_directory AS BLOB)) BETWEEN 1 AND 2048),
  joined_note TEXT CHECK (length(CAST(joined_note AS BLOB)) BETWEEN 1 AND 1024),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  created_by_grant_id TEXT NOT NULL REFERENCES server_grants(id),
  request_key TEXT NOT NULL CHECK (length(CAST(request_key AS BLOB)) BETWEEN 1 AND 128),
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  last_message_at INTEGER,
  UNIQUE (created_by_grant_id, request_key),
  CHECK ((message_count = 0 AND last_message_at IS NULL)
    OR (message_count > 0 AND last_message_at IS NOT NULL AND last_message_at >= created_at))
) STRICT;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  kind TEXT NOT NULL CHECK (kind IN ('channel', 'direct')),
  name TEXT COLLATE NOCASE,
  description TEXT CHECK (length(CAST(description AS BLOB)) BETWEEN 1 AND 1024),
  is_general INTEGER NOT NULL DEFAULT 0 CHECK (is_general IN (0, 1)),
  participant_low_id TEXT REFERENCES participants(id),
  participant_high_id TEXT REFERENCES participants(id),
  created_by_participant_id TEXT REFERENCES participants(id),
  created_by_grant_id TEXT REFERENCES server_grants(id),
  request_key TEXT CHECK (length(CAST(request_key AS BLOB)) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  archived_at INTEGER CHECK (archived_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  last_message_seq INTEGER REFERENCES messages(seq),
  last_message_at INTEGER,
  CHECK (
    (kind = 'channel' AND name IS NOT NULL
      AND length(name) BETWEEN 1 AND 64
      AND name GLOB '[A-Za-z]*' AND name NOT GLOB '*[^A-Za-z0-9_-]*'
      AND participant_low_id IS NULL AND participant_high_id IS NULL
      AND (
        (is_general = 1 AND name = 'General' COLLATE BINARY
          AND description IS NULL AND archived_at IS NULL AND revision = 0
          AND created_by_participant_id IS NULL AND created_by_grant_id IS NULL AND request_key IS NULL)
        OR
        (is_general = 0 AND name <> 'General' COLLATE NOCASE
          AND created_by_participant_id IS NOT NULL AND created_by_grant_id IS NOT NULL AND request_key IS NOT NULL)
      ))
    OR
    (kind = 'direct' AND name IS NULL AND description IS NULL AND is_general = 0
      AND participant_low_id IS NOT NULL AND participant_high_id IS NOT NULL
      AND participant_low_id < participant_high_id
      AND created_by_participant_id IS NOT NULL
      AND created_by_participant_id IN (participant_low_id, participant_high_id)
      AND created_by_grant_id IS NOT NULL AND request_key IS NULL
      AND archived_at IS NULL AND revision = 0)
  ),
  CHECK ((message_count = 0 AND last_message_seq IS NULL AND last_message_at IS NULL)
    OR (message_count > 0 AND last_message_seq IS NOT NULL
      AND last_message_at IS NOT NULL AND last_message_at >= created_at))
) STRICT;

CREATE UNIQUE INDEX conversations_channel_name
  ON conversations(name COLLATE NOCASE) WHERE kind = 'channel';
CREATE UNIQUE INDEX conversations_general
  ON conversations(is_general) WHERE is_general = 1;
CREATE UNIQUE INDEX conversations_channel_request
  ON conversations(created_by_grant_id, request_key) WHERE kind = 'channel' AND is_general = 0;
CREATE UNIQUE INDEX conversations_direct_pair
  ON conversations(participant_low_id, participant_high_id) WHERE kind = 'direct';
CREATE INDEX conversations_direct_low ON conversations(participant_low_id, id) WHERE kind = 'direct';
CREATE INDEX conversations_direct_high ON conversations(participant_high_id, id) WHERE kind = 'direct';

CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT CHECK (seq BETWEEN 1 AND 9007199254740991),
  id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sender_id TEXT NOT NULL REFERENCES participants(id),
  created_by_grant_id TEXT NOT NULL REFERENCES server_grants(id),
  request_key TEXT NOT NULL CHECK (length(CAST(request_key AS BLOB)) BETWEEN 1 AND 128),
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) BETWEEN 1 AND 16384 AND instr(body, char(0)) = 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (created_by_grant_id, request_key)
) STRICT;

CREATE INDEX messages_conversation_seq ON messages(conversation_id, seq);
CREATE INDEX messages_sender_seq ON messages(sender_id, seq);
CREATE INDEX messages_created_at_seq ON messages(created_at, seq);

CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='seq', tokenize='unicode61');

-- The service performs access checks and returns typed failures before writing.
-- These triggers also defend the structural message invariants at the SQL seam.
CREATE TRIGGER messages_validate BEFORE INSERT ON messages BEGIN
  SELECT RAISE(ABORT, 'conversation_not_found')
    WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE id = NEW.conversation_id);
  SELECT RAISE(ABORT, 'channel_archived')
    WHERE EXISTS (SELECT 1 FROM conversations WHERE id = NEW.conversation_id AND archived_at IS NOT NULL);
  SELECT RAISE(ABORT, 'direct_sender_not_in_pair')
    WHERE EXISTS (SELECT 1 FROM conversations WHERE id = NEW.conversation_id AND kind = 'direct'
      AND NEW.sender_id NOT IN (participant_low_id, participant_high_id));
  SELECT RAISE(ABORT, 'message_time_regressed')
    WHERE NEW.created_at < COALESCE((SELECT created_at FROM messages ORDER BY seq DESC LIMIT 1), 0)
      OR NEW.created_at < (SELECT created_at FROM conversations WHERE id = NEW.conversation_id)
      OR NEW.created_at < (SELECT created_at FROM participants WHERE id = NEW.sender_id);
END;

CREATE TRIGGER messages_inserted AFTER INSERT ON messages BEGIN
  UPDATE conversations SET message_count = message_count + 1,
    last_message_seq = NEW.seq, last_message_at = NEW.created_at WHERE id = NEW.conversation_id;
  UPDATE participants SET message_count = message_count + 1,
    last_message_at = NEW.created_at WHERE id = NEW.sender_id;
  INSERT INTO messages_fts(rowid, body) VALUES (NEW.seq, NEW.body);
END;

CREATE TRIGGER messages_immutable_update BEFORE UPDATE ON messages BEGIN
  SELECT RAISE(ABORT, 'message_immutable');
END;
CREATE TRIGGER messages_immutable_delete BEFORE DELETE ON messages BEGIN
  SELECT RAISE(ABORT, 'message_immutable');
END;
