---
id: 23
title: "UNIQUE (provider, host, path) never dedupes GitHub repos — every Track click inserts a row"
status: closed
priority: high
horizon: now
hitl: false
type: bug
source: manual observation while verifying #22
created: 2026-07-10
updated: 2026-07-09
prs: []
refs:
  - "server/db/repos.ts"
  - "server/db/migrate.ts"
  - "server/routes/repos.ts"
depends_on: []
acceptance:
  - "Tracking the same GitHub repo twice returns a clear duplicate error (or is idempotent), never a second row"
  - "A migration collapses existing duplicate rows, keeping the lowest id, and re-points any child rows (tickets, status_cache) at it"
  - "A regression test inserts the same (provider, NULL host, path) twice and asserts exactly one row survives"
  - "GitLab repos (non-null host) keep their existing behavior"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

`repos` declares `UNIQUE (provider, host, path)`. For GitHub repos `host` is
always `NULL`, and **SQLite treats `NULL` as distinct from every other `NULL`
inside a UNIQUE index**, so the constraint never fires. `insertRepo()` is a plain
`INSERT`, so every click of **Track** on the same repo appends another row.

Observed 2026-07-10 on a live db: `jwolberg/dispatch` present as both id 10 and
id 12, `host IS NULL` on both. The `repos` autoincrement had climbed to 12 for
what the operator experienced as two or three distinct repos.

Reduced:

```sql
CREATE TABLE t(a TEXT, b TEXT, c TEXT, UNIQUE(a,b,c));
INSERT INTO t VALUES('github', NULL, 'x/y');  -- ok
INSERT INTO t VALUES('github', NULL, 'x/y');  -- ok  ← should have failed
INSERT INTO t VALUES('github', '',   'x/y');  -- ok
INSERT INTO t VALUES('github', '',   'x/y');  -- UNIQUE constraint failed
```

Only the empty-string pair collides. `NULL` never does.

## Why it matters

- The board and Discover both key off `provider:path`. Duplicate rows mean a repo
  can sit in the Tracked list twice, and `trackedPaths` filtering in
  `web/src/pages/Repos.tsx` is computed from whatever `GET /api/repos` happens to
  return.
- The poller reconciles per ticket → per repo. Duplicated repos mean duplicated
  provider calls against the same path, burning rate limit for nothing.
- `POST /api/repos` looks successful (201) when it should be a 409. The operator
  gets no signal that anything is wrong.

## Resolution — 2026-07-10

Chosen semantics: **idempotent 200**, not 409. Re-tracking is a no-op that returns
the existing row and refreshes its cached context (a re-track is how an operator
asks for fresh context, and the route has already paid for the fetch).

- `migrateRepoIdentity()` in `server/db/migrate.ts` — collapses duplicates
  (keep `MIN(id)`, re-point `tickets` with `UPDATE OR IGNORE` because of
  `UNIQUE (repo_id, issue_number)`, re-point `chats`, delete the losers so the
  cascade sweeps anything that could not move), then creates
  `idx_repos_identity ON repos (provider, COALESCE(host, ''), path)`. Runs every
  boot, idempotent.
- `findRepoByIdentity()` in `server/db/repos.ts` matches the same `COALESCE` shape.
- `POST /api/repos` returns 200 + existing row, 201 on create. A constraint
  failure is re-checked against the index before being rethrown, closing the race
  between two submits that both miss the first lookup.

The table-level `UNIQUE (provider, host, path)` is left in place: SQLite has no
`DROP CONSTRAINT`, and it still guards GitLab's non-null host.

Verified on the live database: `idx_repos_identity` present after restart, two
successive re-tracks of `jwolberg/dispatch` both return 200 with id 10, row count
unchanged. `npm run verify` green — 506 tests (was 496).

## Suggested fix

An expression index dedupes `NULL` correctly, and SQLite supports it:

```sql
CREATE UNIQUE INDEX idx_repos_identity ON repos (provider, COALESCE(host, ''), path);
```

The migration must first collapse existing duplicates (keep the lowest `id`,
re-point `tickets.repo_id` / `status_cache` at it, delete the rest), or the index
creation fails. Then either return **409** from `POST /api/repos` on conflict, or
make the route idempotent and return the existing row — pick one and say which in
the PR.

Note the table-level `UNIQUE (provider, host, path)` cannot simply be dropped:
SQLite has no `DROP CONSTRAINT`. Leave it (it still guards GitLab's non-null host)
and add the index alongside.

## Not this ticket

The `⚠ No Claude automation detected` banner is **correct behavior**, not a bug —
`detectAutomation()` reports that a tracked repo has no `claude-code-action`
workflow. It renders on a card in the Tracked list, so it only appears once a repo
is already tracked. It reads like a tracking failure; a copy change may be worth a
separate ticket.
