---
id: 0002
title: GitHub App installation tokens and the anti-recursion rule
anchor: ADR-0002
status: accepted
date: 2026-07-09
supersedes:
superseded-by:
---

Spike T1-0 (ticket #1), gating Tier 1's onboarding track (#2 → #3 → #4 → #5).

`accepted` on the decision it enables — the App is worth registering and the
non-default-token mechanism is real. One arm rests on documentation rather than
observation, and [5] says exactly which. Read [5] before relying on that arm.

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

## [3.1] A second, earlier failure mode: Actions may not be allowed to open a PR at all

Observed on `jwolberg/situation` (2026-07-09):
`GET /repos/jwolberg/situation/actions/permissions/workflow` returns
`can_approve_pull_request_reviews: false`. That field backs the repository
setting **"Allow GitHub Actions to create and approve pull requests."** With it
off, a workflow using `GITHUB_TOKEN` cannot open a pull request at all — the API
returns 403 *"GitHub Actions is not permitted to create or approve pull
requests."*

So the default-token path has **two** distinct failure modes, not one:

| Setting | What happens with `GITHUB_TOKEN` |
|---|---|
| Actions may create PRs | PR opens; `pull_request` run is created but parks in `action_required` |
| Actions may **not** create PRs | PR never opens; 403 at creation |

The second is a *harder* failure — nothing to approve, no banner, no run. It is
also `situation`'s current posture, and the setting is governed at
enterprise → org → repo, so a repo-level fix can be silently overridden upstream.

Consequences: #5's canary must distinguish these two signatures in its
"actionable message" criterion, and #4's setup must either detect the setting or
sidestep it. A GitHub App installation token is not `GITHUB_TOKEN` and is
unaffected by this toggle — one more point in the App's favor, and one that the
plan did not know about.

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

> **Resolved 2026-07-09 by ADR-0006 [2]:** alternative (a). Dispatch's server
> opens the pull request; no App credential is written into any user repo. The
> approval gate below is closed. ADR-0006 [3] also finds that (a) is closer to a
> *deletion* than a move — `claude-code-action` never opened PRs itself.

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

## [5] Evidence: what was observed, what was inferred

Ticket #1's third acceptance criterion demanded an *observed* run rather than a
reading of the docs. Here is exactly how much of that we have.

**Observed — a non-default token opens a PR and CI executes normally.**
`jwolberg/situation` is already onboarded by `scripts/install-claude-action.sh`,
so `claude.yml` opens PRs with `secrets.GH_PAT`. Its history is the experiment,
already run:

- PR [#22](https://github.com/jwolberg/situation/pull/22), head
  `fix/fx-snapshot-empty-map-clears-quotes`, author `jwolberg` (the PAT's
  identity — not `github-actions[bot]`).
- The `pull_request` event created run
  [29033394141](https://github.com/jwolberg/situation/actions/runs/29033394141):
  workflow `CI`, `status: completed`, `conclusion: success`, `actor: jwolberg`.
  No approval gate.

**Observed — this repo cannot open a PR with `GITHUB_TOKEN` at all.** See [3.1].

**Inferred, not observed — `GITHUB_TOKEN` reaching `action_required`.** Producing
it requires enabling "Allow GitHub Actions to create and approve pull requests"
on a real repo. That was declined (2026-07-09), correctly: the state we would
have manufactured is not this repo's actual posture, and [3.1] is the failure
mode that would really bite. This arm rests on GitHub's documentation, quoted in
[2].

**Observed 2026-07-10 (was inferred) — an *installation* token specifically.**
Originally we observed only a fine-grained PAT, and substituted it for an
installation token on the strength of GitHub's documentation, which names them in
the same sentence as the remedy. That substitution was a deliberate choice
(2026-07-09) to avoid registering a GitHub App — ticket #2, the thing this spike
gated.

#2 registered App `dispatch-jay`, and #22 then ran the observation directly: a PR
opened by installation token 145573719 on `jwolberg/cohort-bot` created
`pull_request` run
[29065952153](https://github.com/jwolberg/cohort-bot/actions/runs/29065952153) —
`status: completed`, `conclusion: success`, no approval gate, with `actor` and
`triggering_actor` both `dispatch-jay[bot]` rather than a human login. The PAT and
the installation token therefore behave identically here, as documented. The gap is
closed; see ADR-0006 [8] for the full record.

The caution it raised has been discharged, not merely aged out: #4's design may now
rely on this behavior, because a PAT and an installation token have been
distinguished — and they agree.

## [6] Sources

- <https://docs.github.com/en/actions/concepts/security/github_token>
- <https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow>
- <https://github.com/actions/create-github-app-token>
- <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow>
