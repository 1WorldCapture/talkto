-- Invitation email budgets. One row per send or resend attempt, written before the identity
-- provider is asked to email anyone, so an ambiguous provider failure still counts. `recipient_key`
-- is a SHA-256 of the organization and the lowercased address; raw addresses are never stored.
-- Rows only feed daily and cooldown counts, so they are pruned after a week.
CREATE TABLE invitation_attempts (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL,
 organization_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 recipient_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('send','resend')),
 tier TEXT NOT NULL CHECK(tier IN ('unpaid','paid')),
 attempted_at TEXT NOT NULL,
 day TEXT NOT NULL
) STRICT;
CREATE INDEX invitation_attempt_owners ON invitation_attempts(organization_id,owner_id,day);
CREATE INDEX invitation_attempt_days ON invitation_attempts(day,tier);
CREATE INDEX invitation_attempt_recipients ON invitation_attempts(organization_id,recipient_key,attempted_at);
