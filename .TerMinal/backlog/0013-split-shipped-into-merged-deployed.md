---
id: 13
title: "Split Shipped into Merged → Deployed"
status: in-progress
priority: medium
horizon: next
hitl: false
type: feature
source: docs/BUILD_PLAN-v2.md
created: 2026-07-09
updated: 2026-07-11
prs: []
refs:
  - "docs/BUILD_PLAN-v2.md"
  - "T2-3"
depends_on: []
acceptance:
  - "deriveColumn returns Merged on PR merge or issue close, and Deployed only when the default-branch deploy run succeeds"
  - "The deploy run is read from the runs already fetched at reconcile.ts:108-112 — no additional API call"
  - "A repo with no deploy run on the default branch terminates at Merged and does not hang, and the behavior is documented"
  - "A failed deploy run does not read as Deployed"
  - "The T0-2 precedence table is extended to cover every new branch, and the existing precedence is unchanged for all prior cases"
  - "The board renders both states"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

`deriveColumn` returns `Shipped` the moment the PR merges or the issue closes.
That is a lie about production. The deploy run is *already fetched* —
`reconcile.ts:108-112` switches the runs ref to the default branch for exactly
this case — and then thrown away for column purposes.

Small code change, meaningful honesty change. Tier 2 exit criterion: `Shipped`
means deployed, not merged.

## Acceptance criteria

- `Merged` on merge/close; `Deployed` only on a successful default-branch deploy
  run.
- Reuse the already-fetched runs. No extra API call.
- Repos with no deploy run terminate at `Merged`, documented, not stuck.
- A failed deploy run is not `Deployed`.
- T0-2's table extended; prior precedence unchanged.
- Board renders both.

## Design notes

The regression risk is the precedence order, which T0-2 pinned:
`Shipped` (now `Merged`) outranks `Blocked` outranks `Building` outranks
`Ready to test` outranks `Queued`. Adding a state below `Merged` must not
reorder anything above it. The table is the guard — extend it before touching
`reconcile.ts`.

"No deploy run at all" is the common case for repos that only run CI. Decide it
explicitly (terminate at `Merged`) rather than leaving a card pinned mid-board.
