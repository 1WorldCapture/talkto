-- TalkTo's own email (docs/email.md). Additive only: older Workers never read these tables.
-- No email address is stored anywhere here. Addresses are read from WorkOS at send time, and the
-- suppression list keeps only a keyed hash of each address.
-- Product update choice per WorkOS user. No row means the default in packages/api/src/email.ts
-- (`productUpdatesByDefault`). Account emails have no setting: they cannot be turned off.
CREATE TABLE email_preferences (
 user_id TEXT PRIMARY KEY,
 product_updates INTEGER NOT NULL CHECK(product_updates IN (0,1)),
 source TEXT NOT NULL CHECK(source IN ('settings','unsubscribe_link','one_click')),
 updated_at TEXT NOT NULL
) STRICT;
-- One row per email TalkTo decided to send to one person: the send record. `key` names what the
-- email is about (for example `allowance:<account>:<period start>:80`), so the same event queued
-- twice by a retry, a webhook replay or the cron stays one row and is sent once. `payload` holds the
-- template's data, never an address. `state`: pending (due at next_attempt_at), sending (claimed in
-- batch `batch_id`, provider outcome not yet recorded), sent, skipped (unsubscribed, suppressed, no
-- verified address) or failed (refused for good, or unconfirmed past the provider's idempotency
-- window, so it is never sent again).
CREATE TABLE email_outbox (
 key TEXT NOT NULL,
 user_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('allowance','payment','plugin_update','product_update')),
 account_id TEXT,
 payload TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','skipped','failed')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 batch_id TEXT,
 claimed_at INTEGER,
 provider_id TEXT,
 reason TEXT,
 created_at TEXT NOT NULL,
 sent_at TEXT,
 PRIMARY KEY(key, user_id)
) STRICT;
CREATE INDEX email_outbox_due ON email_outbox(state, next_attempt_at);
CREATE INDEX email_outbox_batch ON email_outbox(batch_id) WHERE batch_id IS NOT NULL;
-- Addresses the provider reported as bounced, complained or suppressed. `address_key` is an HMAC
-- of the lowercased address under TALKTO_EMAIL_SIGNING_SECRET. Nothing is sent to these again.
CREATE TABLE email_suppressions (
 address_key TEXT PRIMARY KEY,
 reason TEXT NOT NULL CHECK(reason IN ('bounced','complained','suppressed')),
 created_at TEXT NOT NULL
) STRICT;
-- Product updates written by the owner's `pnpm email:announce`. The minute cron queues one outbox
-- row per subscribed person in user ID order, remembering the last user it queued in `cursor`.
CREATE TABLE email_announcements (
 id TEXT PRIMARY KEY,
 subject TEXT NOT NULL,
 body TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queuing','queued','canceled')),
 cursor TEXT NOT NULL DEFAULT '',
 recipients INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 queued_at TEXT
) STRICT;
-- Signed provider webhook deliveries already applied, so a replay changes nothing twice.
CREATE TABLE email_webhook_events (
 id TEXT PRIMARY KEY,
 received_at TEXT NOT NULL
) STRICT;
