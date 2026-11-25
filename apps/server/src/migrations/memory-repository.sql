-- Swarm memory on Cloudflare Artifacts (docs/swarm-server-spec.md, 14; November 25, 2026). One Git
-- repository per swarm server holds the memory; these tables hold only what TalkTo needs beside it:
-- the repository's name and remote, the last good head and its Markdown files (the cache claims are
-- served from), the commits already posted to the memory channel, and the Git tokens TalkTo granted.
--
-- An additive extension like board.sql: created if absent on every upgrade, leaving
-- schema_migrations at its current version, so a rolled-back Worker still opens the server and
-- ignores these tables. No foreign keys and no triggers: a rolled-back Worker's pruning and erasing
-- never meet them. The notes memory these replace (memory.sql, never in production) left its own
-- tables behind on staging; nothing reads or writes them.

-- One row once TalkTo first set memory up; no row means it never did. Memory has no switch (owner,
-- November 25, 2026): every swarm server gets it at its first claim, read or context.
CREATE TABLE IF NOT EXISTS memory_repository (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  -- Written 1 and never read since memory has no switch; a 0 left by the old switch is ignored.
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  tokens INTEGER NOT NULL CHECK (tokens BETWEEN 500 AND 4000),
  -- The Artifacts repository (mem-<serverId>) and its remote, as create or fork returned it.
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  remote TEXT NOT NULL CHECK (length(remote) BETWEEN 1 AND 500),
  -- The swarm server whose memory this one was forked from, or null when it started from the template.
  source_server_id TEXT,
  -- 1 once main has a first commit: the template, or the fork's history.
  seeded INTEGER NOT NULL DEFAULT 0 CHECK (seeded IN (0, 1)),
  -- The memory channel, and the server creator's person participant, which sends the lines no single
  -- agent wrote (null until the creator has a participant on the server).
  channel_id TEXT,
  poster_id TEXT,
  poster_grant_id TEXT,
  -- The last head of main TalkTo accepted: memory_files hold its files. Null before the first read.
  good_head TEXT CHECK (good_head IS NULL OR length(good_head) = 40),
  -- When TalkTo last read main's head (epoch ms), so claims read it at most every 30 seconds.
  checked_at INTEGER NOT NULL DEFAULT 0,
  -- Until when the organization's memory edits for the month are spent: memory is read-only.
  capped_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  changed_by_participant_id TEXT,
  changed_at INTEGER NOT NULL CHECK (changed_at >= 0)
) STRICT;

-- The Markdown files of good_head that TalkTo serves: at most 200, each at most 32 KB.
CREATE TABLE IF NOT EXISTS memory_files (
  path TEXT PRIMARY KEY CHECK (length(path) BETWEEN 1 AND 400),
  blob TEXT NOT NULL CHECK (length(blob) = 40),
  text TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  -- Labels from the file's front matter, as a JSON array of strings.
  labels TEXT NOT NULL DEFAULT '[]'
) STRICT;

-- Each commit TalkTo found on main, posted once to the memory channel. A post's message ID is null
-- when it could not be posted (no channel); metered is 0 when the organization's messages were spent.
CREATE TABLE IF NOT EXISTS memory_commits (
  hash TEXT PRIMARY KEY CHECK (length(hash) = 40),
  subject TEXT NOT NULL,
  message_id TEXT,
  usage_id TEXT,
  metered INTEGER NOT NULL CHECK (metered IN (0, 1)),
  found_at INTEGER NOT NULL CHECK (found_at >= 0)
) STRICT;

-- Every Git token TalkTo granted for memory: never the token itself, only the store's ID to revoke
-- it. A write token names the claim it belongs to and is revoked when that claim ends.
CREATE TABLE IF NOT EXISTS memory_tokens (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  token_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  task_id TEXT,
  epoch INTEGER,
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= issued_at),
  -- When TalkTo revoked it at the store; null while live or past expiry without a revocation.
  revoked_at INTEGER,
  -- When TalkTo read main's head after the token could no longer push (revoked or expired).
  settled_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS memory_tokens_participant ON memory_tokens(participant_id, scope, issued_at);
CREATE INDEX IF NOT EXISTS memory_tokens_unsettled ON memory_tokens(settled_at, expires_at);
