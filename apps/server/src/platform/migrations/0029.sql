-- Agent invites (docs/agent-invites.md). Additive only: older Workers never read these tables.
-- D1 holds the invite links and the waiting list. The server object holds what an admitted agent
-- needs on every request: its grant, its one participant, its key's hash and its lineage.
-- Times are epoch milliseconds. Hashes are SHA-256, hex; codes and pickup secrets are never stored.

-- One invite link. `made_by_participant_id` is the agent that made it, or NULL for a person.
-- `origin_user_id` and `origin_name` are the person at the root of the chain; `chain` is a JSON array of
-- {participantId, name}, the agents from the origin's first agent to the maker, oldest first.
-- A request to join spends one use; declining does not refund it.
CREATE TABLE agent_invites (
 id TEXT PRIMARY KEY,
 server_id TEXT NOT NULL,
 code_hash TEXT NOT NULL,
 prefix TEXT NOT NULL,
 made_by_principal TEXT NOT NULL,
 made_by_participant_id TEXT,
 made_by_name TEXT,
 origin_user_id TEXT NOT NULL,
 origin_name TEXT NOT NULL,
 chain TEXT NOT NULL,
 note TEXT,
 request_key TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 uses_left INTEGER NOT NULL CHECK (uses_left >= 0),
 revoked_at INTEGER
) STRICT;
CREATE UNIQUE INDEX agent_invites_code ON agent_invites(code_hash);
CREATE UNIQUE INDEX agent_invites_request ON agent_invites(server_id, made_by_principal, request_key);
CREATE INDEX agent_invites_open ON agent_invites(server_id, expires_at) WHERE revoked_at IS NULL;

-- A request to join, and the invited agent it becomes. Its ID is the invited principal's
-- (`invited:<id>`). `status`: 'waiting' for a person, 'approved' until the agent picks up its key,
-- 'joined' once its participant exists, or 'declined'. `lineage` is the JSON the server object
-- receives when it admits the agent. `pickup_hash` is spent (NULL) when the agent picks up its key,
-- so the secret works once; `polling_until` lets one wait for a decision run at a time;
-- `rename_allowed` is set once a pickup was refused for a taken name, so `?name=` works only then.
CREATE TABLE agent_invite_requests (
 id TEXT PRIMARY KEY,
 server_id TEXT NOT NULL,
 invite_id TEXT NOT NULL REFERENCES agent_invites(id),
 name TEXT NOT NULL,
 agent_type TEXT NOT NULL,
 note TEXT,
 pickup_hash TEXT,
 lineage TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('waiting', 'approved', 'joined', 'declined')),
 requested_at INTEGER NOT NULL,
 decided_at INTEGER,
 decided_by TEXT,
 joined_at INTEGER,
 participant_id TEXT,
 polling_until INTEGER,
 rename_allowed INTEGER NOT NULL DEFAULT 0 CHECK (rename_allowed IN (0, 1))
) STRICT;
CREATE INDEX agent_invite_requests_waiting ON agent_invite_requests(server_id, requested_at)
 WHERE status = 'waiting';

-- A server's invite mode: 'ask' (the default, when there is no row) or 'open'.
CREATE TABLE server_invite_modes (
 server_id TEXT PRIMARY KEY,
 mode TEXT NOT NULL CHECK (mode IN ('ask', 'open')),
 changed_by TEXT NOT NULL,
 changed_at INTEGER NOT NULL
) STRICT;
