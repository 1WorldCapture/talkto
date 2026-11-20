-- Paid upgrades inside a billing period (docs/pricing-and-billing.md, "Changing plans"). One row per
-- paid Stripe proration invoice line that moved a subscription to a higher plan. The period it
-- changes is the billing_periods row with the same subscription and end. Its recorded allowance is
-- never edited: readers add each upgrade's prorated share, so a replayed invoice changes nothing.
CREATE TABLE billing_plan_changes (
 account_id TEXT NOT NULL REFERENCES workspace_billing(account_id),
 subscription_id TEXT NOT NULL,
 invoice_id TEXT NOT NULL,
 line_id TEXT NOT NULL,
 from_plan TEXT NOT NULL CHECK(from_plan IN ('shop','studio','factory')),
 plan TEXT NOT NULL CHECK(plan IN ('shop','studio','factory')),
 at TEXT NOT NULL,
 period_end TEXT NOT NULL CHECK(period_end>at),
 PRIMARY KEY(invoice_id,line_id)
) STRICT;
CREATE INDEX billing_plan_changes_period ON billing_plan_changes(account_id,subscription_id,period_end,at);
