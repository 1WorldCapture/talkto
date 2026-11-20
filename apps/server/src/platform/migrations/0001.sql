CREATE TABLE accounts (
 id TEXT PRIMARY KEY,
 organization_id TEXT UNIQUE,
 name TEXT NOT NULL,
 created_by TEXT NOT NULL,
 request_key TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(created_by, request_key)
) STRICT;
CREATE TABLE memberships (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','inactive','pending','deleted')),
 role TEXT NOT NULL,
 updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX memberships_user ON memberships(user_id, organization_id, status);
CREATE TABLE servers (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts(id),
 name TEXT NOT NULL,
 created_by TEXT NOT NULL,
 request_key TEXT NOT NULL,
 general_id TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('provisioning','ready')),
 UNIQUE(account_id, created_by, request_key)
) STRICT;
CREATE INDEX servers_account ON servers(account_id, id);
-- One desired access record per human/server. A new grant ID follows a revocation;
-- the DO retains previous grant rows for message attribution and audit.
CREATE TABLE server_access (
 server_id TEXT NOT NULL REFERENCES servers(id),
 user_id TEXT NOT NULL,
 id TEXT NOT NULL UNIQUE,
 membership_id TEXT NOT NULL REFERENCES memberships(id),
 principal_key TEXT NOT NULL,
 created_at TEXT NOT NULL,
 revoked_at TEXT,
 revision INTEGER NOT NULL CHECK(revision > 0),
 attempted_at TEXT NOT NULL DEFAULT '',
 applied_revision INTEGER NOT NULL DEFAULT 0 CHECK(applied_revision >= 0 AND applied_revision <= revision),
 PRIMARY KEY(server_id, user_id)
) STRICT;
CREATE INDEX access_discovery ON server_access(user_id, revoked_at, server_id);
CREATE INDEX access_membership ON server_access(membership_id);
CREATE INDEX access_pending ON server_access(server_id) WHERE applied_revision < revision;
-- One scheduled consumer. Compare-and-swap cursor updates tolerate overlapping runs.
CREATE TABLE identity_sync (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 cursor TEXT,
 started_at TEXT NOT NULL,
 last_success_at TEXT
) STRICT;
INSERT INTO identity_sync(singleton, started_at) VALUES(1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
