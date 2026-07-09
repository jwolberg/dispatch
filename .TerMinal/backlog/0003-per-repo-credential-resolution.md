---
id: 3
title: "Per-repo credential resolution (replaces the global env token)"
status: open
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
  - "T1-2"
depends_on: [2]
acceptance:
  - "getProvider memoizes on (provider, host, installationId) instead of (provider, host)"
  - "Installation tokens are minted behind the provider seam and refreshed before their hourly expiry, with no caller outside server/providers/ aware of installations"
  - "A repo with no installation still resolves to the GITHUB_TOKEN-backed provider, and GitLab is unaffected"
  - "Memoization is preserved so the conditional-request cache survives across poll cycles"
  - "Unit tests cover: cache hit on same installation, cache miss on different installation, refresh on expired token, fallback to env token"
  - "No token value appears in any log line or error message"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

`server/providers/index.ts` is a module-level memoized factory keyed on
`(provider, host)`, reading a single global `GITHUB_TOKEN` from the environment.
GitHub Apps issue **per-installation** tokens that expire hourly. Making that
work means changing the memo key, adding minting and refresh, and doing it
without leaking the concept of an installation past the provider seam.

This is the riskiest refactor in the plan: it touches every adapter call site
indirectly. It is separated from #2 on purpose — land the credential seam first
with the env token still flowing through it, then swap the source.

## Acceptance criteria

- Memo key becomes `(provider, host, installationId)`.
- Token minting and refresh live inside `server/providers/`; nothing outside it
  imports or names an installation.
- Repos with no installation resolve to the `GITHUB_TOKEN` provider. GitLab
  behavior is unchanged.
- Memoization preserved — it is what keeps the ETag/conditional-request cache
  warm across poll cycles (a real rate-limit fix; see T0-9).
- Unit tests: same-installation cache hit, different-installation cache miss,
  refresh on expiry, env-token fallback.
- No token is ever logged.

## Design notes

The seam added by T0-5 (`setProviderFactory()`) is the test injection point;
reuse it rather than adding a second one.

Refresh strategy: mint lazily, cache with an expiry margin (refresh at ~50 min,
not at 59:59), and treat a 401 as a forced re-mint exactly once before failing.

`GITHUB_TOKEN` must keep working — it is the documented local path and the
entire GitLab story. Removing it is out of scope, now and later.
