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
  - "The mechanism matches whatever #8 concluded; if the fallback, it deep-links to the provider's revert UI and then detects and tracks the resulting revert PR on the board"
  - "The resulting revert PR appears on the board linked to the original ticket, not as an orphan card"
  - "Revert is not offered on a card that has not shipped"
  - "Nothing in this ticket requires a local checkout or local git"
  - "Tests cover: revert PR detection, linkage to the original ticket, and the not-shipped guard"
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
- Mechanism per #8's conclusion. If the fallback: deep-link out, then detect and
  track the revert PR.
- Revert PR shows on the board, linked to the original ticket.
- No revert affordance on a card that has not shipped.
- No local checkout, no local git.
- Tests: detection, linkage, not-shipped guard.

## Design notes

Linkage reuse: T0-3 already extracted the PR-linkage rule into
`providers/linkage.ts` and tested it. A revert PR body referencing the original
should resolve through that same path rather than a new regex.

## Action needed

**Human, before execution:** creating revert PRs in a user's repository is an
escalating-cost, outward-facing action, flagged in `docs/BUILD_PLAN-v2.md §4` for
explicit approval. Confirm the mechanism (from #8) and approve before executing.
Do not run against a real user repo during development.
