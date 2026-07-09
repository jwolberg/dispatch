---
id: 9
title: "One-click revert"
status: open
priority: medium
horizon: now
hitl: true
type: feature
source: docs/BUILD_PLAN-v2.md
created: 2026-07-09
updated: 2026-07-09
prs: []
refs:
  - "docs/BUILD_PLAN-v2.md"
  - "T1-8"
depends_on: [8]
acceptance:
  - "A shipped card exposes a single revert affordance"
  - "GitProvider gains revertPR(ref, prNumber) -> { number, url }, implemented for both providers per ADR-0003"
  - "GitHub uses the revertPullRequest GraphQL mutation; GitLab synthesizes an MR (dry-run precheck, create branch, revert onto it, open MR) and never commits to the default branch"
  - "GitLab reads squash_commit_sha ?? merge_commit_sha; a test covers the squash-merge case"
  - "Revert produces an open PR/MR that a human merges through the existing Ship gate; Dispatch never pushes to a default branch"
  - "The Git Data API tree-snapshot approach is not used (ADR-0003 [4])"
  - "When the provider refuses the call for permissions, the UI degrades to the deep-link from PullRequest.revertUrl rather than showing an error"
  - "The resulting revert PR appears on the board linked to the original ticket, not as an orphan card"
  - "Revert is not offered on a card that has not shipped — guarded in the UI and re-validated server-side, not relying on the API to reject it"
  - "Nothing in this ticket requires a local checkout or local git"
  - "Tests cover: revert PR detection, linkage to the original ticket, the not-shipped guard, and the GitLab squash-merge SHA selection"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Tier 1 exit criterion: shipping something bad is recoverable in one click. The
target user cannot open a terminal and cannot read a diff; if a merge breaks
production, the recovery path has to be a button.

The mechanism is decided by #8. Do not start until it has landed.

## Acceptance criteria

- One revert affordance on a shipped card.
- Mechanism per ADR-0003: call the provider API. Both providers yield an open
  PR/MR that a human merges. Deep-link is the permission-denied fallback only.
- Revert PR shows on the board, linked to the original ticket.
- No revert affordance on a card that has not shipped (UI + server guard).
- No local checkout, no local git. No Git Data API.
- Tests: detection, linkage, not-shipped guard, GitLab squash-merge SHA.

## Design notes

**#8 landed: `docs/decisions/0003-revert-mechanism-per-provider.md` (ADR-0003).**
The plan's assumed fallback is not needed. Both providers expose a public API,
but they are asymmetric — GitHub's `revertPullRequest` opens a PR, while
GitLab's REST revert commits *directly to the branch you name*. GitLab therefore
has to synthesize the MR (ADR-0003 §[3]); a naive `branch: "main"` revert pushes
an unreviewed commit to a user's default branch and will usually 403 on a
protected branch anyway.

Read ADR-0003 §[4] before reaching for the Git Data API. It is easy to build and
silently destroys intervening work.

No new dependencies: `octokit.graphql` and gitbeaker's `Commits.revert` /
`Branches.create` / `MergeRequests.create` already exist (verified in ADR-0003
§[5]).

Linkage reuse: T0-3 already extracted the PR-linkage rule into
`providers/linkage.ts` and tested it. A revert PR body referencing the original
should resolve through that same path rather than a new regex — but GitHub's
generated body text is not contractual, so assert it.

## Action needed

**Human, before execution:** creating revert PRs in a user's repository is an
escalating-cost, outward-facing action, flagged in `docs/BUILD_PLAN-v2.md §4` for
explicit approval. Confirm the mechanism (ADR-0003) and approve before executing.
Do not run against a real user repo during development.

Two things ADR-0003 §[6] could not establish from documentation, to resolve
against a throwaway repo as part of that same approval step:

1. Which permissions `revertPullRequest` needs, and whether a GitHub App
   installation token can call it at all (couples to #3).
2. What the mutation does when the PR is not merged — do not rely on it
   erroring; keep the server-side guard.
