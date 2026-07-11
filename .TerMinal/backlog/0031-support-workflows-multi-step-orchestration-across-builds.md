---
id: 31
title: "Support /workflows — multi-step orchestration across builds"
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

Today each Dispatch build is independent: an issue triggers one
`claude-code-action` run that opens one PR, and the board tracks that run in
isolation. `/workflows` is the *how* to `/goal`'s *what* — chained, conditional,
or fan-out orchestration across builds: e.g. "when build A merges, file build B",
"run these three in parallel then a review pass", "on a failed check, open a
fix build automatically".

This is net-new. It is not in BUILD_PLAN-v2's tiers and not in the PRD §10
Future list. It layers ordering and dependency semantics on top of the flat
one-issue-one-PR model, so it needs its own scoping pass before any code.

## Open questions (resolve before scoping to `now`)

- Definition surface: is a workflow authored in the UI (a small DAG builder), as
  a committed file in the target repo, or declared in a spec chat?
- Execution engine: does the existing poller/reconcile loop drive transitions
  (`reconcileTicket` fires the next step on a state change), or is a new
  orchestrator needed? Prefer reusing the poll loop over a new subsystem.
- Triggers/edges: which build events are edges — PR merged, checks green, checks
  red, issue closed? These already exist in `deriveColumn`; a workflow is edges
  between those states.
- Failure & human gates: how does a workflow pause for the human-only merge gate
  (global §8) without stalling the whole chain? Where does a failed step surface
  (HITL inbox vs. a Blocked card)?
- Rebuild: workflow state must reconstruct from provider objects after a
  `data/dispatch.db` wipe (AC 9), same constraint as `/goal` (#30).
- Overlap with the harness `Workflow`/`/loop` concepts — decide whether Dispatch
  *surfaces* agent-side workflows or *owns* its own build-level orchestration.

## Notes

Future-horizon scoping ticket, filed to capture intent — not ready to build.
Pairs with [[0030-support-goal-a-durable-objective-that-decomposes-into-multiple-builds]].
