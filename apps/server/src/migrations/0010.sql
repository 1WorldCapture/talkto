-- People: one participant per signed-in person per server, created only from the person's verified
-- website session or WorkOS access token, never through MCP or a participant ID in a request.
-- `kind` is 'person' on those rows and NULL on every agent, so agent records keep their shape.
ALTER TABLE participants ADD COLUMN kind TEXT CHECK (kind IS NULL OR kind = 'person');

CREATE INDEX participants_person ON participants(kind) WHERE kind IS NOT NULL;

-- The durable binding from the authenticated principal (the WorkOS user) to its participant.
-- It is kept when a grant is revoked, like the revoked grant itself, so a returning person keeps
-- one identity and history. `forgotten_at` is set when the person deletes their TalkTo account:
-- the participant and its messages stay, renamed to a neutral `former-person` name.
CREATE TABLE person_participants (
  principal_key TEXT PRIMARY KEY CHECK (length(CAST(principal_key AS BLOB)) BETWEEN 1 AND 512),
  participant_id TEXT NOT NULL UNIQUE REFERENCES participants(id),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  forgotten_at INTEGER CHECK (forgotten_at IS NULL OR forgotten_at >= created_at)
) STRICT, WITHOUT ROWID;

-- What each person's "open a direct chat" request key returned, so a replay answers the same.
CREATE TABLE person_requests (
  participant_id TEXT NOT NULL REFERENCES participants(id),
  request_key TEXT NOT NULL CHECK (length(CAST(request_key AS BLOB)) BETWEEN 1 AND 128),
  agent_id TEXT NOT NULL REFERENCES participants(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  created INTEGER NOT NULL CHECK (created IN (0, 1)),
  PRIMARY KEY (participant_id, request_key)
) STRICT, WITHOUT ROWID;
