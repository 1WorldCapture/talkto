-- Self-host sign-in with Cloudflare Access (docs/self-host-cloudflare-access.md). A copy that signs
-- people in with Access keeps its people, organizations and invitations here instead of in WorkOS.
-- Additive only: deployments that use WorkOS, talkto.sh included, never write these tables.
-- A person who signed in through Access. `id` is derived from the lowercased email.
CREATE TABLE local_users (
 id TEXT PRIMARY KEY,
 email TEXT NOT NULL UNIQUE,
 first_name TEXT,
 last_name TEXT,
 created_at TEXT NOT NULL,
 seen_at TEXT NOT NULL
) STRICT;
-- The organization behind one TalkTo account.
CREATE TABLE local_organizations (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 created_at TEXT NOT NULL
) STRICT;
CREATE TABLE local_memberships (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'pending', 'deleted')),
 role TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE (organization_id, user_id)
) STRICT;
CREATE INDEX local_memberships_user ON local_memberships(user_id, id);
-- Nothing is emailed: a pending invitation is accepted when its email first signs in.
CREATE TABLE local_invitations (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 email TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'revoked')),
 inviter_id TEXT NOT NULL,
 accepted_user_id TEXT,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX local_invitations_email ON local_invitations(email, state);
CREATE INDEX local_invitations_organization ON local_invitations(organization_id, id);
-- Membership and deletion changes, read in order by the minute sync like WorkOS's events.
CREATE TABLE local_identity_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 payload TEXT NOT NULL,
 created_at TEXT NOT NULL
);
