---
id: 33
title: "Precise deploy-run identification (main-branch CI reads as Deployed)"
status: open
priority: low
horizon: future
hitl: false
type: feature
source: docs/BUILD_PLAN-v2.md
created: 2026-07-11
updated: 2026-07-11
prs: []
refs:
  - "T2-3"
  - "server/poller/reconcile.ts"
depends_on: [13]
acceptance:
  - "A default-branch run that is CI (tests/lint) and not a deployment does not advance a card to Deployed"
  - "Deploy-workflow identification is per-repo and explicit, not a name heuristic invented without real data"
  - "A repo with a genuine deploy workflow reaches Deployed only when that workflow succeeds"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Follow-up from #13 (T2-3). `deriveColumn` currently treats **any** successful
default-branch workflow run as the deploy signal, so a repo that runs tests/lint
`on: push` to `main` (but has no deploy) will read as `Deployed` rather than
`Merged`. #13 accepted this deliberately — the poller already fetches the
default-branch runs, and inventing a deploy-name regex without real run data
would violate the "sample, never infer" rule (see the
`verify-generated-formats-against-real-data` learning).

This ticket does it properly: identify the deploy workflow per repo (a stored
workflow name/id, or the GitHub `deployment`/`deployment_status` event once real
samples confirm the shape), so `Deployed` means the deploy specifically
succeeded — not that some main-branch job passed.

## Design notes

Sample real deploy runs (Vercel/Netlify/Pages, and a plain `deploy.yml`) before
encoding any matcher. Prefer an explicit per-repo config field over a heuristic.
Keep the fail-safe: unknown/absent deploy → terminate at `Merged`, never claim
`Deployed`.
