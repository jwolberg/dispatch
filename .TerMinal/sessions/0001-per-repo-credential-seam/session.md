---
id: 1
slug: per-repo-credential-seam
anchor: SES-0001
title: "Per-repo credential seam (#3) — memoize on installation, env token still flowing"
status: closed
started: 2026-07-09T21:15:00Z
ended: 2026-07-09T22:05:00Z
goal: "Land the per-repo credential seam (#3): memoize getProvider on installation, mint/refresh tokens behind providers/, env token still flowing through"
tickets: [3, 21]
branches:
  - "feat/3-per-repo-credential-seam"
prs:
  - "https://github.com/jwolberg/dispatch/pull/10"
related_research: []
related_docs:
  - "docs/learnings/cached-credentials-and-shared-mutable-state.md"
  - "docs/architecture.md"
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

- [x] 0003 — correct `depends_on` and fold the redactor prerequisite into the ticket ([2.2], [2.5])
- [x] 0003 — branch off `main` for the seam work
- [x] 0003 — write failing test: `safeMessage()` redacts a registered secret value that is absent from `process.env`
- [x] 0003 — implement value-registration in `redaction.ts`; keep the env-scan path working
- [x] 0003 — write failing test: `getProvider` returns the same instance for the same installation (ETag cache survives)
- [x] 0003 — write failing test: `getProvider` returns a *different* instance for a different installation
- [x] 0003 — write failing test: a repo with no installation resolves to the `GITHUB_TOKEN` adapter, and GitLab is untouched
- [x] 0003 — write failing test: an expired installation token is refreshed before use
- [x] 0003 — implement `InstallationStore` + `TokenSource` behind the seam; rekey the memo on `(provider, host, installationId)`
- [x] 0003 — verify no call site outside `server/providers/` mentions an installation (`npm run check:seam` + grep)
- [x] 0003 — `npm run verify` green (327 tests + seam guard)
- [x] 0003 — open PR + link PR url into ticket 0003 `prs:`

Deferred to Follow-ups: rewiring `discoverRepos`/rate-limit to installations
([2.4]) — filed as **#21**. It is neither #2's nor #3's: registration and the seam
are both mechanical, and this one changes what the Repos page's Discover section
means.

Added mid-session, not planned: single-flight minting and `invalidate(staleToken)`,
both found by adversarial review ([5.1]).

## [4] Log

- 2026-07-09 — Session opened. ADR-0006 landed on a branch just before this
  (PR-authorship + per-deployment App registration); #3 is the next step and is
  unblocked once [2.2]'s dependency inversion is recorded.
- 2026-07-09 — `c3b55b9` redactor inverted to value-registration. `redaction.ts`
  had **no test file at all** before this; added 10, including regressions on the
  env-scan path.
- 2026-07-09 — Suspected `rejects.not.toThrow(/eyJ/)` was a vacuous assertion.
  Checked by writing a throwaway test that throws a message containing `eyJ` — it
  **failed**, so the assertion is real. Kept it.
- 2026-07-09 — `ffffa33` the seam. `AppTokenSource` hand-rolled (see [5]);
  `getProviderForRepo(ref)` added; 11 repo-scoped call sites migrated; the 3
  account-level ones left on the env token.
- 2026-07-09 — Verified against reality, not only fakes: booted the server on
  :3999 and hit `/api/health`, which resolved a real adapter through the rewritten
  `hook.before` and got `valid: true, remaining: 4987` from GitHub's live API.
- 2026-07-09 — 322 tests green, `check:seam` clean, and a grep confirms no
  production code outside `providers/` names an installation.
- 2026-07-09 — Fresh-context adversarial review of `ffffa33` found **two real
  concurrency bugs**, both of which I had predicted but not yet fixed. It proved
  the HIGH one with a failing test. Fixed in `5e56d0a`; see [5].
- 2026-07-09 — My first regression test for the HIGH bug **passed against the buggy
  code** — it asserted on `src.get()` (the re-cached old token, still registered)
  instead of on the value the concurrent caller actually held. Rewrote it. Both
  fixes are now pinned by tests verified red against the prior implementation.
- 2026-07-09 — Re-ran the live boot check after collapsing the auth hooks:
  `/api/health` still returns `valid: true` from GitHub's real API.
  327 tests green.

## [5] Decisions

- **#3 depends on nothing, not on #2** ([2.2]). The plan's prose beats its graph.
- **Installations are injected, not passed** ([2.3]). Mirrors `setCondCacheStore`.
- **The redactor inversion lands here, not in #2** ([2.5]). #3 is the first ticket
  to hold a secret outside `process.env`.
- **Hand-rolled `AppTokenSource`, not `@octokit/auth-app`** (asked, answered
  2026-07-09). No new dependency; `node:crypto` signs RS256 natively; the refresh
  policy is ours to state and test rather than the library's to imply. `auth-app`
  was not already present — `node_modules/@octokit/` had only `auth-token`, and
  the lockfile had zero hits.
- **Auth resolves per request, via an Octokit `hook.before`**, not at construction.
  The adapter is memoized for the process lifetime; an installation token dies
  after an hour. Baking it into the Octokit instance would pin a stale credential.
