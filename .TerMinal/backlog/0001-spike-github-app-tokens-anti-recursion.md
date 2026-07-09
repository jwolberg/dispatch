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

## Outcome — 2026-07-09

Answered. Deliverable: [ADR-0002](../../docs/decisions/0002-github-app-tokens-and-the-anti-recursion-rule.md)
(`accepted`). The plan's claim holds; two corrections came out of it.

1. "The default token does not trigger" is overstated. A `pull_request` opened by
   `GITHUB_TOKEN` *does* create a run — parked in `action_required`. This fixed a
   latent bug in #5, whose canary polled for run *existence* and would have gone
   green on the exact misconfiguration it exists to catch.
2. There is an earlier failure mode nobody had written down: with "Allow GitHub
   Actions to create and approve pull requests" off, `GITHUB_TOKEN` cannot open a
   PR at all (403). `jwolberg/situation` is in that state today. #4 and #5 both
   amended.

`GH_PAT` does leave onboarding — replaced by `APP_CLIENT_ID` + `APP_PRIVATE_KEY`,
which inverts the credential blast radius. Flagged as an approval gate on #4.

**Evidence, honestly:** the non-default-token arm was *observed*
(`jwolberg/situation` PR #22 → run 29033394141, `conclusion: success`). The
`action_required` arm and the App-token-specifically arm rest on GitHub's
documentation — see ADR-0002 [5] for why each was not measured and what would
close the gap. AC 3 is therefore **partially met by design**, with the residual
gap named rather than papered over.

Closes when its PR merges (per CLAUDE.md [4.1]).

## Design notes

Timebox to half a day. The deliverable is a paragraph and a link, not a
prototype. Use a throwaway repo; do not experiment against a user repo.

The current workaround lives in `scripts/install-claude-action.sh` and the
tribal knowledge is written up in `docs/adding-a-repo.md` — read both before
starting so the spike answers the question those documents dance around.
