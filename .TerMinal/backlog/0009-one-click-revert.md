---
id: 9
title: "One-click revert"
status: closed
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
  - "A shipped card exposes a single revert affordance; it deep-links to the provider and Dispatch performs no write (ADR-0004)"
  - "GitProvider gains getRevertUrl(ref, prNumber) -> string. GitHub derives it from the PullRequest.revertUrl GraphQL field, not by string-building. GitLab returns the MR web url, because api/v4 exposes no revert page"
  - "Dispatch never calls revertPullRequest, never creates a branch/commit/MR, and never writes to a default branch"
  - "GitProvider gains findRevertPR(ref, prNumber). A revert PR is detected by branch (revert-<n>-*) or body (Reverts ... #<n>), matched against the ORIGINAL PR number"
  - "findLinkedPR excludes revert PRs, so a newly opened revert PR cannot displace the original PR in StatusPayload.pr (the list is sorted updated-desc, so it otherwise would)"
  - "StatusPayload gains revertPr; a shipped card whose revert PR is open shows both, and the column stays Shipped"
  - "An activity row is written when a revert PR is first detected"
  - "The revert affordance is not offered on a card that has not shipped - guarded in the UI and re-validated server-side (409)"
  - "Nothing in this ticket requires a local checkout or local git. The Git Data API tree-snapshot approach is not used (ADR-0003 [4])"
  - "Tests cover: revert PR detection by branch and by body, findLinkedPR NOT returning a revert PR, revertPr surfacing on a shipped payload, and the not-shipped 409 guard"
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

- One revert affordance on a shipped card, deep-linking out. Dispatch writes
  nothing to the user's repository.
- `getRevertUrl` derived from `PullRequest.revertUrl` (GitHub) / MR web url
  (GitLab).
- `findRevertPR` detects the revert PR; `findLinkedPR` excludes revert PRs.
- `StatusPayload.revertPr` surfaces it; column stays `Shipped`.
- Activity row on first detection.
- Not offered unless shipped (UI + server 409).
- No local checkout, no local git, no Git Data API.
- Tests: detection by branch and by body, `findLinkedPR` not returning a revert
  PR, `revertPr` on a shipped payload, the 409 guard.

## Design notes

**Mechanism decided by the owner in ADR-0004, overriding ADR-0003 [7].** Both
providers do expose a public revert API (ADR-0003), but Dispatch will not call
it. It deep-links instead, so nothing is ever written to a user's repository and
the undocumented permission questions in ADR-0003 [6] stop mattering. Read
ADR-0004 for the reasoning and what it costs.

**The load-bearing hazard, and the real work of this ticket.** `findLinkedPR`
lists PRs sorted `updated`-descending and returns the *first* linkage match
(`server/providers/linkage.ts:34`, `server/providers/github.ts:328-344`). The
branch rule is deliberately loose: it matches the issue number anywhere in the
branch name. GitHub names a revert branch `revert-<prNumber>-<originalBranch>`,
so reverting a PR from branch `claude/issue-1` yields `revert-7-claude/issue-1`
— which still contains `1`, still links to issue #1, and is *newer* than the
original PR. It would therefore displace the shipping PR in `StatusPayload.pr`
the moment the user creates it.

This is why "detect and track the revert PR" is not a nicety here: without it,
the deep-link introduces a regression on the card it is launched from. Hence
`findLinkedPR` must exclude revert PRs, and `findRevertPR` must match against
the **original PR number** (not the issue number).

Do not rely on the PR *body*. GitHub's generated text is not contractual — match
branch first, body as a secondary signal, and test both.

Linkage reuse: T0-3 extracted the rule into `providers/linkage.ts`. The new
predicates belong beside it, not inline in two adapters.

## Action needed

**Human, before execution:** resolved. ADR-0004 records the owner's decision to
deep-link, which removes the outward-facing write that `docs/BUILD_PLAN-v2.md §4`
flagged for approval. Dispatch performs no write against a user repository in
this ticket, so the T1-8 approval gate no longer blocks it.

ADR-0003 [6]'s two undocumented questions (permissions for `revertPullRequest`,
its behavior on an unmerged PR) are now moot for this ticket — we never call the
mutation. They stay recorded in case a future ticket revisits the API path.
