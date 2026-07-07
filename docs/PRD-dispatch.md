# PRD — "Dispatch": Feature-to-Production Orchestration Dashboard

**Version:** 1.1 — adds repo discovery + GitHub/GitLab provider abstraction
**Owner:** Jay
**Status:** Ready for implementation
**Intended builder:** Claude Code

---

## 1. Overview

Dispatch's model is a structured web UI wrapping a Git provider as the source of truth: chat → AI-drafted ticket → poller-computed kanban. It lets a solo developer take a feature idea or bug report from rough description to production deploy without leaving one browser tab, orchestrating three external systems — the Claude API (spec refinement), the Git provider (**GitHub or GitLab**: issues, CI, pull/merge requests), and the existing deploy pipeline (PR previews + merge-triggered CI/CD) — while keeping **the Git provider as the single source of truth** for all work-item state. Dispatch stores almost nothing itself.

All provider interaction goes through a **provider adapter interface** (§5.5) so GitHub and GitLab repos coexist on one board. Throughout this document, "PR" means pull request (GitHub) or merge request (GitLab) interchangeably.

### Core loop

1. Describe a feature/bug in a chat UI → converse with Claude to refine it into a spec
2. One click files a GitHub issue containing the spec and an `@claude` mention
3. The `anthropics/claude-code-action` workflow picks it up, builds the change on a runner, opens a PR
4. Dispatch shows live status (issue checkboxes, CI checks, PR state) on a board
5. User opens the PR's preview deployment from the dashboard and tests it
6. User clicks **Ship** → PR merges → existing CI/CD deploys to production → ticket auto-closes

### Guiding principles

- **Thin control plane.** Dispatch reads/writes the Git provider; it never duplicates the provider's state machine.
- **Provider-agnostic core.** Board, chat, and ship logic depend only on the adapter interface — never on Octokit or GitLab types directly.
- **Web UI, not a system of record.** The Git provider — not Dispatch — is the database. Runs single-operator on `localhost` by default; no accounts.
- **Human gate before production.** Nothing merges without an explicit click.
- **Stateless AI.** Every Claude API call carries its own context (CLAUDE.md + file tree); no assumed memory.

---

## 2. Goals / Non-Goals

### Goals
- G1: Refine an idea into an issue-ready spec via conversational AI in ≤ 5 minutes
- G2: File a correctly formatted, `@claude`-triggering GitHub issue with one click
- G3: Surface build progress (issue comments/checkboxes, workflow runs, PR + checks) with ≤ 30s staleness
- G4: One-click access to the PR preview URL; one-click merge with confirmation
- G5: Support multiple repos across **GitHub and GitLab** (including self-hosted GitLab) from one dashboard
- G6: Discover available repos automatically — the user picks from a list showing path, description, and basic structure rather than typing identifiers

### Non-Goals (v1)
- Multi-user support, auth, or roles — single operator on localhost
- Hosting Dispatch itself on the public internet
- Replacing GitHub's UI for code review (deep diff review happens on github.com; Dispatch links out)
- Running Claude Code locally via the Agent SDK (the Actions runner does the coding; see §10 Future)
- Mobile-native app (responsive web is sufficient)

---

## 3. Architecture

```
┌──────────────────────────┐         ┌─────────────────────────────────┐
│  YOUR CONTROL PLANE      │         │  GITHUB                         │
│                          │         │                                 │
│  Web UI (React + Vite)   │         │  Issue ──▶ Actions workflow     │
│   spec chat · board      │  REST   │              │ checkout         │
│   monitor · ship         │◀───────▶│              ▼                  │
│        │                 │ Octokit │  Ephemeral runner               │
│  Backend (Express)       │         │   └─ Claude Code + repo clone   │
│   API proxy · poller     │         │              │                  │
│        │                 │         │              ▼                  │
│  Claude API (/v1/messages│         │  Pull request + CI checks       │
│   stateless, ctx-injected│         └───────┬──────────────┬──────────┘
└──────────────────────────┘                 ▼              ▼
                                      Preview env      Production
                                      (per-PR URL)     (on merge)
```

