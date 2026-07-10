---
id: 3
slug: account-level-calls-under-an-app
anchor: SES-0003
title: "#21 — account-level provider calls under a GitHub App (Discover, health, rate limit)"
status: closed
started: 2026-07-10T01:50:26Z
ended: 2026-07-10T23:05:00Z
goal: "Land ticket #21 (account-level provider calls under a GitHub App): fan out Discover over installations, report rate limit per installation, and make Dispatch run end-to-end with GITHUB_TOKEN unset — without leaking installations past the provider seam"
tickets: [21, 22, 23, 24, 25, 4]
branches:
  - feat/21-account-level-calls-under-an-app
  - chore/22-live-verify-installation-token
  - fix/23-dedupe-repos-identity
  - feat/24-onboard-claude-workflow
  - fix/25-claude-action-needs-explicit-github-token
  - feat/4-setup-route-and-pr-opening
  - feat/4-setup-route-stages-4-6
  - docs/setup-after-app-onboarding
prs:
  - "https://github.com/jwolberg/dispatch/pull/13"
  - "https://github.com/jwolberg/dispatch/pull/15"
  - "https://github.com/jwolberg/dispatch/pull/16"
  - "https://github.com/jwolberg/dispatch/pull/18"
  - "https://github.com/jwolberg/dispatch/pull/21"
  - "https://github.com/jwolberg/dispatch/pull/22"
  - "https://github.com/jwolberg/dispatch/pull/23"
  - "https://github.com/jwolberg/dispatch/pull/24"
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

- [x] write failing test: `getAccountProviders("github")` returns the env adapter
      when no store is injected, and the same instance `getProvider()` hands back
- [x] write failing test: with two installations it returns two distinct adapters,
      and neither is the env adapter
- [x] write failing test: `getAccountProviders("gitlab")` ignores the store entirely
- [x] write failing test: with an App and **no** `GITHUB_TOKEN` it returns the
      installation adapters and does **not** throw `requireEnv`
- [x] implement `getAccountProviders()` + `InstallationStore.list()` behind the seam
- [x] implement scope-aware `discoverRepos()` (`/user/repos` vs
      `/installation/repositories`), with a failing test per branch first

### [3.2] Discover

- [x] write failing test: `GET /api/discover` merges repos across two installations
- [x] write failing test: it returns 200 (not 502) with no `GITHUB_TOKEN`
- [x] write failing test: one installation failing does not lose the other's repos
- [x] implement `discover.ts` fan-out

### [3.3] Health + rate limit

- [x] write failing test: health reports `configured: true` when an App is registered
      and no env token is set — the current silent lie
- [x] write failing test: health returns one entry per installation
- [x] write failing test: the banner's reduction is the **minimum** remaining
- [x] implement `health.ts` + `scheduler.ts` (drop the `!process.env.GITHUB_TOKEN`
      early return)

### [3.4] Retire `getProvider()`

- [x] write failing test: no GitHub caller reaches the env-only account factory
- [x] remove it, or document it env-token-only with no remaining GitHub caller
- [x] update `ARCHITECTURE.md` §5's "three call sites have no repo" paragraph

### [3.5] Prove the exit criterion

- [x] boot with `GITHUB_TOKEN` unset + an App: `/api/health` honest, `/api/discover`
      200, `/api/board` 200 — driven against the real server, from a cwd with no `.env`
- [x] `npm run verify` green; open PR + link into ticket #21 (PR #13, merged)

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

## [4.3] 2026-07-10 — the session ran well past its stated goal

Worth recording as a process fact, not just a preamble to the outcomes. This doc was
opened for **#21 alone**. #21 merged as PR #13 early, and the session then ran through
#22, #23, #24, #25 and most of #4 without a new doc being opened. Seven more PRs merged
under a session titled "account-level provider calls".

