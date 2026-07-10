---
id: 22
title: "Live-verify the App path: installation token polls, and its PR triggers a run"
status: open
priority: high
horizon: now
hitl: true
type: chore
source: .TerMinal/sessions/0002-github-app-manifest-install-flow/session.md
created: 2026-07-09
updated: 2026-07-09
prs: []
refs:
  - "SES-0002"
  - "ADR-0006 [8]"
  - "ADR-0002 [5]"
  - "#2"
depends_on: [2]
acceptance:
  - "An operator registers a GitHub App on their own account through Repo Config → GitHub App, with no shell step"
  - "The App is installed on a scratch repo, and that repo's poll is observed using a minted installation token rather than GITHUB_TOKEN (#2 AC 6)"
  - "A pull request is opened with that installation token in the scratch repo, and the resulting workflow_run is recorded in ADR-0006 [8] (#2 AC 13)"
  - "ADR-0006 [8] and ADR-0002 [5] are updated: the arm moves from 'inferred, not observed' to observed, or the ADRs are amended if it turns out false"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

#2 built the whole App path and tested it against fakes. Two of its acceptance
criteria cannot be satisfied that way, because they require an App that actually
exists on GitHub, owned by the operator:

- **AC 6** — proof that a tracked repo under an installation polls with a minted
  installation token, not `GITHUB_TOKEN`.
- **AC 13** — the reason ADR-0006 exists at all.

## Why this is not busywork

ADR-0006 [8] is explicit that the central claim of the whole tier is **inferred,
not observed**:

> That a pull request opened by an *App installation token* triggers
> `pull_request` runs without approval. ADR-0002 [5] flagged this exact gap: what
> was observed was a fine-grained PAT, and GitHub's documentation treats the two
> identically for this purpose.

If the inference is wrong, #4 (`POST /api/repos/:id/setup`) and #5 (the canary) are
both shaped around a mechanism that does not work, and the `GH_PAT` that ADR-0006
deleted has to come back. #2 registers the first App — the moment one exists, this
is a fifteen-minute check that retires the largest unverified assumption in the
plan.

## Action needed

**Human.** Registering a GitHub App is the one genuinely escalating-cost click in
onboarding, and it is about the operator's own account. It never leaves their
hands (ADR-0006 [5]), which is exactly why an agent cannot do it.

Steps, once `DISPATCH_ENCRYPTION_KEY` is set:

1. Repo Config → GitHub App → name it, pick personal or org, Register on GitHub.
2. Install it on a scratch repo.
3. Confirm the repo polls under the App: the boot log names the app, and the poll
   should succeed with `GITHUB_TOKEN` deliberately unset for that repo's account.
4. Have Dispatch open a PR on that repo with the installation token, and record
   whether the `pull_request` workflow run starts or parks in `action_required`.
5. Write the result into ADR-0006 [8].
