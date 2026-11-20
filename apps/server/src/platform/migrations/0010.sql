-- No-card free start: one lifetime allowance per eligible owner, inbox and organization.
-- Like billing_trials, nothing here cascades from accounts, users or servers: deleting a server or
-- recreating an organization must not replenish eligibility. Message totals stay in the quota
-- authority; these rows record admission, binding and publication only.
CREATE TABLE starter_grants (
 id TEXT PRIMARY KEY,
 namespace TEXT NOT NULL,
 cohort TEXT NOT NULL,
 offer_version TEXT NOT NULL,
 account_id TEXT NOT NULL UNIQUE,
 organization_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 request_key TEXT NOT NULL,
 server_name TEXT NOT NULL,
 server_id TEXT,
 allowance INTEGER NOT NULL CHECK(allowance=500),
 status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','active')),
 reserved_at TEXT NOT NULL,
 reserved_day TEXT NOT NULL,
 activated_at TEXT,
 published_at TEXT
) STRICT;
CREATE INDEX starter_grant_admissions ON starter_grants(cohort,reserved_day);
CREATE INDEX starter_grant_publication ON starter_grants(published_at);
-- Spent eligibility. `key` is the owner's user ID, the WorkOS organization ID, the account ID, or a
-- versioned HMAC of the owner's recognized inbox; raw email addresses are never stored.
CREATE TABLE starter_claims (
 namespace TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('owner','inbox','organization','account')),
 key TEXT NOT NULL,
 grant_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(namespace,kind,key)
) STRICT;
CREATE INDEX starter_claim_grants ON starter_claims(grant_id);
-- Observation only: an HMAC of the claiming network, kept for a configured number of days and
-- never used to deny a claim. One row per grant, so retries count once.
CREATE TABLE starter_observations (
 grant_id TEXT PRIMARY KEY,
 network_key TEXT,
 observed_at TEXT NOT NULL
) STRICT;
CREATE INDEX starter_observation_age ON starter_observations(observed_at);
