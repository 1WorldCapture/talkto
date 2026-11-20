-- User-scoped navigation progress; no authority or client credentials live here.
CREATE TABLE user_onboarding (
 user_id TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK(revision > 0),
 state TEXT NOT NULL CHECK(json_valid(state)),
 updated_at TEXT NOT NULL
) STRICT;
