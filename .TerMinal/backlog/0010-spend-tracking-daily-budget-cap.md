---
id: 10
title: "Spend tracking + daily budget cap"
status: closed
priority: high
horizon: now
hitl: false
type: feature
source: docs/BUILD_PLAN-v2.md
created: 2026-07-09
updated: 2026-07-09
prs: []
refs:
  - "docs/BUILD_PLAN-v2.md"
  - "T1-9"
depends_on: []
acceptance:
  - "A spend table records token usage and derived cost per Anthropic call, tagged by kind (chat turn, summary) and by ticket where one applies"
  - "Anthropic calls are gated on DISPATCH_DAILY_BUDGET_USD and refused once the day's spend exceeds it"
  - "A budget-blocked chat turn fails with a clear, non-destructive error that preserves the user's typed input (the existing S4 contract)"
  - "With DISPATCH_DAILY_BUDGET_USD unset, behavior is unchanged and no cap applies"
  - "The day boundary is defined explicitly (UTC) and documented"
  - "Unit tests cover: under budget, exactly at budget, over budget, unset budget, and input preservation on refusal"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Tier 1 exit criterion: the tool cannot silently spend unbounded money. A
vibecoder can trigger Anthropic spend just by talking to it. The Messages API
returns token usage on every response, so recording it is cheap.

Add a `spend` table, record usage per chat turn and per summary call, and gate
further Anthropic calls on `DISPATCH_DAILY_BUDGET_USD`.

## Acceptance criteria

- `spend` table: tokens, derived USD, call kind, ticket id where applicable,
  timestamp.
- Calls gated on `DISPATCH_DAILY_BUDGET_USD`; refused past the cap.
- Refusal is non-destructive and preserves the user's typed input — the existing
  S4 contract.
- Unset budget → no cap, unchanged behavior.
- Day boundary explicitly UTC, and documented.
- Tests: under / at / over budget, unset, and input preservation.

## Design notes

Scope is *Anthropic* spend only. Actions-minutes cost is Tier 2 (#14), which
depends on this table existing.

Price constants change. Keep them in one place, dated, and treat a model id with
no known price as an error at call time rather than silently costing $0 — a
silent $0 makes the cap a no-op exactly when a new model ships.

The summary call in #6 is billable and must flow through this recorder. Whichever
lands second wires the other.
