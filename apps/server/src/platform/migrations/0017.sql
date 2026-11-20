-- Refunds and disputes end paid sending (KEY_DECISIONS.md, November 16, 2026). Additive only:
-- older Workers name their stripe_events columns and never read billing_revocations.
-- The charge a charge.* event is about, so reconciliation reads that charge from Stripe again.
ALTER TABLE stripe_events ADD COLUMN object_id TEXT;
-- One row per charge that paid a TalkTo invoice and was fully refunded or disputed. `reason` is the
-- latest cause; `status` is `active` while the payment stays reversed and `cleared` after a dispute
-- is won (or an inquiry closes without a chargeback). The period that invoice paid for, or the
-- period an upgrade invoice changed, stops sending while the row is active. No card details.
CREATE TABLE billing_revocations (
 charge_id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES workspace_billing(account_id),
 invoice_id TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN ('refund','dispute')),
 status TEXT NOT NULL CHECK(status IN ('active','cleared')),
 revoked_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX billing_revocations_invoice ON billing_revocations(account_id,invoice_id);