- **`getProviderForRepo(ref)` rather than a widened `getProvider(…, installationId)`**.
  The widened signature would have forced all 14 call sites to resolve an
  installation — exactly what #3's own acceptance criterion forbids.
- **`get()` is single-flight.** Concurrent callers join the one in-flight mint.
  This is not only a stampede guard: it makes the out-of-order retire that review
  found *unreachable by construction*, because two mints can never overlap.
- **`invalidate(staleToken)` takes the token that failed.** N concurrent requests
  bearing one dead token all 401; only the holder of the token we currently
  believe in may retire it. Otherwise each discards its predecessor's fresh token
  and the adapter never converges. This forced `github.ts`'s `before` + `wrap`
  hooks to collapse into one `wrap`, which is the only place that knows which
  token a failed request actually bore.

## [5.1] What review caught that I did not

I predicted both concurrency bugs in prose before the review returned, then let
the reviewer confirm them rather than pre-fixing and racing it on the same files.
That was the right call for the *finding*, but it left one thing to learn:

The HIGH bug was sharper than my framing. I described it as "no in-flight
deduplication," a stampede problem. The reviewer located the actual defect —
`forget()` read the shared `this.token` field *after* its own `await`, so a
late-resolving mint retired a **newer, live, in-use** token. That is a credential
leak into logs, not a rate-limit annoyance, because every error path in the app
funnels through `safeMessage()`.

And my first attempt at a regression test for it passed against the buggy code. It
asserted on `src.get()` — the re-cached old token, still registered — rather than
on the token the concurrent caller was holding. Checking that a test fails against
the implementation it guards is not a formality.

## [6] Outcomes

**Shipped: PR [#10](https://github.com/jwolberg/dispatch/pull/10)**, merged `834de2c`,
`verify` green. 12 commits, 34 files, +2279/−134.

- **#3 closed** — per-repo credential resolution. All acceptance criteria met, including
  the two added mid-session for the redactor.
- **ADR-0006** written and accepted: Dispatch's server opens the PR (closing the gate
  ADR-0002 [4] left open), and the App is registered **per deployment** because this is a
  public repo people deploy for themselves.
- **#2 and #4 amended and de-`hitl`'d** — their approval gates dissolved. #4 lost its
  hardest requirement entirely: with no App credential written into user repos, it
  writes one secret and never detects `can_approve_pull_request_reviews`.
- **#21 filed** — account-level provider calls have no credential under an App.
- **`redaction.ts` gained its first tests** (10) and value-registration.

New behind the seam: `token-source.ts`, `installations.ts`. `github.ts` resolves auth per
request. 11 call sites migrated to `getProviderForRepo(ref)`. 327 tests, up from 280.

### [6.1] Verified, not assumed

- Booted the server twice against GitHub's **live** API (`/api/health` → `valid: true`),
  once after the seam and again after the auth hooks were collapsed.
- Both concurrency guards, and the two strengthened memoization assertions, confirmed
  **red** against the implementation they guard before being trusted.
- `grep` proves no production code outside `providers/` names an installation.

## [7] Follow-ups

- **#21 — account-level provider calls have no credential under an App.** Filed
  this session. `scheduler.ts`, `health.ts` and `routes/discover.ts` still use the
  env token; `discoverRepos()` has no direct translation under an App because an
  installation token enumerates only its installation's repos. Real product
  surface, not a mechanical rewire.
- **#2 — a memoized `AppTokenSource` outlives a rotated private key.** Noted in the
  ticket. The installation store is the only thing that knows; `resetProviderCache()`
  on any write to the installations table is probably enough.
- **ADR-0006 [8]'s open inference.** The moment #2 registers an App, open a PR with
  its installation token in a scratch repo and record the `workflow_run`. Until
  then the App-token arm rests on documentation, not measurement.

## [8] Notes

### [8.1] The App path is landed but unwired

`setInstallationStore()` is never called in production, so `AppTokenSource` is reachable
only from tests. This is exactly what `BUILD_PLAN-v2.md` §T1-2 asks for — *"land the
credential seam first, with the env token still flowing through it, then swap the
source"* — but it means #3's "installation tokens are minted behind the seam" is proven
by unit tests and never by a running process.

Rather than leave that implicit, #2 gained two acceptance criteria: call
`setInstallationStore()` at boot, and prove end-to-end that a tracked repo polls with a
minted token rather than `GITHUB_TOKEN`. `docs/architecture.md` §5.1 carries the same
warning inline.

### [8.2] Documentation drift found and fixed

- `docs/architecture.md` §5 described the factory as keyed on `(provider, host)`. Now
  §5.1 documents credential resolution, the injection, and the unwired status.
- `docs/BUILD_PLAN-v2.md`'s dependency table and graph drew `T1-1 ─► T1-2`, contradicting
  its own prose two paragraphs later. Corrected, with a dated note saying why.

### [8.3] What I would do differently

I let the adversarial reviewer confirm two concurrency bugs I had already described in
prose, rather than pre-fixing them, to avoid racing it on the same files. That was right.
But I had described the first as "no in-flight deduplication" — a stampede problem — and
it was actually a credential-into-logs bug. Naming a defect by its cheapest symptom is
how it gets deprioritized. Captured in
[`docs/learnings/cached-credentials-and-shared-mutable-state.md`](../../../docs/learnings/cached-credentials-and-shared-mutable-state.md).
