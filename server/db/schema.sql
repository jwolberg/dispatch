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

-- Disposable: the plain-language change summary shown above the fold (T1-5).
-- Keyed by head_sha so a force-push invalidates it rather than describing code
-- that no longer exists. Wiping it costs exactly one re-summarize per open card.
-- CASCADE (unlike `spend` below): this table records no money, only prose.
CREATE TABLE IF NOT EXISTS summary_cache (
  ticket_id    INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  head_sha     TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at   TEXT NOT NULL
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

-- CONFIDENTIAL (#2). A third axis, orthogonal to the disposable/irreplaceable one
-- this file reasons about above: these two tables are the only ones whose
-- *contents* are a credential.
--
-- It matters because snapshot.ts does `VACUUM INTO` and uploads the resulting
-- bytes to GCS, and DEPLOY.md enables object versioning on purpose — so anything
-- written here in plaintext stays readable in an old object version until a
-- lifecycle rule expires it (ADR-0006 [6.2]). Every `*_enc` column below is an
-- AES-256-GCM envelope from lib/crypto.ts, keyed by DISPATCH_ENCRYPTION_KEY.
-- Nothing writes a bare secret to this table. Not disposable, not rebuildable:
-- losing it means re-registering the App.
--
-- Singleton: Dispatch is deployed per-operator and each deployment registers its
-- own App (ADR-0006 [5]). There is no central Dispatch App to be one row among many.
CREATE TABLE IF NOT EXISTS github_app (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  app_id             INTEGER NOT NULL,
  slug               TEXT NOT NULL,
  name               TEXT NOT NULL,
  client_id          TEXT NOT NULL,
  client_secret_enc  TEXT NOT NULL,
  private_key_enc    TEXT NOT NULL,
  webhook_secret_enc TEXT NOT NULL,
  html_url           TEXT,
  created_at         TEXT NOT NULL
);

-- CONFIDENTIAL by association: no secret of its own, but it is the map from a
-- repo to the credential above. `repos_json` is the repo selection GitHub granted
-- at install time; it goes stale when the operator edits the selection on
-- github.com, and #17's webhooks are what will keep it fresh.
CREATE TABLE IF NOT EXISTS installations (
  installation_id      INTEGER PRIMARY KEY,
  account_login        TEXT NOT NULL,
  account_type         TEXT,                            -- 'User' | 'Organization'
  repository_selection TEXT NOT NULL DEFAULT 'all',     -- 'all' | 'selected'
  repos_json           TEXT NOT NULL DEFAULT '[]',      -- ["owner/name", ...]
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_installations_account ON installations(account_login);
CREATE INDEX IF NOT EXISTS idx_spend_occurred_at ON spend(occurred_at);
CREATE INDEX IF NOT EXISTS idx_spend_ticket ON spend(ticket_id);
CREATE INDEX IF NOT EXISTS idx_activity_occurred_at ON activity(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_repo ON tickets(repo_id);
CREATE INDEX IF NOT EXISTS idx_chats_repo ON chats(repo_id);
