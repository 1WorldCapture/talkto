-- Server guests (docs/dashboard-api.md, "Server guests"). Additive only: older Workers never read
-- this table. An organization's owner invites someone by email to one server they created. The
-- person accepts while signed in with a verified WorkOS address equal to `email_key`, before
-- `expires_at` (7 days, renewed by Resend). Accepting writes a TalkTo-held guest membership in the
-- existing `memberships` table (ID `om_guest…`, role `guest`) and grants access to that server only.
-- The guest is never added to the WorkOS organization. `id` (`sinv_` + 26 base32 characters, 128
-- random bits) is also the join link's handle. `email` is the address as typed, trimmed, and
-- `email_key` its lowercase form. "Expired" is a pending row whose `expires_at` has passed. `sends`
-- counts sends and resends, `sent_at` is the latest. `member_id` is set when the address belonged
-- to an active member of the organization when invited (checked on plans with a people limit), so
-- the invitation takes no second place for that person. The minute cron deletes rows 30 days after
-- they were accepted, canceled or expired. Account deletion deletes rows the person sent or
-- accepted.
CREATE TABLE server_invitations (
 id TEXT PRIMARY KEY,
 server_id TEXT NOT NULL REFERENCES servers(id),
 account_id TEXT NOT NULL,
 organization_id TEXT NOT NULL,
 inviter_id TEXT NOT NULL,
 member_id TEXT,
 email TEXT NOT NULL CHECK(length(email) BETWEEN 3 AND 254),
 email_key TEXT NOT NULL CHECK(length(email_key) BETWEEN 3 AND 254),
 state TEXT NOT NULL CHECK(state IN ('pending','accepted','canceled')),
 created_at TEXT NOT NULL,
 sent_at TEXT NOT NULL,
 sends INTEGER NOT NULL CHECK(sends > 0),
 expires_at TEXT NOT NULL,
 accepted_user_id TEXT CHECK((state='accepted') = (accepted_user_id IS NOT NULL)),
 accepted_at TEXT CHECK((state='accepted') = (accepted_at IS NOT NULL)),
 canceled_at TEXT CHECK((state='canceled') = (canceled_at IS NOT NULL))
) STRICT;
-- One pending invitation per server and address; a repeat returns or renews it.
CREATE UNIQUE INDEX server_invitations_pending ON server_invitations(server_id, email_key) WHERE state='pending';
CREATE INDEX server_invitations_organization ON server_invitations(organization_id, state, expires_at);
CREATE INDEX server_invitations_email ON server_invitations(email_key, state);
CREATE INDEX server_invitations_inviter ON server_invitations(inviter_id);
CREATE INDEX server_invitations_accepted ON server_invitations(accepted_user_id) WHERE accepted_user_id IS NOT NULL;
