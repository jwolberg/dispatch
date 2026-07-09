-- Dispatch local store (PRD §7 / ARCH §6).
-- The Git provider is the source of truth. `repos` + `tickets` rows plus the
-- provider API must fully reconstruct the board; every *_cache table below is
-- disposable. No derived state (board columns, PR linkage, check status) is
-- persisted here as authoritative.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repos (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  provider             TEXT NOT NULL,                    -- 'github' | 'gitlab'
  host                 TEXT,                             -- base URL for self-hosted (e.g. GitLab)
  path                 TEXT NOT NULL,                    -- owner/name or group/subgroup/project
  description          TEXT,
  web_url              TEXT,
  default_branch       TEXT,
  language             TEXT,
  preview_url_pattern  TEXT,
  merge_method         TEXT NOT NULL DEFAULT 'squash',
  claude_md_path       TEXT,                             -- optional override path to CLAUDE.md
  claude_md_cache      TEXT,                             -- disposable cache
  readme_excerpt_cache TEXT,                             -- disposable cache
  file_tree_cache      TEXT,                             -- disposable cache (JSON)
  automation_detected  INTEGER,                          -- 0/1, NULL = unknown
  context_refreshed_at TEXT,
  UNIQUE (provider, host, path)
);

CREATE TABLE IF NOT EXISTS chats (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,
  transcript_json TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'draft'          -- draft | filed
);

CREATE TABLE IF NOT EXISTS tickets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id      INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  chat_id      INTEGER REFERENCES chats(id) ON DELETE SET NULL,
  issue_number INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (repo_id, issue_number)
);

-- Disposable: rebuilt by the poller from the provider on first poll after a wipe.
-- ETags do NOT live here — they are per-repo/resource, not per-ticket. See http_cache.
CREATE TABLE IF NOT EXISTS status_cache (
  ticket_id     INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  payload_json  TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Disposable: HTTP conditional-request cache (ETag + the body it came with).
-- Keyed per provider endpoint+args (e.g. 'pulls.list:acme/widgets'), which is
-- per-repo/resource — NOT per-ticket. A 304 carries no body, so the body must be
-- stored alongside the etag or a cold-start 304 would replay `undefined`.
-- Wiping this table only costs one full re-fetch (T0-9).
CREATE TABLE IF NOT EXISTS http_cache (
  key        TEXT PRIMARY KEY,
  etag       TEXT NOT NULL,
  body_json  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Disposable: a human-readable trail derived from polled data (PRD F7).
CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  url         TEXT,
  occurred_at TEXT NOT NULL
);

-- NOT disposable (T1-9). Every other cache table here can be wiped for the cost
-- of a re-fetch; this one is the sole record that money was spent. Wiping it
-- resets DISPATCH_DAILY_BUDGET_USD to zero spent — it fails OPEN. Treat it like
-- `tickets`, not like `http_cache`.
--
-- ticket_id is SET NULL, not CASCADE: deleting a ticket must not erase the
-- spend it incurred, or the day's cap silently rises.
CREATE TABLE IF NOT EXISTS spend (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at                 TEXT NOT NULL,   -- ISO 8601, always UTC
  model                       TEXT NOT NULL,
  kind                        TEXT NOT NULL,   -- 'chat' | 'summary'
  ticket_id                   INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  input_tokens                INTEGER NOT NULL,
  output_tokens               INTEGER NOT NULL,
  cache_creation_input_tokens INTEGER NOT NULL,
  cache_read_input_tokens     INTEGER NOT NULL,
  usd                         REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spend_occurred_at ON spend(occurred_at);
CREATE INDEX IF NOT EXISTS idx_spend_ticket ON spend(ticket_id);
CREATE INDEX IF NOT EXISTS idx_activity_occurred_at ON activity(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_repo ON tickets(repo_id);
CREATE INDEX IF NOT EXISTS idx_chats_repo ON chats(repo_id);
