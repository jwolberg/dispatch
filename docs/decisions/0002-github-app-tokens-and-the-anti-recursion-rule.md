---
id: 0002
title: GitHub App installation tokens and the anti-recursion rule
anchor: ADR-0002
status: proposed
date: 2026-07-09
supersedes:
superseded-by:
---

Spike T1-0 (ticket #1), gating Tier 1's onboarding track (#2 → #3 → #4 → #5).

**Status is `proposed`, not `accepted`:** the documentary half is settled and
cited below. The empirical half — an observed `workflow_run` in a scratch repo —
has not been performed. See [5].

## [1] Context

`docs/BUILD_PLAN-v2.md` §T1-0 asks us to verify one claim before building on it:

> events authenticated with a GitHub App installation token do trigger workflow
> runs, whereas events authenticated with the default `GITHUB_TOKEN` do not.

If true, a GitHub App dissolves the anti-recursion footgun that
`scripts/install-claude-action.sh` works around with a separate `GH_PAT`, and
`GH_PAT` disappears from onboarding.

## [2] Finding

**The claim is true, but its second half is stated too strongly, and the
overstatement is load-bearing.**

GitHub's documentation says: *"events triggered by the `GITHUB_TOKEN` will not
create a new workflow run, with the following exceptions."* The exceptions are
not marginal:

1. `workflow_dispatch` and `repository_dispatch` **always** create runs.
2. When a workflow uses `GITHUB_TOKEN` to create or update a pull request, the
   resulting `pull_request` event (activity types `opened`, `synchronize`,
   `reopened`) **does create workflow runs — in an `approval-required` state.**
   The PR shows a banner where a user with write access selects *"Approve
   workflows to run"*. Other activity types (`labeled`, `edited`, `closed`) do
   not create runs.

And on the remedy: *"use a GitHub App installation access token or a personal
access token instead of `GITHUB_TOKEN` when creating or updating the pull
request"* if you need those runs to execute without approval.

So: an installation token triggers runs normally. The default token produces a
run that exists but will not execute until a human clicks a button.

## [3] The correction, and why it matters

Both `docs/adding-a-repo.md` and `BUILD_PLAN-v2.md` §T1-4 describe the broken
configuration as one where a PR opened by the default token **"silently never
triggers CI."** That is not what happens. A run *is* created; it sits in
`action_required`, with a banner.

This is not a pedantic distinction. Ticket #5 (T1-4, the canary) currently
specifies: *"poll for a `workflow_run` within a bounded window"* and record
pass/fail. **A canary that checks for the existence of a run would pass on a
repo that is misconfigured in exactly the way the canary exists to detect.** The
run exists. It just never executes.

The canary must assert on run *status*, not run presence. Ticket #5's acceptance
criteria have been amended accordingly.

## [4] Consequences

**#4 (T1-3) — `GH_PAT` leaves onboarding, but is replaced, not eliminated.**

The workflow still needs a non-default token *at runtime* to push the branch and
open the PR (today: `secrets.GH_PAT`, at
`scripts/install-claude-action.sh:126,139`). An installation token expires after
one hour, so it cannot simply be stored as a repo secret. The canonical pattern
is `actions/create-github-app-token`, which mints one inside the workflow from:

- `client-id` — the App's client id, a repo **variable**;
- `private-key` — the App's private key, a repo **secret**.

So `POST /api/repos/:id/setup` (#4) writes `APP_CLIENT_ID` + `APP_PRIVATE_KEY`
instead of `GH_PAT`. One secret becomes one secret. Onboarding loses the PAT
scope matrix — the actual goal — because the user never mints anything.

**The tradeoff, flagged for explicit approval before #4 executes:** a
fine-grained `GH_PAT` is scoped to one repo. An App private key can mint tokens
for *every installation of that App*. Writing it into each user repo's secrets
inverts the blast radius: compromise of one onboarded repo's secrets compromises
all of them. This is strictly worse than the status quo on that axis, and #4
must not proceed on the assumption that "App = more secure."

Two alternatives worth costing before committing, neither yet verified:

- **(a)** Have Dispatch's server — which already holds the installation token
  after #3 — open the PR, leaving the workflow on `GITHUB_TOKEN`. Moves the
  credential out of the user's repo entirely.
- **(b)** Let the workflow open the PR with `GITHUB_TOKEN`, accept the
  `action_required` state, and have Dispatch approve the run via the API. Whether
  a public approve endpoint covers this case (as opposed to only fork PRs) is
  **not established** and would itself need a spike.

**#5 (T1-4) — assert status, not existence.** See [3]. Amended.

**#2 (T1-1) and #3 (T1-2) — unchanged.** The App is still worth registering, and
the credential seam still lands before the source swaps.

## [5] Unverified, and what would close it

Acceptance criterion 3 on ticket #1 requires an *observed* run, not a reading of
the docs, precisely because this ADR's whole value is catching a place where the
docs and our prior belief diverged. Outstanding:

- In a scratch repo, open a PR authenticated with `GITHUB_TOKEN`; record the run
  id and confirm its status is `action_required`.
- Repeat with an installation access token; confirm the run executes.
- Record both run URLs here and move this ADR to `accepted`.

Creating a scratch repo and running Actions against a real GitHub account is an
outward-facing action and has not been taken without approval.

## [6] Sources

- <https://docs.github.com/en/actions/concepts/security/github_token>
- <https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow>
- <https://github.com/actions/create-github-app-token>
- <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow>
