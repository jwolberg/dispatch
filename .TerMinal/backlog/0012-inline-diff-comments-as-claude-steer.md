---
id: 12
title: "Inline diff comments that post as @claude steer comments"
status: in-progress
priority: medium
horizon: next
hitl: false
type: feature
source: docs/BUILD_PLAN-v2.md
created: 2026-07-09
updated: 2026-07-12
prs: []
refs:
  - "docs/BUILD_PLAN-v2.md"
  - "T2-2"
depends_on: [11]
acceptance:
  - "A comment on a diff line posts through the existing POST /api/tickets/:id/comment path — no second comment path is introduced"
  - "The posted comment is anchored to file:line and mentions @claude so the agent picks it up"
  - "The anchor survives a subsequent push that shifts line numbers, or the comment is visibly marked as outdated"
  - "The resulting agent run appears on the card like any other run"
  - "Tests cover anchor formatting and the outdated-anchor case"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Reading the diff in-app is half the loop. The other half is steering the agent
from it: comment on a line, and that becomes an `@claude` instruction anchored to
`file:line`.

## Acceptance criteria

- Reuses `POST /api/tickets/:id/comment`. No parallel comment path.
- Comment anchored to `file:line`, mentions `@claude`.
- A push that shifts lines either re-anchors or marks the comment outdated —
  never silently points at the wrong line.
- Resulting agent run surfaces on the card.
- Tests: anchor format, outdated anchor.

## Design notes

The outdated-anchor case is the one that will be skipped. A comment silently
retargeted to a different line after a push is worse than no comment: it steers
the agent at code the reviewer never read.

Depends on #11 for the diff itself.
