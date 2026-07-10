---
id: 21
title: "Account-level provider calls have no credential under a GitHub App"
status: in-progress
priority: high
horizon: next
hitl: false
type: feature
source: SES-0001
created: 2026-07-09
updated: 2026-07-10
prs:
  - "https://github.com/jwolberg/dispatch/pull/13"
refs:
  - "ADR-0006"
  - "SES-0001"
  - "server/providers/index.ts"
depends_on: [2, 3]
acceptance:
  - "routes/discover.ts lists repos across every installation the App has, not via a global GITHUB_TOKEN"
  - "poller/scheduler.ts and routes/health.ts report rate limit per installation, or state plainly that they report the env token's limit and why"
  - "getProvider(provider, host) — the account-level factory — is either removed or documented as env-token-only with no remaining GitHub caller"
  - "A repo tracked under installation A and one under installation B both poll correctly with no global token set"
  - "Dispatch runs end-to-end with GITHUB_TOKEN unset and only an App installed"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Split out of #3 (SES-0001 [2.4]), which deliberately left this alone.

Eleven of the fourteen `getProvider` call sites had a repo in hand and moved to
`getProviderForRepo(ref)`, which resolves that repo's installation behind the
seam. **Three did not**, because they have no repo at all:

| Call site | Call | What it wants |
|---|---|---|
| `server/poller/scheduler.ts` | `getProvider("github")` | account-level rate limit |
| `server/routes/health.ts` | `getProvider(provider)` | account-level rate limit |
| `server/routes/discover.ts` | `getProvider(provider)` | list every repo the token can see |

Under a GitHub App **there is no account-level credential.** A PAT belongs to a
user and can enumerate that user's repos; an installation token belongs to one
installation and enumerates only its repos. `discoverRepos()` therefore has no
direct translation — it becomes "for each installation, list its repos," which
changes the shape of the call and probably of the Repos page.

Rate limit is likewise per-installation. Two installations have two budgets, and
`RateLimitBanner` currently shows one number.

Today all three keep resolving to `EnvTokenSource(GITHUB_TOKEN)`, which works and
is what `main` did before #3. This ticket is what makes `GITHUB_TOKEN` genuinely
optional rather than merely un-required-per-repo.

## Design notes

`getProvider(provider, host?)` exists solely for these three callers and is
documented as env-token-only. Once they are rewired, it should either disappear or
keep a comment explaining why a GitHub caller may still want it.

Discovery is the interesting one. Options, uncosted:

- Enumerate installations (`GET /app/installations`), then per-installation repos
  (`GET /installation/repositories`), and merge.
- Drop server-side discovery for the App path and let GitHub's installation picker
  be the discovery UI — the operator already chose repos there in #2's flow.

The second is likely better and less code, but it changes what the Repos page's
**Discover** section means when an App is installed. Decide before building.

> **Decided 2026-07-10 (SES-0003).** *Fan out* — enumerate installations, list each
> one's repos, merge, and let the Repos page group by owner. The deep-link option
> collapses into it anyway: an `all` installation still has to be enumerated, so the
> same call comes back. Health reports **one entry per installation**, which is the
> only way the rate-limit banner means anything when two installations have two
> budgets.
>
> **Measured 2026-07-10, correcting this ticket's premise.** "Today all three keep
> resolving to `EnvTokenSource`, which works" is true, but the *consequence* is
> narrower than assumed. With an App and no `GITHUB_TOKEN`: boot works, `/api/board`
> 200s, and nothing on the per-repo path calls `requireEnv`. Only `/api/discover`
> 502s, and `/api/health` reports `configured: false` while an App is registered —
> a silent lie, and the sharpest part of this ticket.

## Why not folded into #2 or #3

#3 is the credential *seam* and must not change behavior. #2 is *registration*.
This is the *swap*, and it has real product surface (what Discover shows, what the
rate-limit banner means) rather than being a mechanical rewire. Splitting it keeps
both of those reviewable.
