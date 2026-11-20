-- Derived activity references. Server SQLite remains the authoritative message store.
CREATE TABLE activity_progress (
 server_id TEXT PRIMARY KEY REFERENCES servers(id),
 sequence INTEGER NOT NULL DEFAULT 0,
 checked_at TEXT NOT NULL,
 caught_up INTEGER NOT NULL CHECK(caught_up IN (0,1))
) STRICT;
CREATE TABLE activity_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 account_id TEXT NOT NULL REFERENCES accounts(id),
 server_id TEXT NOT NULL REFERENCES servers(id),
 message_id TEXT NOT NULL,
 sequence INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(server_id, sequence),
 UNIQUE(server_id, message_id)
) STRICT;
CREATE INDEX activity_account_delivery ON activity_events(account_id,id);
CREATE INDEX activity_account_time ON activity_events(account_id,created_at,server_id);
CREATE INDEX activity_server_delivery ON activity_events(server_id,id);
-- Contentless search stores terms, not a second retrievable copy of message bodies.
CREATE VIRTUAL TABLE activity_search USING fts5(body, content='');
