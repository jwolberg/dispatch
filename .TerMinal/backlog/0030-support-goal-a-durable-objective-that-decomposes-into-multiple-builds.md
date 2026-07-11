---
id: 30
title: "Support /goal — a durable objective that decomposes into multiple issues/builds"
status: open
priority: medium
horizon: future
hitl: false
type: feature
source: feedback
created: 2026-07-11
updated: 2026-07-11
prs: []
refs:
  - "docs/PRD-dispatch.md [10]"
  - "docs/PRD-dispatch.md [2]"
depends_on: []
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Dispatch's v1 unit of work is deliberately flat: one spec chat produces one
`@claude`-triggering issue, which produces one PR, tracked as one card
(PRD Goals G1–G4). A `/goal` is a higher-level unit — a durable objective the
operator states once ("ship OIDC auth", "cut Actions spend 30%") that Dispatch
decomposes into, and tracks across, **multiple** issues/builds over time.

This is net-new. It is not in BUILD_PLAN-v2's tiers and not in the PRD §10
Future list; it changes the core "one ticket" abstraction the board is built
around, so it needs its own scoping pass before any code.

## Open questions (resolve before scoping to `now`)

- Data model: is a goal a first-class row that owns child tickets, or a saved
  spec-chat thread that spawns issues? How does the board render a goal vs. its
  child cards?
- Decomposition: does Dispatch (via the spec-chat model) propose the child
  issues for one-click filing, or does the operator break the goal down by hand?
- Progress: how is a goal "done" — all children shipped, or an explicit
  acceptance the operator marks? How does ≤30s-staleness progress (G3) roll up
  from N builds to one goal?
- Persistence & rebuild: goals must survive `data/dispatch.db` deletion and
  rebuild from the provider like cards do (AC 9) — but a goal has no GitHub
  object of its own. Where is the source of truth?
- Relationship to `/workflows` (#31) — a goal is *what*, a workflow is *how*;
  scope the two together or one depends on the other.

## Notes

Future-horizon scoping ticket, filed to capture intent — not ready to build.
Pairs with [[0031-support-workflows-multi-step-orchestration-across-builds]].
