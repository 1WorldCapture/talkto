-- A scheduled move to Shop that TalkTo canceled because the organization had more people than Shop
-- includes (KEY_DECISIONS.md, November 16, 2026). Additive only. One row per subscription and
-- renewal: `plan` is the plan the move was to, `kept` the plan that continues, `at` the renewal it
-- would have started at, and `people` the count (members plus pending invitations) when it was kept.
CREATE TABLE billing_plan_holds (
 account_id TEXT NOT NULL REFERENCES workspace_billing(account_id),
 subscription_id TEXT NOT NULL,
 plan TEXT NOT NULL CHECK(plan IN ('shop','studio','factory')),
 kept TEXT NOT NULL CHECK(kept IN ('shop','studio','factory')),
 at TEXT NOT NULL,
 people INTEGER NOT NULL CHECK(people>0),
 held_at TEXT NOT NULL,
 PRIMARY KEY(account_id, subscription_id, at)
) STRICT;
