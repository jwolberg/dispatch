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

## 2026-06-11 — Phase 5 (GitLab adapter)
- **GitLab adapter** built on @gitbeaker/rest; method signatures validated against gitbeaker's bundled types (a real safety net — wrong method names/args fail typecheck). Notable gitbeaker quirks handled: `Issues.show(issueId, {projectId})` (issueId-first) vs `Issues.create(projectId, title, opts)` (projectId-first); `Projects.all` with `last_activity_at` needs keyset pagination, so we fetch by membership and sort client-side; `MergeRequests.accept` is the merge endpoint.
- **GitLab limitations vs GitHub adapter:** MR diffstat (additions/deletions/changedFiles) left null to avoid extra calls; preview URL detection not implemented for GitLab (pattern fallback still works); primary language omitted from discovery.
- **Seam guard** is now a runnable check (`npm run check:seam`, also in `npm run verify`) — asserts acceptance #12 (no @octokit/@gitbeaker outside server/providers/).
- **Deferred (needs your access):** the live GitLab full-loop verification (acceptance #12 end-to-end) requires a GITLAB_TOKEN and a GitLab project with the Claude CI/CD job configured. Code + typecheck + seam guard are green; the live loop is unverified.

## 2026-06-11 — P6-T1 (rate-limit safety)
- **S3 implemented:** shared rate-limit gauge (`lib/ratelimit.ts`); the poller refreshes it each cycle via GitHub's free `/rate_limit` endpoint and pauses polling when remaining < 100; 429/secondary-limit errors set a backoff via Retry-After. Health exposes the gauge; UI shows a banner (App) + remaining in the footer.
- **ETag conditional requests: deferred (optimization).** The `status_cache.etag_map_json` column exists, but wiring `If-None-Match`/304 handling into each adapter call is invasive and unverifiable without live traffic. Rate-limit *safety* (the user-visible S3 requirement) is fully implemented; ETag-based conservation is a follow-up. Documented rather than silently skipped.

## 2026-06-11 — P6-T5 (acceptance pass)
Verified locally (no external services needed):
- **#1** fresh `npm install && npm run dev` → SPA 200, health 200, empty board ✅
- **#9** db rebuild: derived tables (`status_cache`, `activity`) are disposable and repopulate from the provider on the next poll; `repos`+`tickets` persist (ARCH §6). Cache-wipe test confirmed survivors + cleared cache ✅
- **#10** readability floors present (body 13px, label 11.5px; status colors paired with icon+text) ✅ — devtools contrast spot-check is a manual step
- **#12** seam guard green (`npm run check:seam`) — no @octokit/@gitbeaker outside server/providers/ ✅
- Cross-cutting unit/integration tests: deriveColumn (9 cases), PR-linkage boundaries, ticket-JSON parser robustness, board + card-detail + merge-gate integration ✅

Deferred — need live credentials/infra to confirm end-to-end (code paths implemented + typechecked):
- **#2, #11** discovery/track/list — need `GITHUB_TOKEN` (and `GITLAB_TOKEN` for GitLab)
- **#3** 10× generate-ticket parse run — needs `ANTHROPIC_API_KEY` (parser robustness already verified)
- **#4–#8** file → Building → Ready-to-test → Ship → Blocked/Steer — need a token + a repo with `claude-code-action` configured
- **#12 (full loop)** a GitLab project completing file→build→MR→ship — needs `GITLAB_TOKEN` + an instance with the Claude CI job

Note on #9 wording: the PRD says "delete data/dispatch.db … rebuild from GitHub alone." Per ARCH §6 (the implementation reference), `repos`+`tickets` are the non-disposable seed and the `*_cache` tables rebuild from the provider. Deleting the whole file also drops repos+tickets (you'd re-track); the implemented guarantee is that all *derived* state is disposable and repopulates.

## 2026-06-11 — UI tweaks (Board title, nav order, Activity grouping)
- **Board h1** → "Automated Workflow Tracking Board" (via `Page title`); nav reordered to
  Tracking Board, Spec Chat, Activity, Repo Config (relabeled "Repos"→"Repo Config",
  "Spec chat"→"Spec Chat").
- **Activity grouping (repo → task):** activity rows carry no repo/task fields, so
  `recentActivity()` now LEFT JOINs tickets→repos and status_cache to surface
  `repo_path`, `issue_number`, and `task_title` (parsed from `status_cache.payload_json`
  `issue.title`). Decision: task label = `#<issue_number> · <title>`; events with a null
  `ticket_id`/repo fall back to "General" task under an "Unassigned" repo group. Joins are
  LEFT so unlinked/uncached events still render. Ordering preserved by relying on the
  existing newest-first sort + Map insertion order (no extra sort).
