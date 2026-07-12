---
id: 14
title: "Per-ticket cost telemetry (Actions minutes + Claude tokens)"
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
  - "T2-4"
depends_on: [10]
acceptance:
  - "Each ticket shows a cost attributable to it: Claude tokens from the spend table plus Actions minutes from the workflow runs linked to its PR"
  - "Actions minutes are read from the provider's run timing data, not estimated from wall-clock"
  - "A run that cannot be priced is reported as unknown, never as zero"
  - "The cost surface is a disposable derived view — wiping it and recomputing changes nothing"
  - "GitLab repos degrade to tokens-only without erroring"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

#10 caps what a vibecoder can spend by talking. This ticket answers the
professional's question instead: what did this ticket cost to build? That means
Claude tokens plus GitHub Actions minutes, attributed per ticket.

## Acceptance criteria

- Per-ticket cost: tokens (from the `spend` table) + Actions minutes (from runs
  linked to the ticket's PR).
- Minutes come from the provider's run timing data, not wall-clock estimates.
- Unpriceable runs read as `unknown`, never `0`.
- Derived and disposable — recomputable from provider data and the spend table.
- GitLab degrades to tokens-only, no error.

## Design notes

Depends on #10 for the `spend` table.

`unknown` vs `0` is the same failure shape as #10's missing-price case: a silent
zero makes the number look precise exactly where it is absent. Both should use
the same convention.

Runner-class pricing differs (a larger runner bills a multiplier per minute).
Either model it or state plainly in the UI that the figure assumes the standard
runner. Do not quietly under-report.
