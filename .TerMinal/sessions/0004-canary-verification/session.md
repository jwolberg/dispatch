---
id: 4
slug: canary-verification
anchor: SES-0004
title: "#5 — Canary verification: prove the build triggers at setup time"
status: closed
started: 2026-07-11T00:00:00Z
ended: 2026-07-11T20:30:00Z
goal: "Canary verification (#5): after setup, prove the build actually triggers — file a throwaway dispatch-canary issue with @claude, poll for a workflow_run in a bounded window, pass only on conclusion:success, clean up on both paths, render pass/fail on the repo card"
tickets: [5]
branches:
  - feat/5-canary-orchestrator
prs:
  - "https://github.com/jwolberg/dispatch/pull/32"
related_research: []
related_docs:
  - docs/BUILD_PLAN-v2.md
  - docs/decisions/0002-github-app-tokens-and-the-anti-recursion-rule.md
  - docs/decisions/0006-dispatch-opens-the-pr-and-the-app-is-registered-per-deployment.md
  - docs/adding-a-repo.md
prior_sessions: [3]
---

## [1] Goal

Close out ticket **#5**, the last open ticket in BUILD_PLAN-v2 Tier 1. Writing a
workflow file is not the same as the workflow running: after `POST /setup`,
Dispatch must *prove* a build will trigger by filing a throwaway
`dispatch-canary`-labelled issue with an `@claude` mention, polling for a
`workflow_run` within a bounded window, and recording a verdict on the repo card.
**Done** = the live orchestrator ships (file → poll → clean up on both paths →
persist verdict → render), gated on `conclusion: success` (never mere presence),
with the failure path covered by a test asserting no throwaway artifacts survive.

## [2] Context & pointers

### [2.1] Ticket in scope

**#5 — Canary verification** (`in-progress`, high/now, `depends_on: [4]` ✅ done).
The pure, unit-testable logic already landed in **PR #26 (merged)**; three
TDD-first slices, `npm run verify` green at 575 tests:

- **Canary-label guard** — `openPRForClaudeBranch` returns `null` for a
  `dispatch-canary`-labelled issue, so a canary never grows a PR
  (`server/poller/reconcile.ts`). Test uses a genuinely Claude-authored branch,
  so the label is the only thing preventing the PR.
- **`classifyCanaryRun`** — `conclusion: success` is the only pass;
  `action_required` and the #25 `conclusion: failure` signature each fail with a
  distinct message. Reads raw `(status, conclusion)`, not the lossy `RunState`
  (`server/poller/canary.ts`).
- **`pollCanary`** — bounded window, injected clock; timeout is a fail with two
  distinct reasons (no run vs never completed).

**Remaining (this session), and it crosses the escalating-cost line:** the live
orchestrator writes to a user's repo and spends their Claude subscription on a
real run. Per the decision protocol that is an approval gate, not a side effect.
It also needs seam methods that were missing as of #26: `closeIssue`,
`deleteBranch`, and a raw-run fetch that preserves `action_required` (today
`getWorkflowRuns` collapses to `RunState`). Then: the orchestrator, a DB column
for verdict+timestamp, and the card rendering.

Acceptance criteria (verbatim in the ticket): throwaway `@claude` issue filed
post-setup carrying `dispatch-canary`; canary never grows a PR; bounded poll;
pass **requires** `conclusion: success` (`action_required` and early
`conclusion: failure` both FAIL — tests for each); issue closed + any branch
deleted on **both** paths (cleanup covered by a test); verdict+timestamp
persisted and shown on the card; failure message names the likely cause.

### [2.2] Research & docs

- `docs/decisions/0002-...anti-recursion-rule.md` (ADR-0002) — why a run parked
  in `action_required` is a FAIL: a PR opened by the default `GITHUB_TOKEN`
  creates a run that never executes without a human "Approve workflows" click.
- `docs/decisions/0006-...dispatch-opens-the-pr...md` (ADR-0006 [2]) — the
  workflow no longer opens PRs; Dispatch's server does, with the App token. This
  is why the original AC 7 (403-at-PR-creation) was removed from #5.
- `docs/adding-a-repo.md` — the tribal knowledge this ticket automates.
- #25 is the load-bearing failure fixture: a run that started and died 27s later
  at the App-token exchange — a presence check would have called it green.

