---
id: 3
slug: account-level-calls-under-an-app
anchor: SES-0003
title: "#21 — account-level provider calls under a GitHub App (Discover, health, rate limit)"
status: active
started: 2026-07-10T01:50:26Z
ended: null
goal: "Land ticket #21 (account-level provider calls under a GitHub App): fan out Discover over installations, report rate limit per installation, and make Dispatch run end-to-end with GITHUB_TOKEN unset — without leaking installations past the provider seam"
tickets: [21]
branches: []
prs: []
related_research: []
related_docs:
  - docs/ARCHITECTURE.md
  - docs/decisions/0006-dispatch-opens-the-pr-and-the-app-is-registered-per-deployment.md
  - docs/BUILD_PLAN-v2.md
  - docs/learnings/verify-external-formats-before-encoding-them.md
prior_sessions: [1, 2]
---

## [1] Goal

Make `GITHUB_TOKEN` genuinely optional. Today an App-only deployment boots and
serves the board, but `GET /api/discover` 502s and `GET /api/health` reports GitHub
`configured: false` while an App is registered. Done means: Discover lists every
repo across every installation, health reports a rate limit per installation, and
Dispatch runs end-to-end with no env token — **without** anything outside
`server/providers/` learning that installations exist.

## [2] Context & pointers

### [2.1] In-scope ticket

