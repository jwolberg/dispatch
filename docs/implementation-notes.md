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

## 2026-06-11 — Import existing issues onto the board
**Why:** redeploy wiped the ephemeral SQLite DB (repos+tickets), and Dispatch had
no way to adopt existing GitHub issues — tickets were only ever created by filing
*new* issues via the app. So `jwolberg/situation` (and any tracked repo's existing
work) could never appear on the board.

**Decisions (confirmed with user):**
- Scope: import **all open issues** in a tracked repo, regardless of label (not
  just `dispatch`-labeled). The board acts as a general tracker for the repo.
- Trigger: **auto on track** (`POST /api/repos`) **+ ongoing** — the poller's
  idle cycle (5 min, also the boot kick) runs discovery across all repos so newly
  created issues appear without re-filing.

**Implementation:**
- New provider method `listOpenIssues(repo)` on the `GitProvider` seam; GitHub
  impl filters out PRs (GitHub returns PRs as issues); GitLab lists `state=opened`.
- `server/poller/discover.ts`: `discoverTickets(repo)` (idempotent — skips
  issue numbers already tracked for that repo) and `discoverAllRepos()`.
- Wired into `routes/repos.ts` (best-effort; a discovery failure does not fail
  the track) and `poller/scheduler.ts` `pollAll()`.

**Tradeoff / follow-up:** discovery adds one `listForRepo` call per repo per idle
cycle — fine at current scale. Does NOT survive a redeploy by itself (repos are
wiped too); durable fix is still a persistent `/data` volume per DEPLOY.md §4.
Re-tracking after a wipe now repopulates the board, which it previously did not.

## 2026-06-11 — Skill actions on a ticket (plan / implement / debug) + Queued→Building promote
**Mechanism background:** board columns are derived, never stored (`deriveColumn`).
Queued→Building only happens when `claude-code-action` starts a CI run, which is
triggered by an `@claude` mention (issue open, or a new issue_comment). There is
no column override — and shouldn't be (columns mirror provider reality). So the
honest "promote to Building" is to actually start the build by posting `@claude`.

**Decision (confirmed with user):** skills run **in CI via @claude** (not
server-side). Each skill button posts a tailored `@claude` comment that
claude-code-action picks up. Implement on a Queued ticket = the promote-to-
Building mechanism.

**Implementation:**
- `server/lib/skills.ts`: `SkillId` (plan|implement|debug), `skillPrompt()`
  (names the skill so the CI agent runs it if installed, degrades to prose;
  implement embeds the provider auto-close keyword `Fixes`/`Closes`),
  `defaultTarget()` (debug → PR when one exists, else issue).
- `POST /api/tickets/:id/skill` ({skill, note?, target?}) — posts the comment via
  the existing `postComment` seam, logs a `skill:<id>` activity event, reconciles.
- Web: `ticketsApi.skill()`, `SkillBar` component on the card detail (Implement
  highlighted; optional note box).

**Follow-up:** buttons live on the ticket detail only; a board-card quick
"Implement" could be added later. Whether `/plan` `/implement` `/debug` run as
real Claude Code skills depends on them being installed in the repo's
claude-code-action environment; prompts degrade to plain instructions otherwise.

