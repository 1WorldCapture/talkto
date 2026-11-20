-- Billing is opt-in. Existing messaging and membership records are unchanged.
CREATE TABLE workspace_billing (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id),
 provider_scope TEXT NOT NULL,
 customer_id TEXT,
 subscription_id TEXT,
 subscription_json TEXT,
 checked_at TEXT,
 invoice_cursor TEXT,
 lease TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 attempted_at INTEGER NOT NULL DEFAULT 0,
 synced_event INTEGER NOT NULL DEFAULT 0,
 UNIQUE(provider_scope, customer_id),
 UNIQUE(provider_scope, subscription_id)
) STRICT;
CREATE TABLE billing_operations (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES workspace_billing(account_id),
 request_key TEXT NOT NULL,
 plan TEXT NOT NULL CHECK(plan IN ('shop','studio','factory')),
 created_at INTEGER NOT NULL,
 customer_id TEXT,
 session_id TEXT UNIQUE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete','expired')),
 UNIQUE(account_id, request_key)
) STRICT;
CREATE UNIQUE INDEX billing_one_checkout ON billing_operations(account_id) WHERE status='pending';
CREATE TABLE stripe_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 event_id TEXT NOT NULL UNIQUE,
 account_id TEXT NOT NULL REFERENCES workspace_billing(account_id),
 event_type TEXT NOT NULL
) STRICT;
CREATE INDEX stripe_events_workspace ON stripe_events(account_id,sequence);
CREATE TABLE billing_periods (
 account_id TEXT NOT NULL REFERENCES workspace_billing(account_id),
 subscription_id TEXT NOT NULL,
 invoice_id TEXT NOT NULL,
 line_id TEXT NOT NULL,
 plan TEXT NOT NULL CHECK(plan IN ('shop','studio','factory')),
 plan_version TEXT NOT NULL,
 start TEXT NOT NULL,
 end TEXT NOT NULL CHECK(end>start),
 allowance INTEGER NOT NULL CHECK(allowance>0),
 PRIMARY KEY(invoice_id,line_id),
 UNIQUE(subscription_id,start,end)
) STRICT;
CREATE INDEX billing_periods_workspace ON billing_periods(account_id,start DESC);
