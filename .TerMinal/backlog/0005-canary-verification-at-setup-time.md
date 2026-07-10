---
id: 5
title: "Canary verification: prove the build triggers, at setup time"
status: in-progress
priority: high
horizon: now
hitl: false
type: feature
source: docs/BUILD_PLAN-v2.md
created: 2026-07-09
updated: 2026-07-10
prs:
  - "https://github.com/jwolberg/dispatch/pull/26"
refs:
  - "docs/BUILD_PLAN-v2.md"
  - "T1-4"
  - "docs/adding-a-repo.md"
  - "ADR-0002"
  - "ADR-0006 [2]"
  - "server/poller/reconcile.ts:138"
  - "#25"
depends_on: [4]
acceptance:
  - "After setup, Dispatch files a throwaway issue containing an @claude mention in the target repo, carrying the dispatch-canary label"
  - "openPRForClaudeBranch returns null for any issue carrying the dispatch-canary label — a canary NEVER grows a pull request. The test asserts this against an issue whose branch IS genuinely Claude-authored, so the label is the only thing preventing the PR."
  - "It polls for a matching workflow_run within a bounded, explicitly-stated window and records pass or fail"
  - "The canary passes only when the run reaches a conclusion of success — a run in action_required (awaiting approval) is a FAIL, not a pass. Presence of a workflow_run is never sufficient. See ADR-0002."
  - "A test asserts the canary fails against a fixture whose run status is action_required"
  - "A test asserts the canary fails against a fixture whose run reached conclusion: failure seconds after starting — the #25 signature, where the run starts and dies at the App token exchange. A presence check would have called that green."
  - "On completion it closes the throwaway issue and deletes any branch the run created, on both the pass and fail paths"
  - "Pass/fail and the timestamp are persisted and rendered on the repo card"
  - "A failed canary produces an actionable message naming the likely cause, not a generic error"
  - "The cleanup path is covered by a test that asserts no throwaway artifacts survive a failed canary"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Writing a workflow file is not the same as the workflow running. The failure mode
Dispatch exists to prevent is a user filing a ticket, watching the card sit in
`Queued` forever, and having no idea why.

So after setup, prove it: file a throwaway issue with an `@claude` mention, poll
for a `workflow_run` within a bounded window, then clean up. Record the verdict
on the repo card.

This converts the nastiest piece of tribal knowledge in `docs/adding-a-repo.md`
— that a PR opened by the default token silently never triggers CI — into an
automated check that fails loudly at setup time instead of quietly at first
build.

## Acceptance criteria

- Throwaway issue with `@claude` filed post-setup.
- Bounded poll for a matching `workflow_run`; verdict recorded.
- **Pass requires `conclusion: success`.** A run sitting in `action_required` is
  a fail. Per ADR-0002, a PR opened by the default `GITHUB_TOKEN` *does* create a
  workflow run — it just never executes without a human clicking "Approve
  workflows to run". A presence check would therefore report a green canary on
  precisely the broken configuration this ticket exists to detect.
