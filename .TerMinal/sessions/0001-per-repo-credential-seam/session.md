---
id: 1
slug: per-repo-credential-seam
anchor: SES-0001
title: "Per-repo credential seam (#3) — memoize on installation, env token still flowing"
status: active
started: 2026-07-09T21:15:00Z
ended: null
goal: "Land the per-repo credential seam (#3): memoize getProvider on installation, mint/refresh tokens behind providers/, env token still flowing through"
tickets: [3]
branches: []
prs: []
related_research: []
related_docs:
  - "docs/decisions/0002-github-app-tokens-and-the-anti-recursion-rule.md"
  - "docs/decisions/0006-dispatch-opens-the-pr-and-the-app-is-registered-per-deployment.md"
  - "docs/BUILD_PLAN-v2.md"
  - "docs/implementation-notes.md"
prior_sessions: []
---

## [1] Goal

Land the per-repo credential seam (#3): memoize `getProvider` on installation,
mint/refresh tokens behind `providers/`, env token still flowing through.

`docs/BUILD_PLAN-v2.md` §T1-1/T1-2 calls this **"the riskiest refactor in the
plan"** and says why it is separated from #2:

> land the credential seam first, with the env token still flowing through it,
> then swap the source.

So the bar for this session is: **nothing changes behaviorally.** Every call site
keeps resolving to the `GITHUB_TOKEN`-backed adapter, the ETag cache keeps
surviving poll cycles, and the seam is ready for #2 to plug a real installation
store into.

## [2] Context & pointers

### [2.1] Ticket in scope

**#3 — Per-repo credential resolution (replaces the global env token).** Acceptance:

- `getProvider` memoizes on `(provider, host, installationId)` instead of `(provider, host)`.
- Installation tokens minted behind the seam and refreshed before hourly expiry,
  with **no caller outside `server/providers/` aware of installations**.
- A repo with no installation still resolves to the `GITHUB_TOKEN`-backed
  provider; GitLab unaffected.
- Memoization preserved so the conditional-request cache survives poll cycles.
- Unit tests: cache hit on same installation, cache miss on different
  installation, refresh on expired token, fallback to env token.
- No token value in any log line or error message.

### [2.2] Dependency correction — #3 does not depend on #2

`.TerMinal/backlog/0003-*.md` carries `depends_on: [2]`, and
`BUILD_PLAN-v2.md`'s graph draws `T1-1 ─► T1-2` sequentially. **Both contradict
the plan's own prose**, quoted in [1]: the seam lands first, with the env token
still flowing through it. Minting is unit-testable against a fake key and a fake
`fetch`; no registered App is required.

**Decision (flat cost, reversible): invert it.** #3 depends on nothing. #3 defines
the `InstallationStore` *interface* plus a null implementation; #2 later supplies
the SQLite-backed one. Corrected in the ticket as part of this session.

### [2.3] The shape, and the trap

`server/providers/index.ts` memoizes on `` `${provider}:${host ?? ""}` `` and
constructs `new GitHubProvider(requireEnv("GITHUB_TOKEN"), host, condStore)`.

The obvious move — widen the signature to `getProvider(provider, host, installationId)`
— **fails #3's own acceptance criterion**, because all 14 call sites would then
have to look up an installation, which is precisely "a caller outside
`server/providers/` aware of installations."

The precedent is already in the file. `setCondCacheStore()` injects a
`CondCacheStore` at boot from `server/index.ts`, so `providers/` never imports the
db layer (`cond-cache.ts:20–27`). Do the same for installations: inject an
`InstallationStore`, resolve `installationId` *inside* `getProvider` from the
`(provider, host, path)` it is already given.

### [2.4] The wrinkle: three call sites have no repo

| Call site | Call | Scope |
|---|---|---|
| `poller/scheduler.ts:34` | `getProvider("github")` | account-level rate limit |
| `routes/health.ts:26` | `getProvider(provider)` | account-level rate limit |
| `routes/discover.ts:21` | `getProvider(provider)` | account-level repo listing |

Under a GitHub App there is no account-level token — `discoverRepos()` would
enumerate an *installation's* repos. Resolving that is **#2's problem, not this
session's.** Here they keep resolving to the env token, and the seam is shaped so
#2 can revisit them. Note it in the ticket rather than silently designing for it.

The other 11 call sites pass `(repo.provider, repo.host)` off a `repos` row and
are mechanical.

### [2.5] Why "no token in logs" is not free

`server/lib/redaction.ts` redacts by scanning `process.env` for four hardcoded
`SECRET_ENV_KEYS`. A **minted** installation token exists only in memory and is
never in `process.env`, so `safeMessage()` would pass it through verbatim.

This is the same defect ADR-0006 [6.3] found for the App private key, arriving
one ticket earlier than expected. #3's last acceptance criterion cannot pass
without inverting the redactor to **value-registration**. ADR-0006 [7] assigned
that work to #2 as a prerequisite; it actually belongs here, because #3 is what
first puts a secret outside the environment.

### [2.6] Docs

- **ADR-0002** — the anti-recursion finding; [3.1] the two default-token failure
  modes; [5] what is observed vs inferred.
- **ADR-0006** — Dispatch opens the PR; the App registers per deployment; [6.3]
  the redactor defect.
- `docs/implementation-notes.md` — running log; append decisions/deviations here.

### [2.7] Git & PR state

Branch `docs/adr-0006-app-registration-and-pr-authorship`, one commit ahead of
`main` (`41ce7cd`), not pushed. No open PRs. PRs #4–#9 merged and reconciled —
`bin/tickets` shows no stale `in-progress`, so no `/merge-sync` needed.

## [3] Checklist

- [ ] 0003 — correct `depends_on` and fold the redactor prerequisite into the ticket ([2.2], [2.5])
- [ ] 0003 — branch off `main` for the seam work
- [ ] 0003 — write failing test: `safeMessage()` redacts a registered secret value that is absent from `process.env`
- [ ] 0003 — implement value-registration in `redaction.ts`; keep the env-scan path working
- [ ] 0003 — write failing test: `getProvider` returns the same instance for the same installation (ETag cache survives)
- [ ] 0003 — write failing test: `getProvider` returns a *different* instance for a different installation
- [ ] 0003 — write failing test: a repo with no installation resolves to the `GITHUB_TOKEN` adapter, and GitLab is untouched
- [ ] 0003 — write failing test: an expired installation token is refreshed before use
- [ ] 0003 — implement `InstallationStore` + `TokenSource` behind the seam; rekey the memo on `(provider, host, installationId)`
- [ ] 0003 — verify no call site outside `server/providers/` mentions an installation (`npm run check:seam` + grep)
- [ ] 0003 — `npm run verify` green (280 tests + seam guard)
- [ ] 0003 — open PR + link PR url into ticket 0003 `prs:`

Deferred to Follow-ups: rewiring `discoverRepos`/rate-limit to installations
([2.4]) — that is #2's swap, not the seam.

## [4] Log

- 2026-07-09 — Session opened. ADR-0006 landed on a branch just before this
  (PR-authorship + per-deployment App registration); #3 is the next step and is
  unblocked once [2.2]'s dependency inversion is recorded.

## [5] Decisions

- **#3 depends on nothing, not on #2** ([2.2]). The plan's prose beats its graph.
- **Installations are injected, not passed** ([2.3]). Mirrors `setCondCacheStore`.
- **The redactor inversion lands here, not in #2** ([2.5]). #3 is the first ticket
  to hold a secret outside `process.env`.

## [6] Outcomes

_pending_

## [7] Follow-ups

_pending_

## [8] Notes

_pending_
