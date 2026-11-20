-- Account deletion (docs/account-deletion.md). One row per person who confirmed deleting their
-- account: the durable intent that the request and the scheduled sync resume, then the minimal
-- record that the account was deleted. It holds the WorkOS user ID, which no longer resolves to a
-- name or email once the WorkOS user is deleted, and times. Membership writes check it so that
-- late identity events cannot re-add rows for a deleted person.
CREATE TABLE account_deletions (
 user_id TEXT PRIMARY KEY,
 requested_at TEXT NOT NULL,
 user_deleted_at TEXT,
 completed_at TEXT
) STRICT;
CREATE INDEX account_deletions_pending ON account_deletions(completed_at, requested_at);
-- Organizations deleted with their sole owner keep a content-free tombstone, as servers do: IDs,
-- creator, creation request key and times. The name becomes "Deleted organization".
ALTER TABLE accounts ADD COLUMN deletion_requested_at TEXT;
ALTER TABLE accounts ADD COLUMN deletion_completed_at TEXT;
