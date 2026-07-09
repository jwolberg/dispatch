---
id: 1
title: "Spike: do GitHub App installation tokens trigger workflow runs?"
status: in-progress
priority: high
horizon: now
hitl: false
type: dx
source: docs/BUILD_PLAN-v2.md
created: 2026-07-09
updated: 2026-07-09
prs: []
refs:
  - "docs/BUILD_PLAN-v2.md"
  - "T1-0"
  - "ADR-0002"
depends_on: []
acceptance:
  - "A written answer lands in docs/decisions/ (ADR) or docs/learnings/, citing GitHub's own documentation by URL"
  - "The answer states definitively whether an event authenticated with a GitHub App installation token triggers a workflow_run, and whether the default GITHUB_TOKEN does not"
  - "The answer is backed by an observed run, not only by reading docs — record the repo, the event, and the run URL (or its absence)"
  - "The doc states the consequence for T1-3: whether GH_PAT disappears from onboarding, or must be retained"
  - "No production code is changed by this ticket"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Tier 1 is built on the claim that *events authenticated with a GitHub App
installation token do trigger workflow runs, whereas events authenticated with
the default `GITHUB_TOKEN` do not.* If that claim holds, a GitHub App dissolves
the anti-recursion footgun that `scripts/install-claude-action.sh` currently
works around with a separate `GH_PAT`, and the whole `GH_PAT` concept disappears
from onboarding. If it does not hold, the App still buys scoped per-repo tokens
but we keep minting a PAT and T1-3 gets meaningfully uglier.

This spike gates the entire browser-onboarding track (#2 → #3 → #4 → #5). Do not
start #2 before it is settled.

## Acceptance criteria

- Written answer committed under `docs/decisions/` (as an ADR) or
  `docs/learnings/`, citing GitHub documentation by URL.
- Definitive statement on both halves of the claim: installation token triggers
  runs; default `GITHUB_TOKEN` does not.
- Backed by an *observed* run in a scratch repo — record the event, and the run
  URL or its documented absence. Reading the docs is not sufficient evidence.
- Explicit consequence for #4 (`POST /api/repos/:id/setup`): does `GH_PAT` leave
  onboarding, or stay?
- No production code changes.

## Progress — 2026-07-09

Documentary half **done**: [ADR-0002](../../docs/decisions/0002-github-app-tokens-and-the-anti-recursion-rule.md)
(`status: proposed`). The claim holds, but the "default token does not trigger"
half was overstated — a `pull_request` opened by `GITHUB_TOKEN` *does* create a
run, in `action_required`. That correction already fixed a latent bug in the
acceptance criteria of #5.

Empirical half **blocked, needs approval**: acceptance criterion 3 requires an
observed run in a scratch repo. Creating a repo and running Actions against a
real GitHub account is outward-facing and was not done unilaterally.

Ticket stays `in-progress` until the observed runs are recorded in ADR-0002 §5
and the ADR moves to `accepted`.

## Design notes

Timebox to half a day. The deliverable is a paragraph and a link, not a
prototype. Use a throwaway repo; do not experiment against a user repo.

The current workaround lives in `scripts/install-claude-action.sh` and the
tribal knowledge is written up in `docs/adding-a-repo.md` — read both before
starting so the spike answers the question those documents dance around.
