-- Deleting an organization (November 24, 2026, docs/account-deletion.md, "Deleting one
-- organization"). Additive only: older Workers never read this column and already hide an account
-- whose deletion_requested_at is set. The owner who asked is recorded so the minute cron can finish
-- an interrupted deletion that no account deletion is driving, and the tombstone says who asked.
ALTER TABLE accounts ADD COLUMN deletion_requested_by TEXT;
CREATE INDEX accounts_organization_deletions ON accounts(deletion_requested_by) WHERE deletion_requested_by IS NOT NULL AND deletion_completed_at IS NULL;
