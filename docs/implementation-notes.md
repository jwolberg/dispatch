# Implementation Notes

Running log of decisions, deviations, and tradeoffs for human review.

## 2026-06-11 — P1-T1 (Skeleton: scaffold + dev orchestration)
- **No `/docs/spec.md`.** Treated `PRD-dispatch.md` as the spec and `ARCHITECTURE.md` as structural clarification (matches BUILD_PLAN assumption). No scope added.
- **Single root `package.json`** (not workspaces) running both `server/` and `web/` via `concurrently`. Simplest for a single local app.
- **Backend run with `tsx`** (no dev build step); **Vite config kept at `web/vite.config.ts`** and referenced explicitly via `dev:web: vite --config web/vite.config.ts` — Vite otherwise looks for the config in cwd (project root) and silently ran with defaults (no proxy / wrong root). Caught during validation.
- **`/api/ping` placeholder** added so the dev loop is verifiable at boot; it is a stand-in for the real `/api/health` (P1-T5), not part of the spec API surface.
- **Node 22 local; `engines` pinned `>=20`** per PRD without forcing a downgrade.
- **Deferred (by ticket boundary, not omission):** Tailwind/app-shell/routing (P1-T8), SQLite (P1-T2), provider seam (P1-T3/T4).
- **Follow-up:** This is not a git repository, so the per-ticket commit rule could not be applied. Initialize git before continuing if commit-per-ticket is desired.

## 2026-06-11 — P1-T2..T4 (DB, provider seam, GitHub adapter)
- **DB ids:** integer autoincrement PKs; `repos` unique on `(provider, host, path)`, `tickets` unique on `(repo_id, issue_number)`. WAL + `foreign_keys=ON`. `DISPATCH_DB_PATH` env override added for tests.
- **Provider seam:** all `GitProvider` methods are async (every call is network). `autoCloseKeyword()` lives in the seam so the core never branches on provider for ship semantics.
- **GitHub adapter (P1-T4):** implemented `discoverRepos` (`paginate GET /user/repos`, sort=pushed) and `getRepoContext` (repo meta + CLAUDE.md + README first 80 lines + depth-2 file tree via Git Trees recursive, filtered to ≤2 path segments, capped 400 + automation detection via `.github/workflows` filename/content match on claude-code-action/@claude). Remaining `GitProvider` methods are explicit stubs that throw with their owning ticket id (P3/P4) — keeps the class type-complete without expanding P1-T4 scope.
- **Deferred validation:** live GitHub API calls require a real `GITHUB_TOKEN` (not in env; `gh` not authenticated). Validated instead by typecheck, the seam grep (clean), and a factory structural check (missing-token throw + construction). Live discovery/context to be exercised in P1-T6/P1-T9 once a token is provided.

## 2026-06-11 — P1-T8/T9 + P2-T1 (frontend scaffold, Repos UI, Anthropic client)
- **Web imports use `.js` extensions** pointing at `.tsx`/`.ts` sources — Vite/esbuild resolves them (verified by `vite build`), matching the server's NodeNext-style imports. Consistent across the codebase.
- **Confirmation modal built in P1-T9** (reused for ship later) to satisfy S5 for untrack, rather than `window.confirm`.
- **Automation setup warning** links to the anthropics/claude-code-action README for now; will repoint to the app README once P6-T4 writes it.
- **Anthropic model default = `claude-sonnet-4-20250514`** per PRD §4 (the spec explicitly chose this), overridable via `ANTHROPIC_MODEL`. The general "use opus-4-8" guidance is overridden here by the spec's stated default. Thinking is left unset (off) to stay model-agnostic across whatever model is configured.
- **S4 retry** implemented in the Anthropic client (`createMessage`): one retry with backoff on RateLimit/5xx; streaming path leaves retry to the route (P2-T2) so typed input is preserved.
- **Deferred validation:** live Anthropic calls need `ANTHROPIC_API_KEY` (not set); validated via typecheck + structural checks (prompt assembly, no-key guard).

## 2026-06-11 — Phase 3/4 (board, poller, ship)
- **Column derivation** is pure (`deriveColumn`) and unit-tested (9 cases); Shipped/Blocked take precedence over in-flight states. Just-filed tickets with no cache yet default to Queued in the board route.
- **Run context (F6.3):** reconcile fetches runs on the PR head branch while building, and on the default branch once shipped (the production deploy) so the card surfaces the deploy run. Given the fixed 6-column set, a merged ticket goes straight to Shipped (acceptance #7) and the deploy run is shown in the card detail rather than introducing a "Deploying" column.
- **Preview URL (F5.2):** detected from deploy-ish commit statuses + deployment status environment URLs; free-text bot-comment scraping skipped to bound API calls. Pattern fallback (`{n}`) always available.
- **ETags (F4.2/S3):** status_cache stores an etag map (currently empty); conditional-request plumbing is P6-T1.
- **Deferred validation:** the full live loop (file → build → PR → ship) needs a real GITHUB_TOKEN and a repo with claude-code-action configured. Validated so far via typecheck, seam guard, unit tests (deriveColumn, PR-linkage, ticket parser), and seeded integration tests (board, card detail, merge gate).
