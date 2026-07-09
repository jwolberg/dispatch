---
id: 0004
title: Revert ships as a deep-link, not an API call
anchor: ADR-0004
status: accepted
date: 2026-07-09
supersedes: 0003 (the recommendation in [7]; its findings stand)
superseded-by:
---

Owner decision on #9 (T1-8), taken 2026-07-09 against ADR-0003's recommendation.
ADR-0003's *findings* are unchanged and still correct — both providers expose a
public revert API. This ADR records that Dispatch will not call it, and why that
is a reasonable trade rather than a retreat.

## [1] Context

ADR-0003 §[7] recommended Dispatch call the provider API: `revertPullRequest` on
GitHub, a synthesized MR on GitLab. `docs/BUILD_PLAN-v2.md` §4 lists "T1-8
(creates revert PRs)" among the escalating-cost items requiring explicit human
approval before execution. At that gate, the owner chose the third option:
**deep-link only.** Dispatch performs no write against a user's repository.

## [2] Decision

The revert affordance on a shipped card opens the provider's own revert page.
Dispatch then detects the resulting revert PR and tracks it on the board.

- **GitHub** — `PullRequest.revertUrl`, a first-class GraphQL field, resolved on
  demand. Confirmed GET-addressable: `https://github.com/jwolberg/dispatch/pull/5/revert`
  returns 200. Derived, never string-built.
- **GitLab** — the MR's own web url. `api/v4` exposes no revert page; the MR
  page's Revert button is a Rails action. This is a genuinely worse experience
  and [4] says so plainly.

Dispatch never calls `revertPullRequest`, never creates a branch, commit, or MR,
and never writes to a default branch.

## [3] Why this is defensible

**The blast radius goes to zero.** The API path has Dispatch — a tool a
non-engineer clicks buttons in — opening pull requests inside repositories it was
handed a credential for. The deep-link path has Dispatch opening a browser tab.
Every failure mode that involves Dispatch writing the wrong thing to the wrong
repository disappears, because Dispatch writes nothing.

**Both of ADR-0003 §[6]'s undocumented questions stop mattering.** We could not
establish which permissions `revertPullRequest` requires, whether a GitHub App
installation token can call it (which couples to #3), or what it does against an
unmerged PR. All three were live risks for the API path and are now moot. That is
not a small thing: it removes a dependency between #9 and the credential model
that #3 has not settled yet.

**The user is authenticated as themselves.** On the provider's page the revert is
attributed to the human, reviewed by the human, and governed by the provider's
own branch protections — not by Dispatch's re-implementation of them.

## [4] What it costs, stated honestly

**Tier 1's exit criterion is "recoverable in one click."** This is one click *to
the provider*, then one or two more there. The recovery path is always one click
away, which is the property that matters, but the literal claim is now weaker and
`docs/BUILD_PLAN-v2.md` should not be read as satisfied by the letter of it.

**The two providers will not feel the same.** GitHub has a dedicated revert page
that pre-stages the branch. GitLab has no addressable equivalent, so the user
lands on the MR and hunts for the button. Symmetry was one of the API path's
better properties and we are giving it up.

**The user leaves the app** at the exact moment something has gone wrong in
production, which is the moment a nervous non-engineer least wants to be handed
off to an unfamiliar interface.

If any of these bite, the API path is fully specified in ADR-0003 and the
mechanism is proven; reversing this decision is a `revertPR()` implementation
behind the same `GitProvider` seam, not a redesign.

## [5] Consequences — the deep-link is not the cheap option it looks like

Choosing deep-link does **not** reduce #9 to a hyperlink, because detection is
now load-bearing rather than decorative.

`findLinkedPR` lists PRs sorted `updated`-descending and returns the first
linkage match (`server/providers/linkage.ts:34`,
`server/providers/github.ts:328-344`). The branch rule matches the issue number
*anywhere* in the branch name — deliberately, so `fix-7` and `7-add-thing` both
link to issue #7. GitHub names a revert branch `revert-<prNumber>-<originalBranch>`.
So reverting the PR on branch `claude/issue-1` produces `revert-7-claude/issue-1`,
which still contains `1`, still links to issue #1, and is newer than the original.

**The revert PR would therefore displace the shipping PR in `StatusPayload.pr`
the moment the user creates it** — on the very card the revert button lives on.
The deep-link *creates* this hazard (Dispatch no longer knows the revert PR's
number, because it did not open it) where the API path would have handed us the
number directly.

So #9 must:

1. Add `findRevertPR(ref, prNumber)`, matching against the **original PR
   number** — by branch (`revert-<n>-*`) and, as a secondary signal, by body
   (`Reverts … #<n>`). GitHub's generated body text is not contractual; match
   branch first and test both.
2. Make `findLinkedPR` **exclude** revert PRs, so the original PR stays put.
3. Add `StatusPayload.revertPr`, so a shipped card can show both without the
   column leaving `Shipped`.
4. Write an activity row when a revert PR is first detected.
5. Add `getRevertUrl(ref, prNumber)` and a server route gated on shipped (409
   otherwise). The guard is re-validated server-side rather than trusted from the
   client, matching the Ship route (`server/routes/tickets.ts:250-322`).

Note the pleasing consequence of (2): it is a bug fix independent of revert.
Any PR whose branch happened to contain the issue number and was updated more
recently than the real PR could already displace it. Revert is simply the first
case that guarantees it happens.

## [6] Status of ADR-0003

Findings — both providers expose a public API, GitHub's is GraphQL-only, GitLab's
is a commit-level primitive that writes directly to a branch, and the Git Data
API tree-snapshot approach is a trap — **all stand and are unaffected.**

Only §[7]'s recommendation is superseded. §[4]'s rejection of the Git Data API
still binds: nothing in #9 may reach for it.