- **Frontend:** React 18 + Vite, Tailwind CSS v3, dark theme. Talks only to the local backend.
- **Backend:** Node 20 + Express. Proxies Anthropic and GitHub API calls (keys never reach the browser). Polls GitHub for status. Persists lightweight local state in SQLite (`better-sqlite3`).
- **State ownership:** Issues, PRs, checks, comments → GitHub. Chat transcripts, repo registry, settings → local SQLite. If SQLite is deleted, the board must rebuild itself from GitHub alone.

---

## 4. Tech Stack & Conventions

| Layer | Choice | Notes |
|---|---|---|
| Frontend | React 18 + Vite + Tailwind v3 | Mirror existing project conventions |
| Backend | Express on Node 20 | Single process, port 3001; Vite dev server proxies `/api` |
| Storage | SQLite via better-sqlite3 | File: `./data/dispatch.db` |
| GitHub client | Octokit (`@octokit/rest`) | Fine-grained PAT from env |
| GitLab client | `@gitbeaker/rest` | PAT from env; supports gitlab.com + self-hosted base URL |
| Provider layer | In-house adapter interface (§5.5) | One implementation per provider |
| AI | Anthropic Messages API | Model configurable; default `claude-sonnet-4-20250514` |
| Secrets | `.env` (gitignored) | `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `GITLAB_HOST` (optional), `PORT` |

**UI readability standards (hard requirements):**
- Minimum body font size 13px; minimum caption/label size 11.5px
- All text ≥ 4.5:1 contrast against background
- Status colors: green = passing/deployed, amber = in-progress/waiting, red = failing/blocked, blue = informational. Never rely on color alone — pair with icon or text.

---

## 5. Functional Requirements

### F1 — Repo discovery & registry
- F1.0 **Discovery:** On the Repos page, Dispatch lists every repo/project the configured token(s) can access — GitHub via `GET /user/repos` (paginated, sorted by `pushed_at`), GitLab via `GET /projects?membership=true&order_by=last_activity_at`. Each entry shows: provider badge (GitHub/GitLab), full path (`owner/name` or `group/subgroup/project`), **description**, default branch, primary language, visibility, and last-activity timestamp. A search box filters client-side.
- F1.1 **Tracking:** The user clicks **Track** on a discovered repo to add it to the registry (no manual typing in the happy path). A manual-entry fallback accepts a full path or URL — including self-hosted GitLab URLs — and validates token access before saving. Each tracked repo stores its `provider` and `host`.
- F1.2: Per-repo config: default branch (pre-filled from discovery), preview-URL pattern (template string, e.g. `https://myapp-pr-{n}.vercel.app`), merge method, and optional path to fetch `CLAUDE.md`.
- F1.3 **Structure & description cache:** For each tracked repo, the backend fetches and caches: the provider-side description, `CLAUDE.md` (if present), the README's first ~80 lines, and a depth-2 file tree (GitHub Git Trees API / GitLab Repository Tree API). Refreshed on demand and at most every 6h.
- F1.4 **Repo card UI:** Tracked repos render as cards showing the description, a top-level structure summary (root directories with file counts, e.g. `src/ · api/ · tests/ · docs/`), CLAUDE.md presence indicator, and context-freshness timestamp. This same cached context is what F2 injects into spec chats, so the card doubles as a "what does Claude know about this repo" view.
- F1.5: A repo with no detectable Claude automation (no `claude` workflow file on GitHub / no `claude` job in `.gitlab-ci.yml`) shows a setup warning on its card linking to §8.

### F1a — Provider adapter (required abstraction)
All provider calls go through a single interface; the rest of the app never imports Octokit or Gitbeaker directly:

```ts
interface GitProvider {
  discoverRepos(): RepoSummary[]            // path, description, defaultBranch, language, lastActivity
  getRepoContext(repo): RepoContext         // description, fileTree, claudeMd, readmeExcerpt
  createIssue(repo, spec): IssueRef
  postComment(target, body): void           // issue or PR/MR
  getIssue(repo, n): Issue
  findLinkedPR(repo, issueN): PRRef | null  // PR (GitHub) or MR (GitLab)
  getPRStatus(pr): PRStatus                 // state, mergeable, checks[]/pipelines[]
  getWorkflowRuns(repo, ref): Run[]         // Actions runs / CI pipelines
  mergePR(pr, method): MergeResult
}
```

Concept mapping the adapters must normalize:

| Dispatch concept | GitHub | GitLab |
|---|---|---|
| Issue | Issue | Issue |
| PR | Pull request | Merge request |
| Checks | Check runs / commit statuses | Pipeline jobs |
| Build run | Actions workflow run | CI pipeline |
| Trigger | `@claude` mention → claude-code-action | `@claude` mention → Claude Code GitLab CI/CD job (beta) |
| Auto-close keyword | `Fixes #n` | `Closes #n` |

### F2 — Spec chat
- F2.1: Chat interface scoped to a selected repo. Backend injects into the system prompt: the repo's description, `CLAUDE.md`, README excerpt, the cached file tree, and a fixed instruction block (below).
- F2.2: System instruction: *"You are helping write a GitHub issue spec for Claude Code to implement autonomously. Drive toward: a one-line title; problem statement; acceptance criteria as a checklist; likely files/modules affected; test plan; out-of-scope notes. Ask at most one clarifying question per turn."*
- F2.3: A **Generate ticket** button calls Claude once more with the transcript, requesting strict JSON: `{ title, body_markdown, labels[] }`. Backend strips code fences and validates JSON before returning; on parse failure, retry once with an error-correction prompt.
- F2.4: User can edit title/body/labels in a preview modal before filing.
- F2.5: Transcript persists locally per draft ticket and is linkable from the resulting issue's board card.

### F3 — Ticket filing
- F3.1: `POST /api/tickets` creates the issue via the repo's provider adapter. The body is the spec markdown plus a trailing line: `@claude please implement this. Open a PR/MR referencing this issue (include the auto-close keyword for this provider).`
- F3.2: Apply label `dispatch` (create it in the repo if missing) so the board can query its own tickets.
- F3.3: On success, store `{ issue_number, repo, chat_id }` locally and navigate to the board.

### F4 — Board & monitoring
- F4.1: Kanban-style board with columns derived **only** from GitHub state:
  - **Spec** — local drafts not yet filed
  - **Queued** — issue open, no linked PR, no in-progress workflow run
  - **Building** — workflow run in progress, or linked PR exists with pending checks
  - **Ready to test** — PR open, all checks green
  - **Shipped** — PR merged / issue closed
  - **Blocked** — workflow run failed, or any PR check failed
- F4.2: Backend polling: every 20s for repos with active (non-Shipped) tickets; every 5 min otherwise. Use conditional requests (ETags) to conserve rate limit; surface remaining rate limit in the UI footer.
- F4.3: Card detail view shows: issue body, Claude's progress comment (rendered markdown with live checkboxes), linked PR with per-check status, workflow run link, and timestamps.
- F4.4: PR linkage: a PR is linked to a ticket if its body contains `#<issue_number>` (Fixes/Closes/refs) or its branch name contains the issue number.
- F4.5: **Steer** action: post a comment to the issue or PR from the card (text box → `POST` comment). Used to course-correct Claude mid-build (a new `@claude` mention re-triggers the action).