Nothing was lost — every ticket carries its own record and `docs/implementation-notes.md`
has a dated entry per day — but `bin/sessions active` was misleading for the whole
stretch. See [7.3].

## [5] Decisions

### [5.1] Idempotent 200 over 409 for a re-track (#23)

`POST /api/repos` returns the existing row rather than erroring when a repo is already
tracked, and refreshes its cached context. Reasoning: a re-track is how an operator asks
for fresh context, and the route has already paid for the fetch. **Tradeoff accepted:** a
genuine double-submit is now silent. The operator chose this over 409.

### [5.2] The table-level `UNIQUE` stays; an expression index enforces identity (#23)

SQLite has no `DROP CONSTRAINT`, and the original `UNIQUE (provider, host, path)` still
guards GitLab's non-null host. `idx_repos_identity ON repos (provider, COALESCE(host, ''), path)`
is what actually enforces identity. Leaving both is not redundancy — it is the only way
to add the correct constraint without rebuilding the table.

### [5.3] `automationSetup()` returns `null` for GitLab rather than throwing (#4)

`claude-code-action` is GitHub-only. Encoding the absence in the return type means the
route answers `501` at the call site instead of catching an exception thrown from the
bottom of a call stack. Same reasoning for `getCommitIdentity` returning
`authorType: null` on GitLab: a poller that read `null` as "not a human" would open merge
requests from people's branches.

### [5.4] `libsodium-wrappers` as a new production dependency (#4)

GitHub's Secrets API accepts only `crypto_box_seal`. Node's `crypto` has X25519 but no
XSalsa20 and no 24-byte Blake2b for the nonce, so it cannot produce it. Chose the pure-WASM
`libsodium-wrappers` over `sodium-native` — no native build in the Cloud Run image.
Production `npm audit`: 0 vulnerabilities. Named in #4's acceptance criteria, so acted on
rather than asked.

### [5.5] Partial PRs stay out of a ticket's `prs:` list

`merge-sync` closes a ticket once every PR in `prs:` has merged. #4 shipped across three
PRs; linking the first would have closed the ticket with five stages outstanding. Partial
PRs are recorded in the ticket body instead. Caught before it fired.

## [6] Outcomes

**Eight PRs merged.** All to `main` by the human; nothing merged by an agent.

| PR | Ticket | What |
|---|---|---|
| #13 | #21 | Account-level calls under an App — this doc's actual goal |
| #15 | #22 | Live-verified the App path; ADR-0006 [8] and ADR-0002 [5] moved from *inferred* to *observed* |
| #16 | #23 | `UNIQUE` never deduped GitHub repos — `NULL != NULL` in a SQLite unique index |
| #18 | #24 | Onboarded `dispatch` with an ADR-0006-compliant `claude.yml`; stopped the installer re-introducing `GH_PAT` |
| #21 | #25 | `claude.yml` never ran: omitting `github_token` demands Anthropic's Claude GitHub App |
| #22 | #4 | Stages 1–3: sampled the branch discriminator, fixed the issue prompt, extended the seam, poller opens the PR |
| #23 | — | Setup docs realigned: README, DEPLOY, BUILD_PLAN, adding-a-repo, runbook |
| #24 | #4 | Stages 4–6: sealed-box secrets, `POST /setup`, embedded templates, the UI |

**Tickets closed:** #21, #22, #23, #24, #25. **Still `in-progress`:** #4 — every stage
merged, but AC 12 (end-to-end from the browser, against a real repo) has never been
exercised. See [7.1].

**Tests:** 496 → **562**, all green at `main`. `npm run verify` gained a fourth gate,
`check:templates`, which fails CI if `scripts/repo-ci/` or `scripts/repo-skills/` change
without regenerating `server/setup/embedded.ts`.

**The loop closed.** Before this session `claude-code-action` pushed a branch and nothing
opened a pull request — ADR-0006 [2] had deleted the `gh pr create` post-step and its
`GH_PAT`, but the half that was supposed to replace it did not exist. It does now.

