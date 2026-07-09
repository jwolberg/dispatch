---
id: 8
title: "Spike: revert mechanism per provider"
status: closed
priority: medium
horizon: now
hitl: false
type: dx
source: docs/BUILD_PLAN-v2.md
created: 2026-07-09
updated: 2026-07-09
prs: []
refs:
  - "docs/BUILD_PLAN-v2.md"
  - "T1-7"
depends_on: []
acceptance:
  - "A written answer lands in docs/decisions/ or docs/learnings/, citing provider documentation by URL"
  - "It states whether GitHub exposes a public API for the Revert button, and the equivalent answer for GitLab"
  - "If no public API exists, it evaluates building a revert via the Git Data API with no local checkout and states whether that is acceptable"
  - "It records a recommendation, and the fallback (deep-link to the provider's own revert affordance, then detect and track the resulting revert PR) is assumed acceptable unless the spike says otherwise"
  - "No production code is changed by this ticket"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

"Shipping something bad is recoverable in one click" is a Tier 1 exit criterion.
Before building it, establish what the providers actually offer. GitHub exposes a
Revert button in its UI; it is not established that it exposes a public API for
it, and building a revert by hand through the Git Data API without a local
checkout is genuinely awkward.

Answer before building. The plan's stated position is that the fallback is
acceptable — assume it until this spike says otherwise.

## Acceptance criteria

- Written answer in `docs/decisions/` or `docs/learnings/`, with URLs.
- Definitive: does GitHub expose a public revert API? Does GitLab?
- If not: is a Git Data API revert (no checkout) acceptable, and what does it
  cost?
- A recommendation, with the deep-link fallback as the default.
- No production code changes.

## Design notes

The honest fallback delivers most of the value: deep-link to the provider's own
revert affordance, then detect and track the resulting revert PR on the board.
One click, no local git, no invented API.

Constraint from the plan: Dispatch does not grow local worktrees or local git.
Any proposed mechanism that needs a checkout is out of bounds regardless of how
clean it looks.