### F5 — Test
- F5.1: When a linked PR exists, render a **Preview** button using the repo's preview-URL pattern with the PR number substituted. Opens in a new tab.
- F5.2: If the deploy provider posts the preview URL as a PR comment or deployment status, prefer the live value over the pattern (parse `deployments`/`statuses` API and bot comments).
- F5.3: Show CI check list with pass/fail/pending per check, linking each to its GitHub page.

### F6 — Ship
- F6.1: **Ship** button enabled only when: PR open, all required checks green, PR mergeable.
- F6.2: Click → confirmation modal summarizing repo, PR title, diff stats, and target branch → on confirm, `PUT /repos/{owner}/{repo}/pulls/{n}/merge` (squash by default; per-repo configurable).
- F6.3: After merge, surface the production deploy workflow run (if any) on the card until it completes; then move card to **Shipped**.
- F6.4: If merge fails (conflicts, branch protection), show the GitHub error verbatim with a link to the PR.

### F7 — Activity feed
- F7.1: Reverse-chronological feed (most recent 50 events) across all tracked tickets: issue created, workflow started/finished, PR opened, check failed, merged, deployed. Derived from polled data; no separate event store required beyond a local cache table.

---

## 6. API Surface (backend)

| Method & path | Purpose |
|---|---|
| `GET /api/discover?provider=github|gitlab` | List all repos accessible to the token (F1.0) |
| `GET /api/repos` / `POST /api/repos` / `DELETE /api/repos/:id` | Repo registry (track/untrack) |
| `POST /api/repos/:id/refresh-context` | Re-fetch CLAUDE.md + file tree |
| `POST /api/chat` | Proxy spec-chat turn to Anthropic (streams SSE to client) |
| `POST /api/chat/:id/generate-ticket` | Transcript → structured spec JSON |
| `POST /api/tickets` | File issue on GitHub |
| `GET /api/board` | All tickets with derived column + status payload |
| `GET /api/tickets/:id` | Card detail (issue, comments, PR, checks, runs) |
| `POST /api/tickets/:id/comment` | Steer: comment on issue or PR |
| `POST /api/tickets/:id/merge` | Ship |
| `GET /api/activity` | Activity feed |
| `GET /api/health` | Token validity, rate-limit remaining, DB status |

All Anthropic and GitHub credentials live server-side only. The frontend never receives them.

---

## 7. Data Model (SQLite)

```sql
repos(id, provider, host, path,            -- provider: 'github'|'gitlab'; host for self-hosted
      description, web_url, default_branch, language,
      preview_url_pattern, merge_method DEFAULT 'squash',
      claude_md_cache, readme_excerpt_cache, file_tree_cache,
      automation_detected, context_refreshed_at)

chats(id, repo_id, created_at, transcript_json, status)        -- status: draft|filed

tickets(id, repo_id, chat_id, issue_number, created_at)

status_cache(ticket_id, payload_json, etag_map_json, updated_at)

activity(id, ticket_id, type, summary, url, occurred_at)
```

Rebuild rule: `tickets` rows plus the GitHub API are sufficient to reconstruct the entire board; all `*_cache` tables are disposable.

---

## 8. Prerequisites & Setup (document in README)

**GitHub repos:**
1. `anthropics/claude-code-action@v1` installed — run `/install-github-app` from Claude Code in the repo, which configures the GitHub App and `ANTHROPIC_API_KEY` secret.
2. Workflow triggers on `issues: [opened]` and `issue_comment: [created]` with the `@claude` filter, scoped permissions (`contents: write`, `pull-requests: write`, `issues: write`), and `timeout-minutes` set (default 30).
3. Fine-grained PAT with Issues (RW), Pull requests (RW), Contents (R), Actions (R) on the target repos → `GITHUB_TOKEN`.

**GitLab repos (integration is beta — verify current docs at code.claude.com/docs/en/gitlab-ci-cd):**
4. Claude job added to `.gitlab-ci.yml` per the official setup, with `ANTHROPIC_API_KEY` stored as a masked CI/CD variable; `@claude` mentions in issues/MR threads trigger the job, which commits results back via MRs.
5. PAT with `api` scope → `GITLAB_TOKEN`; set `GITLAB_HOST` for self-hosted instances.

