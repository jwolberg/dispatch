# Build Plan

## Project
- Name: Dispatch — Feature-to-Production Orchestration Dashboard
- Summary: A local-first web app that takes a feature/bug idea from a chat-refined spec, through a one-click GitHub/GitLab issue with an `@claude` mention, to a live build/PR board, preview testing, and one-click ship to production. The Git provider is the single source of truth; Dispatch is a thin, provider-agnostic control plane that stores almost nothing.

## Source of Truth
- Spec: /docs/PRD-dispatch.md (v1.1) — used as the required spec (no `/docs/spec.md` present)
- Clarification reference: /docs/ARCHITECTURE.md (used only to clarify structure/boundaries, not to expand scope; takes the role `/docs/ux.md` would have)

## Planning Assumptions
- **No `/docs/spec.md` exists.** `PRD-dispatch.md` is the only spec-grade document and is explicitly "Ready for implementation," so it is treated as the spec. `ARCHITECTURE.md` is used for clarification only.
- The repo is currently empty (only `docs/` and `.claude/`). All scaffolding is greenfield; nothing to integrate with.
- "VOLSCAN conventions" referenced in the PRD/architecture are not available in this repo; frontend conventions follow the PRD's hard readability standards (§4) and the architecture's stated stack. Flagged as the only material ambiguity.
- TypeScript is assumed for both `server/` and `web/` (the architecture's file tree and `interface GitProvider` are written in TS).
- "GitHub issue" wording in some acceptance criteria is treated as provider-generic (issue on GitHub *or* GitLab) per the PRD's stated PR≡MR equivalence; provider-specific behavior lives only in adapters.

## Architecture Notes
- **Stack (from PRD §4 / ARCH §3–4):** React 18 + Vite + Tailwind v3 (dark) frontend on `:5173`; Express on Node 20 backend on `:3001` (Vite proxies `/api/*`); SQLite via `better-sqlite3` at `./data/dispatch.db`; Octokit (`@octokit/rest`) and `@gitbeaker/rest` provider SDKs; Anthropic Messages API (default model `claude-sonnet-4-20250514`, configurable).
- **Core seam (PRD F1a / ARCH §5):** all provider interaction flows through one `GitProvider` interface. SDK imports (`octokit`, `gitbeaker`) are permitted **only** inside `server/providers/`. This is enforced by grep (acceptance #12) and must stay green from Phase 1 onward.
- **Thin control plane / rebuild rule (PRD §7 / ARCH §6):** board columns, PR linkage, and check status are **derived, never persisted as authoritative**. `repos` + `tickets` rows + the provider API must fully reconstruct the board; all `*_cache` tables are disposable (acceptance #9).
- **Poller is sole writer** of `status_cache` and `activity`; routes only read those tables (ARCH §8). Cadence: 20s for repos with active tickets, 5min otherwise; ETag conditional requests; pause + banner when rate-limit remaining < 100.
- **Security constraints:** backend binds `127.0.0.1` only (refuse otherwise without `ALLOW_NONLOCAL=1`); secrets env-only, never sent to client, redacted in logs/errors; destructive actions (merge, untrack) require confirmation modals.
- **Readability is a hard requirement:** body ≥13px, caption/label ≥11.5px, all text ≥4.5:1 contrast; status colors always paired with icon/text, never color alone.
- **Explicit non-goals affecting implementation (PRD §2):** no multi-user/auth/roles, no public hosting, no in-app deep diff review (link out to provider), no local Agent SDK execution, no mobile-native app. Future items (webhooks, local test daemon, Agent SDK mode, cost telemetry) are out of scope but seams must not preclude them.

## Current Status
- Overall status: In Progress
- Current phase: Phase 1 — Skeleton
- Current ticket: P1-T2
- Blockers: None

---

## Phase Breakdown

### Phase 1 — Skeleton (PRD M1)
**Goal**
- Runnable two-process app (Express + Vite) with health check, the `GitProvider` seam + working GitHub adapter, repo discovery + registry, and context caching. Empty board state reachable.

**Exit Criteria**
- `npm install && npm run dev` brings up backend (`:3001`, localhost-bound) and SPA (`:5173`) concurrently (acceptance #1).
- `GET /api/health` returns token validity, rate-limit remaining, and DB status.
- Repos page lists all GitHub repos the token can access (path, description, last activity); **Track** adds one with zero typing; tracked repo card shows cached file-tree freshness timestamp (acceptance #2, #11-GitHub).
- No `octokit` import exists outside `server/providers/` (grep clean — acceptance #12 invariant established).
- UI meets readability standards from PRD §4 (acceptance #10 baseline).

**Tickets**
- P1-T1 — Monorepo scaffold + dev orchestration
  - Objective: Create `server/` and `web/` TS projects, root `package.json` with concurrent `dev` (Express + Vite proxy of `/api`), `.env`/`.env.example` (gitignored), localhost bind guard refusing non-local without `ALLOW_NONLOCAL=1`, Express bootstrap mounting routes.
  - Files likely involved: `package.json`, `server/index.ts`, `server/lib/env.ts`, `web/vite.config.ts`, `.env.example`, `.gitignore`
  - Depends on: none
  - Acceptance criteria covered: #1 (boot), S1 (bind guard)
  - Status: Complete

- P1-T2 — SQLite schema, migration, query modules
  - Objective: Implement `schema.sql` (repos, chats, tickets, status_cache, activity per PRD §7), `migrate.ts` that creates `./data/dispatch.db` on boot, and stub query modules. Encode the rebuild rule (no authoritative derived state).
  - Files likely involved: `server/db/schema.sql`, `server/db/migrate.ts`, `server/db/{repos,chats,tickets,status,activity}.ts`
  - Depends on: P1-T1
  - Acceptance criteria covered: #9 (data model foundation)
  - Status: Todo

- P1-T3 — GitProvider interface + DTOs + factory
  - Objective: Define `GitProvider` interface and normalized DTOs (`RepoSummary`, `RepoContext`, `IssueRef`, `PRRef`, `PRStatus`, `Run`, `MergeResult`) in `providers/types.ts`; factory `(provider, host) → GitProvider` in `providers/index.ts`. Establishes the seam before any SDK import exists.
  - Files likely involved: `server/providers/types.ts`, `server/providers/index.ts`
  - Depends on: P1-T1
  - Acceptance criteria covered: #12 (seam definition)
  - Status: Todo

- P1-T4 — GitHub adapter: discovery + context
  - Objective: Octokit-backed `discoverRepos()` (`GET /user/repos`, paginated, `pushed_at`) and `getRepoContext()` (description, depth-2 file tree via Git Trees API, CLAUDE.md, README first ~80 lines), plus automation detection (presence of a `claude` workflow file). Octokit imported only here.
  - Files likely involved: `server/providers/github.ts`, `server/lib/errors.ts`
  - Depends on: P1-T3
  - Acceptance criteria covered: #2, #11 (GitHub), #12
  - Status: Todo

- P1-T5 — Health route
  - Objective: `GET /api/health` reporting token validity (per configured provider tokens), rate-limit remaining, and DB status; secrets redacted.
  - Files likely involved: `server/routes/health.ts`, `server/lib/redaction.ts`
  - Depends on: P1-T2, P1-T4
  - Acceptance criteria covered: #1 (health check), S2
  - Status: Todo

- P1-T6 — Discover route
  - Objective: `GET /api/discover?provider=github` → adapter `discoverRepos()` normalized to `RepoSummary[]`.
  - Files likely involved: `server/routes/discover.ts`
  - Depends on: P1-T4
  - Acceptance criteria covered: #11 (GitHub)
  - Status: Todo

- P1-T7 — Repos registry routes + context cache
  - Objective: `GET/POST/DELETE /api/repos` (track/untrack with per-repo config: default branch, preview-URL pattern, merge method, CLAUDE.md path), manual-entry fallback validating token access, and `POST /api/repos/:id/refresh-context` writing the ≤6h-TTL context cache.
  - Files likely involved: `server/routes/repos.ts`, `server/db/repos.ts`
  - Depends on: P1-T4, P1-T2
  - Acceptance criteria covered: #2, #11
  - Status: Todo

- P1-T8 — Frontend scaffold + design tokens
  - Objective: Vite + Tailwind v3 dark theme; design tokens enforcing readability (body ≥13px, label ≥11.5px, ≥4.5:1 contrast, icon+text status colors); app shell with routing (Repos, Chat, Board, CardDetail, Activity) and typed `web/api/` fetch wrappers.
  - Files likely involved: `web/main.tsx`, `web/App.tsx`, `web/index.css`, `tailwind.config.js`, `web/api/client.ts`, `web/pages/*` (stubs)
  - Depends on: P1-T1
  - Acceptance criteria covered: #10
  - Status: Todo

- P1-T9 — Repos page UI
  - Objective: Discovery list with client-side search, provider badge, path, description, last activity; **Track** button (zero typing); tracked-repo cards (F1.4) showing description, structure summary, CLAUDE.md indicator, context-freshness timestamp; setup-warning state for repos lacking automation (F1.5); manual-entry fallback form.
  - Files likely involved: `web/pages/Repos.tsx`, `web/components/RepoCard.tsx`, `web/api/repos.ts`
  - Depends on: P1-T6, P1-T7, P1-T8
  - Acceptance criteria covered: #2, #11, #10
  - Status: Todo

### Phase 2 — Spec chat (PRD M2)
**Goal**
- Repo-scoped conversational spec refinement with streamed responses and a reliable Generate-ticket JSON flow with edit-before-file.

**Exit Criteria**
- A spec chat injects the repo's cached context into the system prompt and streams replies.
- Generate-ticket produces strict `{title, body_markdown, labels[]}` JSON that always parses across 10 consecutive generations (acceptance #3).
- User can edit title/body/labels in a preview modal before filing; transcript persists per draft.

**Tickets**
- P2-T1 — Anthropic client + prompt assembly
  - Objective: Messages API client (configurable model), system-prompt builder injecting `RepoContext` + the fixed F2.2 instruction block; retry-once-with-backoff on Anthropic errors (S4).
  - Files likely involved: `server/anthropic/client.ts`, `server/anthropic/prompts.ts`
  - Depends on: P1-T7 (context cache)
  - Acceptance criteria covered: #3 (foundation), S4
  - Status: Todo

- P2-T2 — Chat SSE proxy route
  - Objective: `POST /api/chat` streams an Anthropic turn to the client via SSE; persists the turn into the draft `chats` transcript.
  - Files likely involved: `server/routes/chat.ts`, `server/db/chats.ts`
  - Depends on: P2-T1, P1-T2
  - Acceptance criteria covered: (enables #3)
  - Status: Todo

- P2-T3 — Generate-ticket JSON flow
  - Objective: `POST /api/chat/:id/generate-ticket` requests strict JSON; backend strips code fences, validates, and **retries once with an error-correction prompt** on parse failure.
  - Files likely involved: `server/routes/chat.ts`, `server/anthropic/prompts.ts`
  - Depends on: P2-T2
  - Acceptance criteria covered: #3
  - Status: Todo

- P2-T4 — Chat page UI (streaming)
  - Objective: Repo-scoped chat page; SSE stream hook; never loses user-typed input on error (S4); shows one-clarifying-question cadence naturally.
  - Files likely involved: `web/pages/Chat.tsx`, `web/hooks/useChatStream.ts`, `web/api/chat.ts`
  - Depends on: P2-T2, P1-T8
  - Acceptance criteria covered: (enables #3), S4
  - Status: Todo

- P2-T5 — Generate-ticket preview/edit modal
  - Objective: Modal showing generated title/body/labels, fully editable before filing; "File ticket" hands off to Phase 3.
  - Files likely involved: `web/components/TicketPreviewModal.tsx`
  - Depends on: P2-T3, P2-T4
  - Acceptance criteria covered: #3, #4 (hand-off)
  - Status: Todo

### Phase 3 — File + board (PRD M3)
**Goal**
- File a real issue with the `dispatch` label and `@claude` trigger, then derive and render live board columns from provider state via the poller.

**Exit Criteria**
- Filing creates a real issue (spec + `dispatch` label + `@claude` mention + provider auto-close keyword); card appears in **Queued** (acceptance #4).
- When the Action runs, card moves to **Building** within 30s and renders the checkbox progress comment (acceptance #5).
- A failed run/check moves the card to **Blocked** with the failing check named (acceptance #8, partial).
- Deleting `data/dispatch.db` and restarting rebuilds non-draft cards from the provider alone (acceptance #9).

**Tickets**
- P3-T1 — Ticket filing route + adapter createIssue
  - Objective: Implement adapter `createIssue()` and `postComment()`; `POST /api/tickets` builds body = spec markdown + `@claude` line + provider auto-close keyword (injected by adapter), ensures `dispatch` label exists, stores `{issue_number, repo, chat_id}`, marks chat `filed`, navigates to board.
  - Files likely involved: `server/routes/tickets.ts`, `server/providers/github.ts`, `server/db/tickets.ts`
  - Depends on: P2-T5, P1-T4
  - Acceptance criteria covered: #4
  - Status: Todo

- P3-T2 — Adapter read methods for status
  - Objective: Implement `getIssue()`, `findLinkedPR()` (body `#<n>` or branch-name match), `getPRStatus()` (state, mergeable, checks), `getWorkflowRuns()`. Pure normalization into DTOs.
  - Files likely involved: `server/providers/github.ts`
  - Depends on: P3-T1
  - Acceptance criteria covered: #5, #8, #12
  - Status: Todo

- P3-T3 — Poller scheduler + reconcile
  - Objective: `scheduler.ts` (20s active / 5min idle) and `reconcile.ts` deriving the single column per ticket (PRD F4.1), recomputing PR linkage each poll, writing `status_cache` (with ETag map) and appending `activity` rows. Reconcile must be invocable independently of the scheduler (webhook-ready seam). Defensive against deleted/force-pushed/manually-closed (S6).
  - Files likely involved: `server/poller/scheduler.ts`, `server/poller/reconcile.ts`, `server/db/status.ts`, `server/db/activity.ts`
  - Depends on: P3-T2
  - Acceptance criteria covered: #5, #8, #9, S6
  - Status: Todo

- P3-T4 — Board route
  - Objective: `GET /api/board` returns all tickets with derived column + status payload read from `status_cache`; frontend renders only.
  - Files likely involved: `server/routes/board.ts`
  - Depends on: P3-T3
  - Acceptance criteria covered: #4, #9
  - Status: Todo

- P3-T5 — Card detail route
  - Objective: `GET /api/tickets/:id` assembling issue body, Claude progress comment, linked PR + per-check status, workflow run link, timestamps.
  - Files likely involved: `server/routes/tickets.ts`
  - Depends on: P3-T3
  - Acceptance criteria covered: #5, #8
  - Status: Todo

- P3-T6 — Board UI (kanban)
  - Objective: Columns Spec/Queued/Building/Ready to test/Shipped/Blocked; cards with status chips (icon+text); polling refetch hook; Spec column shows local drafts.
  - Files likely involved: `web/pages/Board.tsx`, `web/components/{BoardColumn,TicketCard,StatusChip}.tsx`, `web/hooks/usePolling.ts`
  - Depends on: P3-T4, P1-T8
  - Acceptance criteria covered: #4, #5, #8, #10
  - Status: Todo

- P3-T7 — Card detail UI
  - Objective: Card detail view rendering issue body, progress comment with live checkboxes (markdown), linked PR with per-check status, run link, transcript link.
  - Files likely involved: `web/pages/CardDetail.tsx`, `web/components/CheckList.tsx`
  - Depends on: P3-T5, P3-T6
  - Acceptance criteria covered: #5, #8, #10
  - Status: Todo

### Phase 4 — Test + ship (PRD M4)
**Goal**
- Preview testing, mid-build steering, and gated one-click merge that drives the card to Shipped, plus the activity feed.

**Exit Criteria**
- Ready-to-test card shows a working Preview button + per-check statuses (acceptance #6).
- Ship merges the PR, the issue auto-closes, and the card reaches **Shipped** without manual refresh (acceptance #7).
- A Steer comment containing `@claude` re-triggers the workflow (acceptance #8 completion).
- Activity feed shows the most recent 50 cross-ticket events (F7).

**Tickets**
- P4-T1 — Preview button + live URL detection
  - Objective: Render Preview from repo `preview_url_pattern` with PR number substituted; prefer a live URL parsed from deployments/statuses/bot comments when present (F5.1–F5.2). Per-check list links to provider pages (F5.3).
  - Files likely involved: `web/components/PreviewButton.tsx`, `server/providers/github.ts` (deployment/status parsing), `web/pages/CardDetail.tsx`
  - Depends on: P3-T7, P3-T2
  - Acceptance criteria covered: #6
  - Status: Todo

- P4-T2 — Steer comment
  - Objective: `POST /api/tickets/:id/comment` posts to issue or PR via adapter `postComment()`; UI text box on the card.
  - Files likely involved: `server/routes/tickets.ts`, `web/components/SteerBox.tsx`
  - Depends on: P3-T5
  - Acceptance criteria covered: #8
  - Status: Todo

- P4-T3 — Ship/merge flow
  - Objective: Adapter `mergePR(method)`; `POST /api/tickets/:id/merge` enabled only when PR open + required checks green + mergeable; confirmation modal (repo, PR title, diff stats, target branch); surface provider merge errors verbatim with PR link (F6.4); destructive-action confirmation (S5).
  - Files likely involved: `server/routes/tickets.ts`, `server/providers/github.ts`, `web/components/ShipConfirmModal.tsx`
  - Depends on: P3-T5, P3-T2
  - Acceptance criteria covered: #7, S5
  - Status: Todo

- P4-T4 — Post-merge → Shipped + prod deploy surfacing
  - Objective: After merge, poller surfaces the production deploy run on the card until complete, then derives column **Shipped** (issue auto-closed via keyword).
  - Files likely involved: `server/poller/reconcile.ts`, `web/pages/CardDetail.tsx`
  - Depends on: P4-T3, P3-T3
  - Acceptance criteria covered: #7
  - Status: Todo

- P4-T5 — Activity feed
  - Objective: `GET /api/activity` (most recent 50 derived events) + reverse-chronological feed UI.
  - Files likely involved: `server/routes/activity.ts`, `web/pages/Activity.tsx`
  - Depends on: P3-T3
  - Acceptance criteria covered: (F7) — supports #5/#7/#8 traceability
  - Status: Todo

### Phase 5 — GitLab adapter (PRD M5)
**Goal**
- A second `GitProvider` implementation so GitHub and GitLab repos coexist on one board with no provider-specific code outside `providers/`.

**Exit Criteria**
- A GitLab project completes the full loop (file → build → MR → ship) through the same UI (acceptance #12).
- `grep` for `gitbeaker` (and `octokit`) imports outside `server/providers/` returns nothing (acceptance #12).

**Tickets**
- P5-T1 — GitLab adapter implementation
  - Objective: `gitbeaker`-backed `GitProvider`: discovery (`/projects?membership=true&order_by=last_activity_at`), context (Repository Tree API), issues/MRs/pipelines/jobs normalized to the same DTOs, `Closes #n` auto-close keyword, self-hosted base URL via `GITLAB_HOST`. Wire into the factory.
  - Files likely involved: `server/providers/gitlab.ts`, `server/providers/index.ts`
  - Depends on: P4-T4 (GitHub loop complete as the reference behavior)
  - Acceptance criteria covered: #11 (GitLab), #12
  - Status: Todo

- P5-T2 — Mixed-provider verification + seam guard
  - Objective: Verify a GitLab project ships end-to-end through the unchanged UI; add the grep check (CI or npm script) asserting no SDK imports leak outside `providers/`.
  - Files likely involved: `package.json` (lint/grep script), `docs/implementation-notes.md`
  - Depends on: P5-T1
  - Acceptance criteria covered: #12
  - Status: Todo

### Phase 6 — Hardening (PRD M6)
**Goal**
- Production-grade resilience, security, docs, and a full acceptance pass.

**Exit Criteria**
- Rate-limit handling pauses polling + shows banner < 100 remaining; footer shows remaining budget (S3).
- All of S1–S6 verified; README setup guide complete (§8).
- All 12 acceptance criteria pass, including the db-wipe rebuild and readability spot-check.

**Tickets**
- P6-T1 — Rate-limit + ETag hardening
  - Objective: ETag conditional requests across adapters; honor `Retry-After`/secondary limits with exponential backoff; pause poller + UI banner when remaining < 100; footer shows remaining (S3).
  - Files likely involved: `server/lib/ratelimit.ts`, `server/lib/etagStore.ts`, `server/poller/scheduler.ts`, `web/components/RateLimitBanner.tsx`
  - Depends on: P3-T3
  - Acceptance criteria covered: S3
  - Status: Todo

- P6-T2 — Security finalization
  - Objective: Confirm localhost bind guard (S1), end-to-end secret redaction in logs/errors and never-to-client (S2), confirmation modals on all destructive actions (merge, untrack) (S5).
  - Files likely involved: `server/lib/redaction.ts`, `server/index.ts`, `web/components/*Modal.tsx`
  - Depends on: P1-T1, P4-T3
  - Acceptance criteria covered: S1, S2, S5
  - Status: Todo

- P6-T3 — Resilience finalization
  - Objective: Anthropic retry-once + input preservation (S4); poller defensive reconciliation against deleted issues, force-pushed branches, manually merged/closed PRs (S6).
  - Files likely involved: `server/anthropic/client.ts`, `server/poller/reconcile.ts`
  - Depends on: P2-T1, P3-T3
  - Acceptance criteria covered: S4, S6
  - Status: Todo

- P6-T4 — README setup guide
  - Objective: Document GitHub setup (`/install-github-app`, workflow triggers/permissions/timeout, PAT scopes), GitLab beta setup (`.gitlab-ci.yml` Claude job, masked var, PAT `api`, `GITLAB_HOST`), preview-deploy prerequisite, `.env`, and `npm install && npm run dev` (§8).
  - Files likely involved: `README.md`
  - Depends on: P5-T1
  - Acceptance criteria covered: #1 (fresh-clone path)
  - Status: Todo

- P6-T5 — Acceptance pass
  - Objective: Walk all 12 acceptance criteria; run the 10× generate-ticket parse test (#3), the db-wipe rebuild test (#9), the readability contrast spot-check (#10), and the GitLab full-loop + grep guard (#12). Record results in implementation notes.
  - Files likely involved: `docs/implementation-notes.md`
  - Depends on: P6-T1, P6-T2, P6-T3, P6-T4
  - Acceptance criteria covered: #1–#12
  - Status: Todo

---

## Dependency Order
1. P1-T1
2. P1-T2
3. P1-T3
4. P1-T4
5. P1-T5
6. P1-T6
7. P1-T7
8. P1-T8
9. P1-T9
10. P2-T1
11. P2-T2
12. P2-T3
13. P2-T4
14. P2-T5
15. P3-T1
16. P3-T2
17. P3-T3
18. P3-T4
19. P3-T5
20. P3-T6
21. P3-T7
22. P4-T1
23. P4-T2
24. P4-T3
25. P4-T4
26. P4-T5
27. P5-T1
28. P5-T2
29. P6-T1
30. P6-T2
31. P6-T3
32. P6-T4
33. P6-T5

## Recommended Next Step
- Start with: **P1-T1 — Monorepo scaffold + dev orchestration**
- Why this is first: It is the only ticket with no dependencies and unblocks everything else. It establishes the two-process dev loop, the localhost bind guard (S1), and the `.env` discipline — the runnable foundation that acceptance #1 requires and that every subsequent ticket builds on.

## Deferred / Out of Scope
- Multi-user support, auth, or roles (PRD §2 — single operator on localhost).
- Hosting Dispatch on the public internet.
- In-app deep diff/code review (link out to provider UI).
- Running Claude Code locally via the Agent SDK (Actions/CI runner does the coding).
- Mobile-native app (responsive web only).
- Future items, seams preserved but not built: webhook ingestion (replacing polling), local test daemon, Agent SDK mode, per-ticket cost telemetry (PRD §10 / ARCH §15).

## Update Rules
After each implementation pass:
- Update ticket status only as Todo / In Progress / Complete / Blocked
- Update Current Status (phase, ticket, blockers)
- Record blockers briefly
- Set the next recommended ticket
- Do NOT add new scope unless the spec (PRD) changes
