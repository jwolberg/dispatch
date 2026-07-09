---
id: 3
title: "Per-repo credential resolution (replaces the global env token)"
status: in-progress
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
  - "ADR-0006"
  - "SES-0001"
depends_on: []
acceptance:
  - "getProvider memoizes on (provider, host, installationId) instead of (provider, host)"
  - "Installation tokens are minted behind the provider seam and refreshed before their hourly expiry, with no caller outside server/providers/ aware of installations"
  - "A repo with no installation still resolves to the GITHUB_TOKEN-backed provider, and GitLab is unaffected"
  - "Memoization is preserved so the conditional-request cache survives across poll cycles"
  - "Unit tests cover: cache hit on same installation, cache miss on different installation, refresh on expired token, fallback to env token"
  - "redaction.ts is inverted to value-registration so a secret held outside process.env (a minted installation token) is redacted by safeMessage(); the existing env-scan path keeps working"
  - "A test asserts safeMessage() redacts a registered token value that never appears in process.env"
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

### This ticket does NOT depend on #2 (corrected 2026-07-09, SES-0001 [2.2])

`depends_on` said `[2]`, and `BUILD_PLAN-v2.md`'s graph draws `T1-1 ─► T1-2`. Both
contradict the plan's own prose in §T1-1/T1-2:

> land the credential seam first, with the env token still flowing through it,
> then swap the source.

Minting is unit-testable against a fake private key and a fake `fetch`; no
registered App is required. This ticket defines the `InstallationStore` interface
and a null implementation. #2 later supplies the SQLite-backed one.

### Inject the installation, do not pass it

Widening the signature to `getProvider(provider, host, installationId)` forces all
14 call sites to resolve an installation, which violates this ticket's own
"nothing outside `server/providers/` names an installation."

The precedent is in the same file: `setCondCacheStore()` injects a `CondCacheStore`
at boot from `server/index.ts`, so `providers/` never imports the db layer
(`cond-cache.ts:20–27`). Inject an `InstallationStore` the same way and resolve
`installationId` **inside** `getProvider`.

### Three call sites have no repo — split out as #21

`poller/scheduler.ts:34`, `routes/health.ts:26`, and `routes/discover.ts:21` call
`getProvider(provider)` with no repo — account-level rate limit and repo listing.
Under an App there is no account-level token; `discoverRepos()` would enumerate an
*installation's* repos. Out of scope here: they keep resolving to the env token.
Tracked as **#21**, which has real product surface (what Discover shows, what the
rate-limit banner means) and is not a mechanical rewire.

### The redactor must be inverted here, not in #2

`server/lib/redaction.ts` scans `process.env` for four hardcoded `SECRET_ENV_KEYS`.
A **minted** installation token lives only in memory and is never in `process.env`,
so `safeMessage()` would return it verbatim into a log line. The final acceptance
criterion — "no token value appears in any log line or error message" — cannot pass
without this.

ADR-0006 [6.3] found the same defect for the App private key and assigned the fix
to #2. It belongs here instead: **this** is the first ticket that holds a secret
outside the environment. Invert the redactor to value-registration (a secret
registers its value with the redactor when loaded), keeping the existing env-scan
path working.
