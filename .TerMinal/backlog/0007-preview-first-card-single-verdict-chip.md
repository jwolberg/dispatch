---
id: 7
title: "Preview-first card: hero preview + single verdict chip"
status: in-progress
priority: medium
horizon: now
hitl: false
type: ux
source: docs/BUILD_PLAN-v2.md
created: 2026-07-09
updated: 2026-07-09
prs:
  - "https://github.com/jwolberg/dispatch/pull/5"
refs:
  - "docs/BUILD_PLAN-v2.md"
  - "T1-6"
depends_on: [6]
acceptance:
  - "The card leads with the plain-language summary and one green/red verdict chip"
  - "The per-check list is demoted behind a disclosure and is not visible by default"
  - "The verdict chip is derived from the same check state deriveColumn uses — one source of truth, not a parallel computation"
  - "A pending/unknown check state renders as a distinct third state, not silently as green"
  - "The card is legible on a phone-width viewport"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

A non-engineer reading a card should see one verdict, not seven check names.
Promote the summary from #6 above the fold, collapse the check list behind a
disclosure, and replace it with a single chip.

## Acceptance criteria

- Summary + single verdict chip lead the card.
- Per-check list hidden behind a disclosure by default.
- Chip derives from the same check state as `deriveColumn` — no second
  implementation of "are we green".
- Pending/unknown is its own state. Never render pending as green.
- Legible at phone width (responsive web remains the mobile story; there is no
  native app).

## Design notes

**Scoped out deliberately:** preview screenshots. They need a headless browser in
the container and are not worth the image size in this tier. File a follow-up
ticket rather than smuggling them in here. "Hero preview" in this tier means the
summary block, not a rendered screenshot.

The third state matters: the whole point of T0-2's precedence table is that
`Blocked` and `Building` are different things. A chip that flattens pending into
green re-introduces the lie one layer up.
