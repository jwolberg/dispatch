# Architecture — Dispatch

**Derived from:** `docs/PRD-dispatch.md` (v1.1)
**Status:** Design reference for implementation

This document describes *how* Dispatch is built. The PRD defines *what* and *why*; this
defines the structure, boundaries, and runtime behavior that satisfy it. Where the PRD
gives a requirement (e.g. `F1.0`), the relevant sections are cross-referenced.

---

## 1. Architectural goals

These shape every decision below and are the lens for reviewing changes:

1. **Thin control plane.** Dispatch reads/writes the Git provider; it never duplicates the
   provider's state machine. Board columns are *derived* from provider state, not stored.
2. **Provider-agnostic core.** UI, chat, board, and ship logic depend only on the
   `GitProvider` interface — never on Octokit or Gitbeaker types. (PRD §5.5, acceptance #12)
3. **Structured web UI, not a system of record.** GitHub/GitLab — not Dispatch — is the
   database. One process, single-operator, binds to `127.0.0.1` by default, no accounts, no
   hosted backend. (PRD §2 Non-Goals, S1)
4. **Disposable local state.** The Git provider is the source of truth. Deleting
   `data/dispatch.db` and restarting must fully rebuild the board from the provider. (PRD §7,
   acceptance #9)
5. **Stateless AI.** Every Anthropic call carries its own context; no assumed server-side
   memory. (PRD principle)

---

## 2. System context

```
┌────────────────────────────┐        ┌──────────────────────────────────┐
│  WEB UI (localhost)         │        │  GIT PROVIDER (GitHub / GitLab)    │
│                             │        │                                    │
│  React + Vite SPA           │  REST  │  Issue ──▶ Actions / CI pipeline   │
│   (browser, :5173 dev)      │◀──────▶│             │ checkout            │
│        │ /api (proxied)     │ adapter│             ▼                     │
│  Express backend (:3001)    │        │  Ephemeral runner                 │
│   provider adapters ────────┼────────▶  └─ Claude Code + repo clone      │
│   poller · chat proxy       │        │             │                     │
│        │                    │        │             ▼                     │
│  SQLite (./data/dispatch.db)│        │  Pull request / MR + CI checks    │
└──────────┬──────────────────┘        └────────┬──────────────┬──────────┘
           │ HTTPS                               ▼              ▼
           ▼                              Preview env      Production
   Anthropic Messages API                 (per-PR URL)     (on merge)
   (stateless, ctx-injected)
```

Three external systems, all reached **only** from the backend (keys never touch the browser):

- **Anthropic Messages API** — spec refinement and ticket JSON generation.
- **Git provider** — issues, PRs/MRs, checks/pipelines, comments, merges. Source of truth.
- **Deploy pipeline** — owned externally; Dispatch *consumes* preview URLs and prod deploy
  status, never creates environments.

---

## 3. Process & deployment model

- **Single Node 20 process** runs the Express backend on port `3001`.
- **Vite dev server** (port `5173`) serves the SPA and proxies `/api/*` to `:3001`, so the
  browser only ever talks to one origin in dev. `npm run dev` starts both concurrently.
- **Binding:** backend binds `127.0.0.1` only; refuses to start on any other interface unless
  `ALLOW_NONLOCAL=1`. (S1)
- **Secrets** live in a gitignored `.env`: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`,
  `GITLAB_TOKEN`, optional `GITLAB_HOST`, `PORT`. Loaded server-side; never serialized to the
  client; redacted from logs and error messages. (S2)

---

## 4. Layered structure

```
dispatch/
├─ server/                      # Express backend (Node 20)
│  ├─ index.ts                  # bootstrap, localhost bind guard, route mount
│  ├─ routes/                   # one module per API group (§6 of PRD)
│  │   ├─ discover.ts           # GET /api/discover
│  │   ├─ repos.ts              # registry CRUD + refresh-context
│  │   ├─ chat.ts               # SSE chat proxy + generate-ticket
│  │   ├─ tickets.ts            # file, detail, comment, merge
│  │   ├─ board.ts              # derived board payload
│  │   ├─ activity.ts           # activity feed
│  │   └─ health.ts             # token/rate-limit/db status
│  ├─ providers/                # ⟵ ONLY place provider SDKs are imported
│  │   ├─ types.ts              # GitProvider interface + shared DTOs
│  │   ├─ github.ts             # Octokit implementation
│  │   ├─ gitlab.ts             # gitbeaker implementation
│  │   └─ index.ts              # factory: (provider, host) → GitProvider
│  ├─ anthropic/                # Messages API client + prompt assembly
│  │   ├─ client.ts
│  │   └─ prompts.ts            # system instruction, context injection, ticket JSON
│  ├─ poller/                   # background status reconciliation
│  │   ├─ scheduler.ts          # interval logic (20s active / 5m idle)
│  │   └─ reconcile.ts          # provider state → status_cache + column derivation
│  ├─ db/                       # SQLite access (better-sqlite3)
│  │   ├─ schema.sql
│  │   ├─ migrate.ts
│  │   └─ repos|chats|tickets|status|activity.ts   # query modules
│  └─ lib/                      # rate-limit, ETag store, redaction, errors
└─ web/                         # React 18 + Vite + Tailwind v3 SPA (dark)
   ├─ pages/                    # Repos, Chat, Board, CardDetail, Activity
   ├─ components/               # board columns, cards, modals, status chips
   ├─ api/                      # typed fetch wrappers over /api
   └─ hooks/                    # polling/refetch, SSE chat stream
```

**The boundary that matters most:** everything outside `server/providers/` speaks the
`GitProvider` interface and the normalized DTOs it returns. Acceptance #12 is enforced by
grepping for `gitbeaker`/`octokit` imports outside `providers/` — keep it green.

---

## 5. The provider abstraction (core seam)

GitHub and GitLab repos coexist on one board because all provider interaction flows through a
single interface (PRD §5.5 / F1a):

```ts
interface GitProvider {
  discoverRepos(): RepoSummary[]
  getRepoContext(repo): RepoContext         // description, fileTree, claudeMd, readmeExcerpt
  createIssue(repo, spec): IssueRef
  postComment(target, body): void           // issue or PR/MR
  getIssue(repo, n): Issue
  findLinkedPR(repo, issueN): PRRef | null
  getPRStatus(pr): PRStatus                 // state, mergeable, checks[]/pipelines[]
  getWorkflowRuns(repo, ref): Run[]
  mergePR(pr, method): MergeResult
}
```

Each adapter **normalizes provider concepts into Dispatch concepts** so the core sees one
vocabulary:

| Dispatch concept | GitHub | GitLab |
|---|---|---|
| Issue | Issue | Issue |
| PR | Pull request | Merge request |
| Checks | Check runs / commit statuses | Pipeline jobs |
| Build run | Actions workflow run | CI pipeline |
| Trigger | `@claude` → claude-code-action | `@claude` → Claude Code GitLab CI/CD job |
| Auto-close keyword | `Fixes #n` | `Closes #n` |

The factory in `providers/index.ts` selects the implementation from a repo's stored
`(provider, host)`. Self-hosted GitLab is handled by passing `GITLAB_HOST` as the base URL —
no other code path changes.

The auto-close keyword is provider-specific and is injected by the adapter when building the
issue body (F3.1), so the core never branches on provider for ship semantics.

### 5.1 Credential resolution (T1-2 / #3)

Adapters are memoized on `(provider, host, installationId)`, not just `(provider, host)`. The
memo is load-bearing: it keeps each adapter's conditional-request (ETag) cache warm across
poll cycles, which is what stops an unchanged poll from spending rate-limit quota (§14, T0-9).
`installationId` joined the key because two repos under one GitHub App installation share a
token and should share an adapter, while a repo under a *different* installation must not
reuse the first one's credential.

**Callers name a repo, never an installation.** That is the seam's rule and it is enforced by
the shape of the API, not by convention:

```ts
getProviderForRepo(ref: RepoRef): GitProvider   // resolves the installation internally
getProvider(provider, host?): GitProvider       // account-level, env token only
```

An `InstallationStore` is *injected* at boot by `server/index.ts` — the same pattern, and for
the same reason, as `CondCacheStore`: `providers/` must never import the db layer. With no
store injected (the local-development path, and all of GitLab), every repo resolves to the
`GITHUB_TOKEN`-backed adapter.

Behind the seam, a `TokenSource` supplies the bearer token per request rather than at
construction, because an adapter is memoized for the life of the process while an App
installation token expires hourly:

| | `EnvTokenSource` | `AppTokenSource` |
|---|---|---|
| Source | `GITHUB_TOKEN` / `GITLAB_TOKEN` | minted from the App's private key |
| Lifetime | process | ~1h, refreshed 10 min early |
| `invalidate(staleToken)` | no-op | drops the token, if the caller holds the current one |

`get()` is **single-flight** — concurrent callers join one in-flight mint. This is not merely a
stampede guard: without it, two mints race on the cached token and a late-resolving one can
retire a newer token another caller is already using, stripping it from the redaction registry
(`lib/redaction.ts`). `invalidate()` takes the token that actually failed, so N concurrent
401s on one dead token re-mint once rather than each discarding its predecessor's fresh token.

Three call sites have no repo — the rate-limit probe (`poller/scheduler.ts`, `routes/health.ts`)
and repo discovery (`routes/discover.ts`) — and use `getProvider()` with the env token. Under a
GitHub App there is no account-level credential at all, so those are ticket **#21**, not an
oversight.

> **Status:** the App path is landed but **not yet wired**. Nothing calls
> `setInstallationStore()` in production, so `AppTokenSource` is currently reachable only from
> tests. Ticket **#2** registers the App and injects the store; until then every repo uses
> `GITHUB_TOKEN`. This is deliberate — `docs/BUILD_PLAN-v2.md` §T1-2 says to land the credential
> seam first with the env token still flowing through it, then swap the source.

---

## 6. State ownership & the rebuild rule

| State | Owner | Notes |
|---|---|---|
| Issues, PRs/MRs, checks, comments, merges | **Git provider** | Single source of truth |
| Chat transcripts, repo registry, settings | **SQLite** | Local only |
| Cached repo context (CLAUDE.md, tree, README) | **SQLite** | Disposable cache, ≤6h TTL |
| Polled status snapshots + ETags | **SQLite** | Disposable cache |

SQLite schema (PRD §7):

```sql
repos(id, provider, host, path, description, web_url, default_branch, language,
      preview_url_pattern, merge_method DEFAULT 'squash',
      claude_md_cache, readme_excerpt_cache, file_tree_cache,
      automation_detected, context_refreshed_at)
chats(id, repo_id, created_at, transcript_json, status)        -- draft|filed
tickets(id, repo_id, chat_id, issue_number, created_at)
status_cache(ticket_id, payload_json, etag_map_json, updated_at)
activity(id, ticket_id, type, summary, url, occurred_at)
```

**Rebuild invariant (acceptance #9):** `repos` + `tickets` rows plus the provider API are
sufficient to reconstruct the entire board. Every `*_cache` table is disposable; the board
must repopulate from the provider on first poll after a cache wipe. This is the single most
important architectural constraint — no derived state (board columns, check status, PR
linkage) may be persisted as authoritative.

---

## 7. Board derivation (read path)

Columns are **computed**, never stored. Given a ticket's issue + linked PR + workflow runs,
the poller derives exactly one column (PRD F4.1):

```
Spec          local draft chat, not yet filed
Queued        issue open, no linked PR, no in-progress run
Building      run in progress, OR linked PR with pending checks
Ready to test PR open, all checks green
Shipped       PR merged / issue closed
Blocked       run failed, OR any PR check failed
```

**PR linkage** (F4.4): a PR links to a ticket if its body contains `#<issue_number>`
(Fixes/Closes/refs) or its branch name contains the issue number. Linkage is recomputed each
poll, never cached as truth.

`GET /api/board` returns all tickets with their derived column + status payload assembled from
`status_cache`; the frontend renders, it does not derive.

---

## 8. Polling engine

A single background scheduler reconciles provider state into `status_cache` (PRD F4.2):

- **Cadence:** every **20s** for repos with active (non-Shipped) tickets; every **5 min**
  otherwise.
- **Conditional requests:** store and replay ETags (`etag_map_json`) to avoid burning rate
  limit on unchanged resources.
- **Rate-limit safety (S3):** honor `Retry-After` and secondary-limit responses with
  exponential backoff; **pause polling** and surface a banner when remaining < 100. Remaining
  budget is shown in the UI footer.
- **Reconciliation must be defensive (S6):** tolerate deleted issues, force-pushed branches,
  and manually merged/closed PRs — always reconcile to whatever the provider reports, never
  assume local state is correct.
- Each poll diff also appends `activity` rows (issue created, run started/finished, PR opened,
  check failed, merged, deployed) feeding `GET /api/activity` (F7).

The poller is the only writer of `status_cache` and `activity`; routes read from these tables
to keep request latency low and provider calls bounded.

---

## 9. Spec-chat & ticket generation (AI path)

All Anthropic calls are stateless and proxied through the backend (PRD F2):

1. **Context injection** — for a repo-scoped chat, the backend builds the system prompt from
   the cached `RepoContext` (description, `CLAUDE.md`, README excerpt, depth-2 file tree) plus
   a fixed instruction block driving toward an issue-ready spec (one-line title, problem
   statement, acceptance checklist, affected files, test plan, out-of-scope; one clarifying
   question per turn). (F2.1–F2.2)
2. **Streaming** — `POST /api/chat` proxies a turn to Anthropic and streams SSE to the client.
3. **Generate ticket** — `POST /api/chat/:id/generate-ticket` calls Anthropic once with the
   transcript requesting strict JSON `{ title, body_markdown, labels[] }`. The backend strips
   code fences and validates JSON; **on parse failure it retries once** with an
   error-correction prompt. (F2.3, acceptance #3)
4. **Edit before file** — the client shows a preview modal for the user to edit
   title/body/labels before filing. (F2.4)
5. Transcripts persist in `chats` and link from the resulting board card. (F2.5)

**Anthropic failure handling (S4):** retry once with backoff; on failure show a non-blocking
toast and **never lose the user's typed input**.

---

## 10. File → ship lifecycle (write path)

```
chat (draft) ──POST /api/tickets──▶ provider.createIssue
   │   body = spec markdown + "@claude please implement…" + provider auto-close keyword
   │   label "dispatch" applied (created if missing)        (F3.1–F3.2)
   ▼
issue open ──(provider Action/CI runs Claude Code)──▶ PR/MR opened with checks
   │   poller links PR, derives Building → Ready to test
   ▼
Ready to test ── Preview button (repo preview_url_pattern w/ PR number,           (F5)
   │              or live URL from deployments/statuses/bot comment if present)
   ▼
Ship ──POST /api/tickets/:id/merge──▶ provider.mergePR(method)                     (F6)
   │   enabled only when: PR open + all required checks green + mergeable
   │   confirmation modal (repo, PR title, diff stats, target branch)
   ▼
merged → issue auto-closes → poller surfaces prod deploy run → column = Shipped
```

**Steer** (F4.5): `POST /api/tickets/:id/comment` posts to the issue or PR; a comment
containing `@claude` re-triggers the provider's build job — the mechanism for course-correcting
mid-build.

All destructive actions (merge, untrack repo) require a confirmation modal. (S5)

---

## 11. API surface

Backend routes (all credentials server-side only; PRD §6):

| Method & path | Purpose |
|---|---|
| `GET /api/discover?provider=github\|gitlab` | List token-accessible repos (F1.0) |
| `GET/POST /api/repos`, `DELETE /api/repos/:id` | Registry track/untrack |
| `POST /api/repos/:id/refresh-context` | Re-fetch CLAUDE.md + file tree |
| `POST /api/chat` | SSE spec-chat turn |
| `POST /api/chat/:id/generate-ticket` | Transcript → spec JSON |
| `POST /api/tickets` | File issue |
| `GET /api/board` | All tickets + derived column/status |
| `GET /api/tickets/:id` | Card detail (issue, comments, PR, checks, runs) |
| `POST /api/tickets/:id/comment` | Steer |
| `POST /api/tickets/:id/merge` | Ship |
| `GET /api/activity` | Activity feed |
| `GET /api/health` | Token validity, rate-limit remaining, DB status |

---

## 12. Repo discovery & context (F1)

- **Discovery** lists every repo the token(s) can reach — GitHub `GET /user/repos`
  (paginated, `pushed_at`), GitLab `GET /projects?membership=true&order_by=last_activity_at` —
  each normalized to `RepoSummary` (provider, full path, description, default branch, language,
  visibility, last activity). Client-side search filters.
- **Tracking** is zero-typing in the happy path (click **Track**); a manual fallback accepts a
  path/URL (incl. self-hosted GitLab) and validates token access before saving.
- **Context cache** per tracked repo: provider description, `CLAUDE.md`, README first ~80
  lines, depth-2 file tree (Git Trees / Repository Tree API). Refreshed on demand, at most
  every 6h. This same cache feeds spec-chat injection (§9) — the repo card doubles as a "what
  Claude knows" view.
- **Automation check (F1.5):** a repo with no `claude` workflow (GitHub) / no `claude` job in
  `.gitlab-ci.yml` (GitLab) shows a setup warning linking to the README setup guide.

---

## 13. Frontend conventions

- React 18 + Vite + Tailwind v3, dark theme; mirrors existing project conventions.
- Talks only to the local backend via typed `web/api/` wrappers.
- **Readability is a hard requirement (PRD §4):** body ≥13px, caption/label ≥11.5px, all text
  ≥4.5:1 contrast. Status colors — green=passing/deployed, amber=in-progress/waiting,
  red=failing/blocked, blue=informational — are **always paired with an icon or text**, never
  color alone. (acceptance #10)
- Data freshness comes from polling the backend; the UI never calls providers directly.

---

## 14. Cross-cutting concerns

- **Security:** localhost bind guard (S1); env-only secrets, redacted everywhere (S2);
  confirmation modals on destructive actions (S5).
- **Resilience:** provider rate-limit backoff + pause banner (S3); Anthropic retry + input
  preservation (S4); defensive poller reconciliation (S6).
- **Observability:** `GET /api/health` exposes token validity, rate-limit remaining, and DB
  status; the activity feed gives a human-readable event trail.

---

## 15. Extension points (future-proofing, PRD §10)

The design must not preclude these — keep the seams clean:

- **Webhook ingestion** replacing polling — the poller's reconciliation logic (`poller/
  reconcile.ts`) should be invocable from a webhook handler, not coupled to the scheduler.
- **Local test daemon** — a companion process checking out PR branches; would be a new route
  group, not a change to provider adapters.
- **Agent SDK mode** — running Claude Code headless locally instead of on the runner; an
  alternative trigger path behind the same ticket lifecycle.
- **Cost telemetry** — per-ticket Actions minutes + token spend; additive `activity`/cache
  columns.

---

## 16. Milestone-to-architecture mapping

| Milestone | Architectural deliverable |
|---|---|
| M1 Skeleton | Express+Vite+Tailwind scaffold, health route, `GitProvider` interface + GitHub adapter, discovery + registry + context fetch (§4, §5, §12) |
| M2 Spec chat | Anthropic client, prompt assembly, SSE streaming, ticket JSON flow (§9) |
| M3 File + board | Issue creation, poller engine, column derivation, card detail (§7, §8, §10) |
| M4 Test + ship | PR linkage, checks, preview button, merge flow, activity feed (§10, §11) |
| M5 GitLab adapter | Second `GitProvider` impl + concept normalization; verify no SDK leakage outside `providers/` (§5) |
| M6 Hardening | Rate-limit handling, S1–S6, README, acceptance pass (§14) |

Each milestone ends runnable with its own smoke test.