**Two secret-hygiene fixes,** neither planned:

- `.env` held **two** `DISPATCH_ENCRYPTION_KEY` lines. `dotenv` takes the last; the first
  decrypted nothing. Anything that reordered them would have made Dispatch refuse to boot
  and forced re-registering the App. The runbook's `echo … >> .env` was the cause.
- `.gitignore` covered `.env` but not `.env.bak*`. A backup of `.env` is a copy of its
  secrets, and was committable.

## [7] Follow-ups

### [7.1] #26 — re-onboard `jwolberg/situation` (filed, `open`, `hitl`, blocks #4)

`situation` still carries a live `GH_PAT` secret and a `claude.yml` with the `gh pr create`
post-step ADR-0006 [2] deleted. Re-onboarding it through `POST /api/repos/:id/setup`
removes both **and** exercises #4's unproven AC 12. One action, two threads closed.

Note the asymmetry it exposes: `install-claude-action.sh` deletes a leftover `GH_PAT`;
the setup route does not. The route deletes `ANTHROPIC_API_KEY` for the same class of
reason. #26 must decide whether the route gains the symmetry.

### [7.2] #5 (canary) is unblocked

It depends on #4, whose code has all merged. It stays `open` until #4 closes.

### [7.3] Sessions drifted — this doc covered five tickets it never named

A process gap, not a code one. `/session-start` was not re-run when the work moved past
#21. Worth deciding whether `/session-end` should refuse to close a session whose merged
PRs reference tickets absent from its `tickets:` frontmatter.

### [7.4] Not filed, recorded here

- `scripts/repo-ci/deploy.yml` is embedded into `server/setup/embedded.ts` but never read
  by the server — it is installer-only (`INSTALL_DEPLOY_GATE=1`). The embedder mirrors the
  directories on purpose; a hand-maintained allow-list would be a second source of truth.
- The `web/dist` bundle is untracked, so no stale-artifact hazard.
- Pre-existing dev-only advisories in `esbuild`/`vite`. Not introduced here; not touched.

## [8] Documentation

Written this session:

| Path | What |
|---|---|
| `docs/learnings/assumed-mechanisms-fail-under-observation.md` | **New.** The session's central lesson: an assumed mechanism is a bug that typechecks. #25's non-existent input default, #23's `NULL != NULL`, and #4 AC 9's identity rule that would never have fired. |
| `docs/decisions/0006-…md` [2] | Amended — "the default `GITHUB_TOKEN`" must be *passed explicitly*; its wording caused #25. |
| `docs/decisions/0006-…md` [8] | *Inferred* → **observed**, with the run linked. |
| `docs/decisions/0002-…md` [5] | Same: the installation-token arm is now measured, not substituted from a PAT. |
| `docs/ARCHITECTURE.md` §5 | The `GitProvider` interface drifted — four methods added this session were missing. Reconciled, with the reasoning for the three-field `CommitIdentity` and the `null` from `automationSetup`. |
| `docs/runbooks/register-github-app-locally.md` | Idempotent key generation; the `getProvider()` → `getAccountProviders()` correction; "`GITHUB_TOKEN` must stay set" was stale after #21. |
| `README.md`, `DEPLOY.md`, `docs/adding-a-repo.md` | Realigned to the App model. All three told readers to set up the deleted `GH_PAT`. |
| `docs/BUILD_PLAN-v2.md` | T1-0's gate cleared; #22–#25 in the ticket table; T1-3's six-stage plan and sampled discriminator. |
| `server/poller/__fixtures__/README.md` | The raw sampled payloads, their provenance, and the three plausible rules they kill. |
| `docs/implementation-notes.md` | Dated entries for #22, #23, #24, #25, and #4 stages 3–6. |

**Still to document:** nothing outstanding. The one thing that cannot be written down
until it is done is #4 AC 12 — see [7.1].
