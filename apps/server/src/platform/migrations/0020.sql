-- Share links (docs/share-links-spec.md). Additive only: older Workers never read these tables.
-- Like starter claims, nothing cascades from accounts or users: deleting and recreating an
-- organization never earns again. No email address, domain, card or IP address is stored.
-- One link per organization, owned by its owner. `code` is 16 random bytes in base64url.
CREATE TABLE share_links (
 code TEXT PRIMARY KEY,
 account_id TEXT NOT NULL UNIQUE,
 owner_id TEXT NOT NULL,
 created_at TEXT NOT NULL
) STRICT;
-- One row per accepted sign-up. An organization and its owner join at most once. The window is
-- the 30 days after the new organization's creation; `next_check_at` paces the minute cron.
CREATE TABLE share_referrals (
 id TEXT PRIMARY KEY,
 code TEXT NOT NULL REFERENCES share_links(code),
 sharer_account_id TEXT NOT NULL,
 sharer_owner_id TEXT NOT NULL,
 account_id TEXT NOT NULL UNIQUE,
 owner_id TEXT NOT NULL UNIQUE,
 joined_at TEXT NOT NULL,
 window_start TEXT NOT NULL,
 window_end TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'waiting'
  CHECK(status IN ('waiting','qualified','capped','excluded','expired')),
 reason TEXT CHECK(reason IS NULL OR reason IN ('flagged','same_card')),
 next_check_at TEXT NOT NULL,
 checked_at TEXT,
 settled_at TEXT
) STRICT;
CREATE INDEX share_referrals_link ON share_referrals(code, joined_at);
CREATE INDEX share_referrals_sharer ON share_referrals(sharer_account_id, joined_at);
CREATE INDEX share_referrals_due ON share_referrals(status, next_check_at);
-- One bonus per referral and side: `sharer` (the link's owner) or `joined` (the new organization).
-- `owner_id` is the person who receives it, so the sharer limit counts per person.
CREATE TABLE share_bonuses (
 referral_id TEXT NOT NULL REFERENCES share_referrals(id),
 side TEXT NOT NULL CHECK(side IN ('sharer','joined')),
 account_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 messages INTEGER NOT NULL CHECK(messages=500),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','added','not_added')),
 created_at TEXT NOT NULL,
 applied_at TEXT,
 PRIMARY KEY(referral_id, side)
) STRICT;
CREATE INDEX share_bonuses_owner ON share_bonuses(owner_id, side);
CREATE INDEX share_bonuses_pending ON share_bonuses(status, created_at);
