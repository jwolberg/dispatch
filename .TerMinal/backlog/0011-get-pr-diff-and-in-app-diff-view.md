---
id: 11
title: "In-app diff view (getPRDiff landed early, in #6)"
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
  - "T2-1"
depends_on: [6]
acceptance:
  - "A unified diff renders in the app for an open PR, from the getPRDiff() that #6 landed"
  - "Nothing outside server/providers/ imports Octokit or any GitLab client type — the seam holds"
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

**Scope reduced 2026-07-09.** `getPRDiff()` was pulled forward into #6, which
needed a diff to summarize and found the interface had no way to fetch one. The
seam method and both adapter implementations therefore land in #6's PR. What
remains here is the *view*: render the unified diff in the tab. Sized down from
L; `depends_on: [6]`.

## Acceptance criteria

- Provider seam holds — no Octokit outside `providers/`.
- Unified diff renders for an open PR, consuming #6's `getPRDiff()`.
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
