-- Access delivery versions are separate from immutable grants used by messages.
CREATE TABLE platform_access_versions (
 principal_key TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK(revision > 0)
) STRICT;