### [2.3] Prior sessions

- **SES-0003** (#21 + #4 + the account-level App work) — shipped the setup route
  (`POST /api/repos/:id/setup`) and `openPRForClaudeBranch` that #5 hooks into.
  Its follow-ups named #5 as next.

### [2.4] Git/PR state

Branch `main` (clean of in-flight PRs). Feature branch `feat/5-canary-verification`
existed for PR #26 (merged, scrubbed from `prs:`). This session opens a fresh
branch off `main` for the orchestrator slice. No open PRs.

## [3] Checklist

All slices are TDD-first and run against **fakes** — no live repo writes until
the gate at [3.5]. Branch: `feat/5-canary-orchestrator` off `main`.

### [3.1] Seam methods (GitProvider + both adapters)
- [x] write failing test: `closeIssue(repo, number)` closes an issue (github adapter, fake Octokit)
- [x] implement `closeIssue` on `types.ts` interface + `github.ts` + `gitlab.ts`
- [x] write failing test: `deleteBranch(repo, ref, branch)` deletes a branch (github adapter)
- [x] implement `deleteBranch` on interface + both adapters
- [x] write failing test: raw-run fetch preserves `action_required` (today `getWorkflowRuns` collapses it via `mapRun`)
- [x] implement raw-run fetch (new `getWorkflowRunsRaw` returning `{status, conclusion, head_branch}`) on interface + both adapters

### [3.2] Orchestrator (`server/poller/canary.ts` or new `canary-run.ts`, against fakes)
- [x] write failing test: orchestrator files a canary issue via `createIssue` with `labels:[CANARY_LABEL]` + an `@claude` mention + smallest-no-op body
- [x] write failing test: on PASS (`conclusion:success`) it closes the issue AND deletes any created branch
- [x] write failing test: on FAIL (`action_required` fixture, and the #25 early-`failure` fixture) it STILL closes the issue and deletes any branch — assert no throwaway artifacts survive
- [x] write failing test: verdict + timestamp are persisted, and the failure message names the likely cause
- [x] implement orchestrator: file → `pollCanary` (real clock) → cleanup on both paths → persist verdict

### [3.3] DB persistence
- [x] write failing test: idempotent migration adds `canary_verdict`/`canary_checked_at`; update helper round-trips them
- [x] implement migration (`migrate.ts` table_info-guarded ADD COLUMN) + `RepoRow` fields + update helper + `presentRepo()`

### [3.4] Repo card
- [x] add `canary_verdict`/`canary_checked_at` to `TrackedRepo` (`web/src/api/types.ts`)
- [x] render a verdict chip on `RepoCard.tsx` (reuse `freshness()`), pass/fail/pending states; `npm run verify` green

### [3.5] Wire + ship
- [x] wire orchestrator into `POST /api/repos/:id/setup` as fire-and-forget after `updateRepoContext` (unit-test the wiring against a fake)
- [x] open PR + link the PR url into ticket #5 `prs:`
- [ ] **APPROVAL GATE** — run the first *live* canary against a real repo, observe `conclusion:success`, record the run in [4]. Do NOT fire without explicit user go-ahead (writes to a user repo, spends a real Claude run).

## [4] Log

### [4.1] 2026-07-11 — session opened, resuming after PR #26

Pure logic is merged; remaining work is the live orchestrator + seam methods + DB
+ card. Dispatched a read-only code-map pass to pin exact file:line seams before
writing the TDD checklist. **The orchestrator crosses the escalating-cost line
(writes to a user repo, spends real money) — approval gate before it runs live.**

### [4.2] 2026-07-11 — all code slices built TDD-first, branch `feat/5-canary-orchestrator`

Six commits, each RED→GREEN, full `npm run verify` green (602 tests):

1. `closeIssue` + `deleteBranch` seam (both adapters); also fixed `httpStatus` to
   read gitbeaker's `cause.response.status` (latent 404 bug).
2. `getWorkflowRunsRaw` — preserves `action_required` the collapsed
   `getWorkflowRuns` erases.
3. `runCanary` orchestrator — file labelled @claude issue → poll → close + delete
   branch on BOTH paths; matched by timestamp (issues-run has no issue link).
4. DB `canary_verdict`/`reason`/`checked_at` — schema + idempotent ALTER migration.
5. Fire-and-forget wiring from `POST /setup` (`runCanaryForRepo`, never throws →
   fail verdict on error).
6. Repo-card chip (`canaryChip`, reuses `TONE_CLS`).

Decisions logged in `docs/implementation-notes.md` (2026-07-11 entry). **Live run
NOT fired — held at the approval gate ([3.5]).**

### [4.3] 2026-07-11 — PR #32 opened, merged; live gate parked

All six code slices shipped to PR #32 (Closes #5), **merged** to main. Asked the
approval gate: decision = **merge first, run the live canary later**. No repo
write, no spend this session. [3.5]'s live item stays open until run — resume it
then, against a chosen repo, and record the observed `conclusion: success` here.

## [5] Decisions

1. **`httpStatus` reads gitbeaker's `cause.response.status`.** `GitbeakerRequestError`
   hides its HTTP status on the cause, so the GitLab adapter's `isNotFound` guards
   never matched a real 404. Fixing `httpStatus` corrects that latent bug and lets
   `deleteBranch` be idempotent on GitLab. ADR-worthy? No — a helper fix, captured
   as a learning candidate ([8]).
2. **Canary run matched by timestamp, not identity.** An `issues`-event run carries
   no link to the issue number; matched newest-on-default-branch created ≥ start
   with a 30s skew grace. Tradeoff (a second canary within ~30s could mis-match)
   accepted at one-shot setup time.
3. **Cleanup deletes branches without a Claude-authorship check.** Deletion isn't
   the irreversible action #4 AC 9 guards, and only branches linking to the just-
   created throwaway issue are matched — so the identity call is skipped.
4. **Canary fires fire-and-forget from `POST /setup`**, never throws (a provider
   error becomes a `fail` verdict), so the card always resolves to an answer.
5. **Live-fire deferred to an explicit approval gate** (writes to a user repo,
   spends a real Claude run) — per the decision protocol's escalating-cost rule.

Full reasoning in `docs/implementation-notes.md` (2026-07-11 entry).

## [6] Outcomes

- **PR #32 merged** — the canary orchestrator, across 6 TDD-first commits
  (`852b070`…`4f63ce5` + docs). Closes ticket #5; **BUILD_PLAN-v2 Tier 1 complete.**
- **Ticket #5 → closed** via reconcile PR #33 (open, awaiting human merge).
- New seam: `closeIssue`, `deleteBranch`, `getWorkflowRunsRaw` on `GitProvider`
  + both adapters. New modules: `server/poller/canary-run.ts`,
  `server/routes/canary-trigger.ts`, `web/src/lib/canary.ts`. DB columns
  `canary_verdict`/`reason`/`checked_at` + idempotent migration.
- `npm run verify` green at HEAD: **602 tests**, seam clean, templates match.
- Housekeeping this session: filed future tickets #30 (`/goal`) + #31
  (`/workflows`) with a PRD §10 note (PR #31, merged); fixed a duplicate-id
  collision by renumbering the harden-password ticket #26 → **#32** (PR #34, open).
- Branch `feat/5-canary-orchestrator` merged; pruned locally.

## [7] Follow-ups

- **[open] Live canary run (task #8 / ticket #5 [3.5])** — unblocked now #32 is
  merged; run against a chosen repo, confirm `conclusion: success`, record here.
  Needs a repo choice + go-ahead (writes + spends).
- **[open] Merge reconcile PRs #33 and #34** to fully clean the board.
- **[candidate] Next build ticket: #28** (namespace CI skills) — starting now.
- No test gaps: every behavior change shipped with an adversarial test (the #25
  and `action_required` fail fixtures, cleanup-on-both-paths, provider-throws).

## [8] Documentation

- Captured this session: `docs/implementation-notes.md` (2026-07-11 entry) — all
  five decisions above with reasoning.
- **Doc candidate (not yet written):** a `docs/learnings/` note on the gitbeaker
  error shape (`err.cause.response.status`) — a cross-cutting gotcha that silently
  disabled the GitLab `isNotFound` guards. Worth a learning; deferred so as not to
  block starting #28. Sibling to `docs/learnings/verify-external-formats-before-encoding-them.md`.