- Test asserts a fail against an `action_required` fixture.
- Issue closed and any created branch deleted — on both pass and fail.
- Verdict + timestamp persisted and shown on the repo card.
- Failure message names the likely cause (e.g. "the token that opened this event
  cannot trigger workflows"), not a generic error.
- Test asserts cleanup runs on the failure path.

## Amended 2026-07-10, after #4 landed

Two criteria in the original spec were written before #4 and ADR-0006 [2] shipped.
Both were wrong by the time this ticket became workable. Do not restore them.

### Removed: "distinguish the 403-at-PR-creation failure mode"

The original AC 7 required the canary to tell a `403 GitHub Actions is not permitted
to create or approve pull requests` apart from a run parked in `action_required`,
per ADR-0002 [3.1].

**The workflow no longer creates pull requests at all.** ADR-0006 [2] removed that;
the only occurrence of `pull-requests: write` in `scripts/repo-ci/claude.yml` is a
comment recording that it is *deliberately absent*. Dispatch's server opens the PR,
from outside Actions, with an App installation token — a credential the
"Allow GitHub Actions to create and approve pull requests" repo setting does not
govern. The 403 arm describes a failure the shipped workflow cannot produce.

The `action_required` arm survives as a cheap safety net and stays.

### Added: the canary must not grow a pull request

#4 shipped `openPRForClaudeBranch` (`server/poller/reconcile.ts:138`). It opens a PR
for any **Claude-authored** branch that links to an open issue. A canary issue with
an `@claude` mention produces exactly that: Claude pushes `claude/issue-N-*`, and the
next poll opens a PR with `Fixes #N` in its body.

So the canary, as originally written, would leave a pull request in a user's repo —
an artifact its own cleanup criteria never mentioned, because the poller did not
exist when they were written. Cleaning it up afterward invites a race: cleanup
deleting the branch while a poll cycle is mid-`createPullRequest`.

**Decision (2026-07-10): make the artifact impossible rather than clean it up.** The
canary issue carries a `dispatch-canary` label, and `openPRForClaudeBranch` returns
`null` for any labelled issue. The seam already supports this — `Issue.labels` and
`SpecInput.labels` both exist, and `openPRForClaudeBranch` already receives the full
`Issue` and is already exported for tests. It is a one-line guard.

The test must use a branch that **is** genuinely Claude-authored, so that the label
is the only thing preventing the PR. A test that passes because the discriminator
rejected the branch proves nothing.

## Progress — 2026-07-10 (branch `feat/5-canary-verification`)

Pure, unit-testable logic is built and green (`npm run verify`, 575 tests). Three
commits, each TDD-first:

- **Canary-label guard** — `openPRForClaudeBranch` returns null for a
  `dispatch-canary`-labelled issue, so the canary never grows a PR
  (`reconcile.ts`, `CANARY_LABEL`). Test uses a genuinely Claude-authored branch.
- **`classifyCanaryRun`** — success is the only pass; `action_required` and the
  `conclusion: failure` (#25) signatures fail with distinct messages. Reads raw
  `(status, conclusion)`, not the lossy `RunState` (`canary.ts`).
- **`pollCanary`** — bounded window, injected clock, timeout is a fail with two
  distinct reasons (no run vs never completed) (`canary.ts`).

**Remaining, and it crosses the escalating-cost line — STOP for approval.** The
live orchestrator writes to a user's repo and spends their Claude subscription on
a real run, so per the decision protocol it is not done as a side effect of "work
the ticket." It also needs three new seam methods:

- `closeIssue` — **missing** on `GitProvider`.
- `deleteBranch` — **missing**.
- a raw-run fetch for the canary: `getWorkflowRuns` exists but returns the
  collapsed `RunState`, which erases `action_required`. Either add a raw variant
  or widen the DTO.

Then: the orchestrator (file labelled issue → `pollCanary` → close issue + delete
any branch on both paths → persist verdict), DB column, and the card rendering.

## Design notes

Pick the timeout deliberately and state it: a cold GitHub Actions runner can take
a minute or more to pick up a job. Too short and the canary lies.

**Require `conclusion: success`, not presence.** #25 is the proof: that run started
and died 27 seconds later at the App token exchange. Any "did a workflow_run appear?"
check would have reported a green canary on a configuration that never builds
anything — precisely the failure this ticket exists to catch.

**The canary costs real money.** It triggers a full `claude-code-action` run against
the user's Claude subscription, under a `timeout-minutes: 30` workflow. The issue
body should ask for the smallest possible no-op, and the poll window should be bounded
well below the workflow timeout.

Cleanup on the failure path is the part that will be skipped if it is not tested.
Test it.

The canary writes to a user's repo. It must be safe to run twice, and it must
never leave an open issue behind.