**Both:**
6. PR/MR preview deployments configured on the deploy provider (recommended) — Dispatch consumes, does not create, preview environments.
7. `.env` with the keys above. `npm install && npm run dev` starts both servers concurrently.

---

## 9. Security & Failure Handling

- S1: Backend binds to `127.0.0.1` only. Refuse to start if bound elsewhere without `ALLOW_NONLOCAL=1`.
- S2: Keys only in env; never logged, never sent to the client; redact in error messages.
- S3: GitHub rate limiting: honor `Retry-After`/secondary-limit responses with exponential backoff; pause polling and show a banner when remaining < 100.
- S4: Anthropic errors (overloaded/timeouts): retry once with backoff; surface a non-blocking toast on failure; never lose the user's typed message (keep it in the input).
- S5: All destructive actions (merge, delete repo) require confirmation modals.
- S6: Poller must tolerate: deleted issues, force-pushed branches, manually merged/closed PRs — always reconcile to whatever GitHub says.

---

## 10. Future (explicitly out of scope for v1, design should not preclude)

- Webhook ingestion (replacing polling) via a tunnel (smee.io/ngrok) for sub-second updates
- Local test daemon: a companion process that checks out a PR branch and restarts a local dev server on request from the dashboard
- Agent SDK mode: run Claude Code headless on the user's own machine/server as an alternative to the Actions runner, streaming progress directly into the UI
- Cost telemetry: per-ticket Actions minutes + token spend

---

## 11. Acceptance Criteria (v1 done when…)

1. From a fresh clone with a valid `.env`, `npm install && npm run dev` brings up the app with an empty board and a working health check.
2. Adding a repo validates token access and displays its cached file tree timestamp.
3. A spec chat produces a Generate-ticket preview whose JSON always parses (manual test: 10 consecutive generations, 0 unhandled parse failures).
4. Filing a ticket creates a real GitHub issue containing the spec, the `dispatch` label, and an `@claude` mention, and the card appears in **Queued**.
5. When the Action runs, the card moves to **Building** within 30s and renders Claude's checkbox progress comment.
6. When the PR opens with green checks, the card shows **Ready to test** with a working Preview button and per-check statuses.
7. **Ship** merges the PR, the issue auto-closes, and the card reaches **Shipped** without manual refresh.
8. A failed check moves the card to **Blocked** with the failing check named; a Steer comment containing `@claude` re-triggers the workflow.
9. Deleting `data/dispatch.db` and restarting rebuilds all non-draft cards from GitHub alone.
10. The UI meets the readability standards in §4 (spot-check with devtools contrast checker).
11. The Repos page lists all token-accessible repos from both providers with description, path, and last activity; tracking one requires zero manual typing.
12. A GitLab project completes the full loop (file → build → MR → ship) through the same UI with no GitLab-specific code outside the adapter — verified by grepping for `gitbeaker` imports outside `providers/`.

---

## 12. Milestones

| # | Slice | Contents |
|---|---|---|
| M1 | Skeleton | Express + Vite + Tailwind scaffolding, health check, **provider adapter interface + GitHub adapter**, repo discovery + registry, context fetch |
| M2 | Spec chat | Streaming chat, context injection, Generate-ticket JSON flow, preview/edit modal |
| M3 | File + board | Issue creation, polling engine, column derivation, card detail |
| M4 | Test + ship | PR linkage, checks, preview button, merge flow, activity feed |
| M5 | GitLab adapter | Second `GitProvider` implementation, concept-mapping normalization, mixed-provider board verification |
| M6 | Hardening | Rate-limit handling, failure states S1–S6, README setup guide, acceptance pass |

Each milestone should end in a runnable state with its own smoke test.
