---
id: 15
title: "Review-artifact contract + Ship gated on verdict"
status: in-progress
priority: high
horizon: next
hitl: false
type: security
source: docs/BUILD_PLAN-v2.md
created: 2026-07-09
updated: 2026-07-11
prs:
  - "https://github.com/jwolberg/dispatch/pull/47"
refs:
  - "docs/BUILD_PLAN-v2.md"
  - "T2-5"
  - "scripts/repo-skills/"
depends_on: [4]
acceptance:
  - "The CI review step emits .reviews/<pr>/<sha>.md plus findings.json and suggestions.json, matching TerMinal's existing contract"
  - "Dispatch fetches and renders that artifact on the card"
  - "Ship is refused unless verdict is approve, test_status is pass, and there are zero findings at medium or above"
  - "A missing or unparseable artifact blocks Ship — it does not fall through to allowed"
  - "The server re-validates the gate; a client that hides the button is not the gate"
  - "Neither product imports the other; the shared surface is the artifact schema alone"
  - "Integration tests assert refusal on each failing branch and success only on the full bar"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Dispatch holds a token that merges to production, and roughly 45% of
AI-generated code violates the OWASP Top 10 by industry benchmark. Tier 1
deliberately deferred the automated review gate rather than shipping a
half-trusted second signal. This is the ticket that does it properly.

TerMinal already renders `.reviews/<pr>/<sha>.md` + `findings.json` +
`suggestions.json`, with a merge bar of `verdict: approve` + `test_status: pass`
+ zero findings ≥ medium. Dispatch already installs skills into target repos.
Have CI emit that artifact, have Dispatch render it, gate Ship on the same bar.

The two products then share one review contract without either importing the
other: TerMinal is the local workbench, Dispatch is the browser board, and one
repo can be driven from either. Highest-leverage integration available, and most
of it exists on both sides already.

## Scope note (2026-07-11)

Split during the Tier 2 stack. This ticket delivers the **consumption + gate**
side (fetch, render, fail-closed Ship gate re-validated server-side — the ACs
below except the first). The **CI emission** of the artifact triple (the first
AC) is carved into **#34**, because it is a standalone build that runs in the
user's CI and writes a workflow + review credential into user repos, with its
own anti-recursion/auth concerns. The gate here is fail-closed, so it is correct
and safe before #34 lands — every PR simply stays blocked until a review exists.

## Acceptance criteria

- CI review step emits the TerMinal artifact triple. **→ moved to #34.**
- Dispatch fetches and renders it.
- Ship gated on `verdict: approve` + `test_status: pass` + zero findings ≥
  medium.
- Missing/unparseable artifact → **blocked**, never allowed.
- Gate re-validated server-side, as `POST /api/tickets/:id/merge` already does
  for checks.
- No cross-import between the products. The schema is the whole interface.
- Integration tests on every refusal branch.

## Design notes

Depends on #4: Dispatch must own the workflow it needs to modify before it can
add a review step to it.

Fail-closed is the entire security property. A gate that opens when the artifact
is absent is not a gate — and "absent" is the normal state on the first run after
a repo is onboarded, so this path *will* be exercised.

The merge endpoint (`server/routes/tickets.ts:252`) already re-validates checks
server-side and has an integration test harness from T0-5. Extend it; do not
build a second gate.