## 2026-06-11 — CI skill templates + installer pushes them to target repos
**Why:** the console's Plan/Implement/Debug buttons post @claude comments that run
in CI, but claude-code-action only loads skills committed to the *target* repo
(not the laptop's ~/.claude, not gitignored files). The repo's existing
`.claude/skills/{plan,implement,debug}` are file-handoff skills (require
/docs/spec.md + /docs/BUILD_PLAN.md, write /docs/*.md, then STOP) — copying them
verbatim would break CI (they never open a PR).

**Decision (confirmed with user):** author CI-tuned skill templates and auto-
install them via the repo-setup script (not a verbatim copy, not plugin inputs).

**Implementation:**
- `scripts/repo-skills/{plan,implement,debug}/SKILL.md` — CI-tuned: plan posts a
  plan comment (no PR, no /docs/spec.md dependency); implement opens a PR/MR with
  the provider close keyword (Fixes/Closes #N); debug reproduces, pushes a minimal
  fix to the existing PR branch, comments the cause.
- `scripts/install-claude-action.sh` now also uploads each template to the target
  repo's `.claude/skills/<name>/SKILL.md` via the contents API (idempotent;
  updates in place by sha). Header/footer docs updated.

**To install on situation:** re-run the script with a write-scoped PAT:
`GH_SETUP_TOKEN=github_pat_xxx ./scripts/install-claude-action.sh jwolberg/situation`
(the read-only Dispatch token can't write Contents/Workflows/Secrets). Then click
Refresh context on the repo card.

**Follow-up:** each file is its own commit (per the existing workflow-commit
pattern); a git-tree batch would be tidier but adds complexity.

## 2026-06-11 — Card detail: "Next step" banner, run timestamps, freshness
**Why (user feedback):** after clicking Plan a ticket went to Building and showed
Workflow runs, but with no timestamp/summary (had to click through to GitHub) and
no sense of "where we are / what to do next."

**Changes (all in CardDetail):**
- `web/src/lib/time.ts` — shared `ago()` relative-timestamp helper.
- "Next step" banner (col-span-2, tone-colored) derived from column + PR/run/plan
  signals: Queued→"click Implement", Plan-posted→"review plan, then Implement",
  Building→"checks running, wait", Ready to test→"Preview & Ship", Blocked→"click
  Debug", Shipped→done. Gives the recommended next action without guessing.
- Workflow run rows now show colored state + run name + relative timestamp
  (`createdAt`), with full datetime on hover — no click-through needed.
- Top row shows "updated <ago>" from status_cache `updated_at` (freshness).

**Note:** "Next step" is heuristic (board columns are derived, not authoritative);
the Plan-ready case keys off a Claude/checkbox progress comment with no PR.

## 2026-06-11 — Cap each board column at 10 most-recent cards
**Why (user request):** show recently-completed items, n=10, per category — clarified
as per board column (cap EVERY column at its 10 most recent), with a "+N more" hint.

**Changes:**
- `board.ts`: draft cards now include `created_at` (sort key; tickets already had
  `updated_at`). `web/src/api/board.ts` DraftCard updated to match.
- `Board.tsx`: each column sorts its cards by recency desc (updated_at for tickets,
  created_at for drafts) and renders the top 10; the count badge still shows the
  true total, and a "+N more" line appears when truncated.

**Note:** display-only cap — the API still returns all cards so the per-column
total stays accurate. If the board grows large, move the cap server-side later.

## 2026-06-11 — BUG FIX: generated claude.yml ignored the @claude comment
**Symptom (live test on jwolberg/situation #1):** skill buttons posted @claude
comments (plan ×3, implement ×1); all 5 claude-code-action runs succeeded but
produced no PR, no branch, and no Claude comment — "nothing happened."

**Root cause:** install-claude-action.sh generated a workflow with a static
`prompt:` input. In claude-code-action v1, setting `prompt:` forces *automation
mode*, which runs that prompt headlessly and IGNORES the triggering @claude
comment. So Claude only ever got the trivial "include Fixes #N" note — never the
"use the implement skill / build this" instruction from the comment — and did
nothing (automation mode also posts no tracking comment, hence no visible reply).
Confirmed against official docs (code.claude.com/docs/en/github-actions,
claude-code-action README/examples/claude.yml, migration-guide).

**Fix:** remove `prompt:` from the generated workflow (enables interactive/mention
mode: reads the @claude comment, loads .claude/skills, posts a tracking comment,
opens a PR). Moved the standing "Fixes #N" convention to
`claude_args: --append-system-prompt`, which augments rather than overrides.

**To apply on an existing repo:** re-run the installer (it updates claude.yml in
place by sha), then re-trigger (@claude comment / Implement button).

## 2026-06-11 — Design: environments-gated staging (diagram only)
**Decision (confirmed with user):** insert a verify-before-prod stage using GitHub
Environments on a single `main` branch (not a staging branch / GitFlow).

**Pipeline (see docs/pipeline-architecture-diagram.html):**
- PR gets CI tests via the repo's own `on: pull_request` workflow (NOT
  claude-code-action) — this is what feeds the board's Building/Ready/Blocked.
- PR also gets a per-PR Preview env (existing).
- Merge → auto-deploy to a persistent **Staging** environment + smoke/e2e tests.
- **Production** deploy gated behind a manual approval on the GitHub "production"
  Environment.
- Board mapping (future): split Shipped → "In staging" → "Released".

**First step shipped:** updated the architecture diagram only (this commit).
**Next (not yet built):** ci.yml + deploy-staging.yml + deploy-production.yml
templates + installer wiring, and the new board state.

## 2026-06-11 — Slack notifications via Incoming Webhook
**Why (user request):** get notified in Slack. Chose a one-way Incoming Webhook
(no OAuth/bot) configured by env var — same pattern as the GitHub token / password.

**Implementation:**
- `server/lib/notify.ts`: `notifySlack(event)` POSTs `{text}` to `SLACK_WEBHOOK_URL`
  (no-op if unset). Fire-and-forget, never throws, emoji per activity type.
- Hooked into `insertActivity()` — the single choke point — so every activity
  event (issue filed, column changes, PR opened, steered, merged, skill runs) is
  mirrored. Activity is already change-only, so it's not per-poll noise.
- `SLACK_WEBHOOK_URL` added to the redaction key list (it's a secret).
- Documented in `.env.example`, README (env table + Slack section), DEPLOY.md
  (Secret Manager + `--set-secrets`).

**Notes:** webhook is channel-bound, not app-bound — any existing
`hooks.slack.com/services/…` webhook can be reused (routes to that channel).
Possible follow-up: filter to key events (Ready to test / Blocked / merged) if
the full feed is too chatty; and a one-message-per-ticket burst can occur on the
first poll after a DB wipe.

## 2026-06-11 — Architecture page in the console
**Why (user request):** view the pipeline diagram inside Dispatch.
- `web/public/pipeline.html` — copy of `docs/pipeline-architecture-diagram.html`
  (Vite copies web/public/* into the build; Express serves it at `/pipeline.html`).
  Keep the two in sync when the diagram changes.
- `web/src/pages/Architecture.tsx` — Page with an iframe to `/pipeline.html`
  (preserves the hand-tuned absolute layout instead of porting to JSX).
- Nav + route added in `App.tsx` (`/architecture`, label "Architecture").

## 2026-06-11 — Slack test ping verified
Sent a manual POST to the configured webhook; Slack returned `ok` (message posted
to the channel). Confirms SLACK_WEBHOOK_URL wiring end-to-end in production.