**#21 — Account-level provider calls have no credential under a GitHub App**
(high, `next`, deps #2 and #3 both closed). Split out of #3 deliberately: #3 was
the credential *seam* and must not change behavior, #2 was *registration*. This is
the **swap**, and it has real product surface.

Acceptance criteria:
- `routes/discover.ts` lists repos across every installation, not via a global token.
- `poller/scheduler.ts` + `routes/health.ts` report rate limit per installation, or
  say plainly they report the env token's and why. **We chose per-installation.**
- `getProvider(provider, host)` is removed, or documented env-token-only with no
  remaining GitHub caller.
- A repo under installation A and one under installation B both poll correctly with
  no global token set.
- **Dispatch runs end-to-end with `GITHUB_TOKEN` unset and only an App installed.**

### [2.2] What is actually broken — measured, not inferred (2026-07-10)

Booted with `GITHUB_TOKEN` unset (from a cwd without `.env` — `lib/env.ts` calls
`dotenv.config()`, which will silently re-supply it and invalidate the experiment)
and an App + installation seeded:

| Surface | Behavior | Cause |
|---|---|---|
| boot | **works**, logs `github app "t" (id 42) registered` | nothing calls `getProvider()` at boot |
| `GET /api/board` | **200** | `getProviderForRepo()` never touches `requireEnv` |
| `GET /api/discover?provider=github` | **502** `Missing required environment variable: GITHUB_TOKEN` | `discover.ts:22` → `getProvider()` → `requireEnv` |
| `GET /api/health` | github `configured: false` | `health.ts:24` gates on `process.env[tokenEnv]`, never asks whether an App exists |
| rate-limit banner | absent | `scheduler.ts:31` early-returns `if (!process.env.GITHUB_TOKEN)` |

So the env token is **not required to run**. It is required for *discovery*, and its
absence makes health quietly misreport. That is narrower than the three docs claimed
before `c8e3d08` corrected them.

**Still unobserved:** that a repo under an installation *polls green* with no env
token. The credential resolves; the round trip needs a real App (#22).

### [2.3] The central design problem — do not leak installations

`ARCHITECTURE.md` §5 states the seam's rule: **callers name a repo, never an
installation.** But health and discover have *no repo*, and under an App there is no
account-level credential — only one credential per installation.

Resolving that tension is this ticket. The shape that seems right:

```ts
// providers/index.ts — one adapter per credential, opaque to the caller.
export function getAccountProviders(provider: ProviderId): GitProvider[]
```

- No App → `[envAdapter]`, exactly today's behavior.
- App with N installations → one adapter each, each already holding an
  `AppTokenSource`. Callers iterate opaque `GitProvider`s; nothing learns what an
  installation *is*.
- `discover.ts` merges `discoverRepos()` across them; `health.ts` maps
  `getRateLimit()` over them.

`discoverRepos()` must then branch by credential: `GET /user/repos` for a PAT,
`GET /installation/repositories` for an App. The adapter knows which `TokenSource`
it has; the caller must not. Pass an explicit scope at construction rather than
sniffing the token source's type.

Grouping in the UI comes free — `RepoSummary.path` is `owner/name`, so the Repos
page groups by owner without ever seeing an installation id.

### [2.4] External API facts — verified against the OpenAPI description

Per [[verify-external-formats-before-encoding-them]], checked before designing:

| Endpoint | Auth | Returns |
|---|---|---|
| `GET /app/installations` | **App JWT** (not an installation token) | array; `id`, `account`, `app_id`, `permissions`, … ; paginated |
| `GET /installation/repositories` | installation token | `{ total_count, repositories, repository_selection }` ; paginated |
| `GET /rate_limit` | whatever token authenticates it | `{ rate, resources }` — so an installation-backed adapter reports **that installation's** budget for free |

Note `GET /installation/repositories` also returns `repository_selection` — it can
refresh the `repos_json` that SES-0002 [7] flagged as going stale.

### [2.5] Constraints carried in

- **`GITHUB_TOKEN` must keep working.** It is the documented local path, the whole
  GitLab story, and the credential for any repo outside an installation.
- **GitLab has no App story.** `getAccountProviders("gitlab")` is always the env
  adapter. Don't invent symmetry.
- **`check:seam`** forbids `@octokit`/`@gitbeaker` imports outside `server/providers/`.
- **Two installations, two rate-limit budgets.** `RateLimitBanner` shows one number;
  the honest reduction is the **minimum remaining** across adapters. Decide and log.

### [2.6] Prior sessions

- **SES-0002** (#2, PR #11 merged) — registration + install flow. Its [7] follow-ups
  named this ticket, and flagged `repos_json` staleness which [2.4] can now fix.
- **SES-0001** (#3, PR #10 merged) — the credential seam; [2.4] of that doc is where
  #21 was split out.

### [2.7] Git / PR state

Branch `chore/merge-sync-pr-11` → **PR #12 open, unmerged**: it carries the snapshot
durability fix for #2 plus doc reconciles. This session branches off `main`, which
does **not** yet have that fix. No conflict expected — #21 touches
`providers/index.ts`, `github.ts`, `discover.ts`, `health.ts`, `scheduler.ts`; PR #12
touches `db/installations.ts` and `routes/github-app.ts`. Watch `providers/index.ts`,
which PR #12 edits only in a comment.

## [3] Checklist

### [3.1] The seam — one adapter per credential

- [ ] write failing test: `getAccountProviders("github")` returns the env adapter
      when no store is injected, and the same instance `getProvider()` hands back
- [ ] write failing test: with two installations it returns two distinct adapters,
      and neither is the env adapter
- [ ] write failing test: `getAccountProviders("gitlab")` ignores the store entirely
- [ ] write failing test: with an App and **no** `GITHUB_TOKEN` it returns the
      installation adapters and does **not** throw `requireEnv`
- [ ] implement `getAccountProviders()` + `InstallationStore.list()` behind the seam
- [ ] implement scope-aware `discoverRepos()` (`/user/repos` vs
      `/installation/repositories`), with a failing test per branch first

### [3.2] Discover

- [ ] write failing test: `GET /api/discover` merges repos across two installations
- [ ] write failing test: it returns 200 (not 502) with no `GITHUB_TOKEN`
- [ ] write failing test: one installation failing does not lose the other's repos
- [ ] implement `discover.ts` fan-out

### [3.3] Health + rate limit

- [ ] write failing test: health reports `configured: true` when an App is registered
      and no env token is set — the current silent lie
- [ ] write failing test: health returns one entry per installation
- [ ] write failing test: the banner's reduction is the **minimum** remaining
- [ ] implement `health.ts` + `scheduler.ts` (drop the `!process.env.GITHUB_TOKEN`
      early return)

### [3.4] Retire `getProvider()`

- [ ] write failing test: no GitHub caller reaches the env-only account factory
- [ ] remove it, or document it env-token-only with no remaining GitHub caller
- [ ] update `ARCHITECTURE.md` §5's "three call sites have no repo" paragraph

### [3.5] Prove the exit criterion

- [ ] boot with `GITHUB_TOKEN` unset + an App: `/api/health` honest, `/api/discover`
      200, `/api/board` 200 — driven against the real server, from a cwd with no `.env`
- [ ] `npm run verify` green; open PR + link into ticket #21

## [4] Log

### [4.1] 2026-07-10T01:50Z — session seeded

Two decisions taken before opening this doc, both confirmed by the user: Discover
**fans out** over installations rather than deep-linking to GitHub's picker; health
reports **one entry per installation** rather than a single labelled env-token line.
[2.4]'s API facts were verified against the OpenAPI description first — the rule
[[verify-external-formats-before-encoding-them]] exists to enforce.

### [4.2] 2026-07-10 — the exit criterion, driven against the real server

Booted with `GITHUB_TOKEN` and `GITLAB_TOKEN` unset, from a cwd with no `.env`, with
two installations seeded under a locally-generated (fake) App:

| Surface | Before #21 | After |
|---|---|---|
| `/api/health` github | `configured: false` — while an App was registered | `configured: true`, both accounts listed by login |
| `/api/discover` | 502 `Missing required environment variable: GITHUB_TOKEN` | 502 `installation token mint failed: 404`, **per account** |
| `/api/board` | 200 | 200 |
| `requireEnv` in the log | — | never reached |

The remaining 502 is the *fake* App failing to mint against real GitHub, which is
correct: the endpoint now fails for the right reason, and reports which credential
failed. A real App returns 200. That is #22, and it is the honest boundary of what
this session can prove.

## [5] Decisions

*(none yet)*

## [6] Outcomes

*(filled by /session-end)*

## [7] Follow-ups

*(filled by /session-end)*

## [8] Documentation

*(filled by /session-end)*
