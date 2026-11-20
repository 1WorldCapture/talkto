-- Claims intentionally have no cascading account/user foreign key: recreation
-- must not replenish trial eligibility. Erasure is a separate retention policy.
ALTER TABLE billing_operations ADD COLUMN offer TEXT NOT NULL DEFAULT 'paid' CHECK(offer IN ('paid','trial'));
CREATE TABLE billing_trials (
 account_id TEXT PRIMARY KEY,
 provider_scope TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 email_key TEXT NOT NULL,
 card_key TEXT,
 operation_id TEXT,
 subscription_id TEXT,
 claimed_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','rejected')),
 start TEXT,
 end TEXT,
 allowance INTEGER NOT NULL DEFAULT 500 CHECK(allowance=500),
 UNIQUE(provider_scope, owner_id),
 UNIQUE(provider_scope, email_key),
 UNIQUE(provider_scope, card_key)
) STRICT;
CREATE INDEX billing_trial_admissions ON billing_trials(provider_scope,claimed_at);
