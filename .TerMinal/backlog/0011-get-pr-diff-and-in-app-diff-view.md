---
id: 11
title: "getPRDiff() on the provider interface + in-app diff view"
status: open
priority: medium
horizon: next
hitl: false
type: feature
source: docs/BUILD_PLAN-v2.md
created: 2026-07-09
updated: 2026-07-09
prs: []
refs:
  - "docs/BUILD_PLAN-v2.md"
  - "T2-1"
depends_on: []
acceptance:
  - "getPRDiff(ref, prNumber) is added to the GitProvider interface and implemented in both the GitHub and GitLab adapters"
  - "Nothing outside server/providers/ imports Octokit or any GitLab client type — the seam holds"
  - "A unified diff renders in the app for an open PR"
  - "Large diffs are bounded: a documented file/byte cap, with truncation shown to the user rather than silently dropped"
  - "Both adapters are tested against the same table, as T0-3 does for linkage"
  - "Diff responses participate in the existing conditional-request cache rather than refetching every poll"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

The feature that keeps a professional from bouncing to github.com. v1 explicitly
made "read the diff elsewhere" a non-goal; Tier 2 reverses that.

Add `getPRDiff(ref, prNumber)` to `GitProvider`, implement it in both adapters,
and render a unified diff in the tab.

## Acceptance criteria

- `getPRDiff()` on the interface, in both adapters.
- Provider seam holds — no Octokit outside `providers/`.
- Unified diff renders for an open PR.
- Bounded: documented cap, truncation surfaced not hidden.
- Both adapters tested against one shared table.
- Diff fetches use the conditional-request cache (`providers/cond-cache.ts`).

## Design notes

The T0-5 provider seam plus the T0-9 `CondCache` are both prerequisites that
already landed; use them rather than adding new machinery.

This is Tier 2 and must not start before Tier 1's onboarding track lands. The
plan's stated reason: T2-5 depends on Dispatch owning the workflow it needs to
modify.

Deep review still links out to the provider. This closes the *common* loop, not
every loop.
