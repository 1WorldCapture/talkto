-- Self-host licenses sold through Stripe Payment Links (docs/self-host-spec.md, "Delivery"). Written
-- only from signed Stripe events at /webhooks/stripe-selfhost and the owner's selfhost:licenses tool.
-- No email address, name or card detail is kept: only Stripe IDs and the GitHub usernames to invite.
-- One row per Stripe subscription. A license gives repository access only while it is paid, its
-- buyer accepted the license at Checkout (consent, version and time are the proof), and the
-- subscription has not ended. `observed_at` is the Stripe event time of `subscription_status`, so a
-- late, older event never overwrites a newer one.
CREATE TABLE selfhost_licenses (
 subscription_id TEXT PRIMARY KEY,
 provider_scope TEXT NOT NULL,
 customer_id TEXT NOT NULL,
 license TEXT NOT NULL CHECK(license IN ('personal','team','business')),
 session_id TEXT UNIQUE,
 paid_at INTEGER,
 consent TEXT CHECK(consent IN ('accepted')),
 license_version TEXT,
 consented_at INTEGER,
 requested_login TEXT,
 subscription_status TEXT,
 observed_at INTEGER NOT NULL DEFAULT 0,
 period_end TEXT,
 ended_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
) STRICT;
-- One GitHub account per row. `state` is what the repository should hold for it and whether that is
-- confirmed: `deliver` (invite it, not yet done), `invited` (invited or already a collaborator),
-- `revoke` (remove it, not yet done) and `idle` (no access, nothing to do). Work is claimed with a
-- short lease, so a webhook and the minute cron never act on one account at the same time.
-- `retired` accounts were removed by the owner and are never invited again.
CREATE TABLE selfhost_seats (
 subscription_id TEXT NOT NULL REFERENCES selfhost_licenses(subscription_id),
 github_login TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('checkout','owner')),
 retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)),
 state TEXT NOT NULL CHECK(state IN ('idle','deliver','invited','revoke')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL,
 last_error TEXT,
 lease TEXT,
 leased_until INTEGER NOT NULL DEFAULT 0,
 invitation_id INTEGER,
 invited_at INTEGER,
 accepted_at INTEGER,
 reinvites INTEGER NOT NULL DEFAULT 0,
 revoked_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(subscription_id,github_login)
) STRICT;
CREATE INDEX selfhost_seats_due ON selfhost_seats(state,next_attempt_at);
CREATE INDEX selfhost_licenses_customer ON selfhost_licenses(customer_id);
