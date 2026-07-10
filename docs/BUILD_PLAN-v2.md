# Build Plan v2 — Tiers 0–2

**Status:** Tier 0 **complete** (10/10). Tier 1 **9/10** — T1-3 landed
(PRs #22 + #24); **only T1-4 (canary) remains**. Tier 2 not started.
**Supersedes:** nothing. `docs/BUILD_PLAN.md` covers v1 (Phases 1–6, complete).
**Source:** assessment of 2026-07-09 (Dispatch vs. TerMinal vs. the 2026 orchestrator market).
**Last updated:** 2026-07-10 — Tier 0 run in `docs/implementation.md`; Tier 1 run
in `docs/implementation-notes.md`. Reconciled against merged PRs 2026-07-10.

**The gate on T1-3 is cleared.** ADR-0006 [8]'s central claim — that a pull request
opened with a GitHub App *installation token* triggers `pull_request` runs without
approval — was **inferred, not observed**, and T1-3 and T1-4 are both shaped around
it. Ticket **#22** ran the check on 2026-07-10 and **the arm holds**: run
[29065952153](https://github.com/jwolberg/cohort-bot/actions/runs/29065952153),
`event: pull_request`, `conclusion: success`, no approval gate, `actor` =
`triggering_actor` = `dispatch-jay[bot]`. `GH_PAT` stays deleted; T1-3 proceeds as
written. ADR-0006 [8] and ADR-0002 [5] now record it as observed.

**Two things the check turned up, both now fixed.** Neither was in any plan:

- **#25 — `claude.yml` never ran.** ADR-0006 [2]'s "pushes a branch using the default
  `GITHUB_TOKEN`" was implemented as *omitting* the `github_token` input. That input
  has no default; omitting it makes `claude-code-action` mint a token from
  *Anthropic's* Claude GitHub App, which 401s when it is not installed. It must be
  named: `github_token: ${{ github.token }}`.
- **#23 — every **Track** click inserted a duplicate row.** `UNIQUE (provider, host,
  path)` never fired for GitHub, because `host` is `NULL` and SQLite treats each
  `NULL` as distinct. Fixed with an expression index on `COALESCE(host, '')`.

The lesson generalizes, and T1-3's AC 9 already encodes it: **sample, never infer.**
Both bugs were mechanisms assumed from prose. AC 9's demand for a *real*
`claude-code-action` run is what surfaced #25 — the run failed before it could push
a branch, which was itself the finding.

---

## [0] Framing

Dispatch's defensible position is that it is the only agent control plane that is
**browser-native, terminal-free, and laptop-free**. Every meaningful competitor
(Conductor, Vibe Kanban, Nimbalyst, TerMinal) is a local worktree orchestrator
requiring a shell and a checkout.

Two consequences shape this plan:

1. **Do not grow a terminal, local worktrees, or local agent execution.** That
   fights four incumbents on their home turf and forfeits the one asset.
2. **The promise is not yet true.** Onboarding a repo today requires running
   `scripts/install-claude-action.sh`, minting a fine-grained PAT with an exact
   scope matrix, and understanding GitHub's anti-recursion rule. The terminal we
   removed from the main loop still sits in the setup step. Tier 1 exists to
   close that gap.

Tiers are strictly ordered. Tier 0 is a prerequisite for the others because this
repo's own `CLAUDE.md` makes test-first non-negotiable, and Tiers 1–2 change
behavior in the merge path.

---

## [1] Tier 0 — Earn the right to ship publicly

**Why first.** The branch is named `prep-public-release`. Today the repo has
**zero tests** (verified: `git log --all --diff-filter=A` finds no test file in
68 commits), a CI workflow that would fail on first run, and documentation that
claims tests exist. Publishing in that state is a reputational problem that costs
more to undo than to prevent.

**Exit criteria**
- ✅ `npm run verify` runs typecheck + seam guard + tests, and passes (79 tests).
- ✅ CI runs that same command on push and PR. *(Green locally; unproven on a real runner until the first push.)*
- ✅ No claim in `docs/` is unbacked by code in the repo.

### Tickets

| ID | Title | Size | Depends on | Status |
|---|---|---|---|---|
| T0-1 | Add a test runner and wire `npm test` into `npm run verify` | S | — | Complete |
| T0-2 | Unit-test `deriveColumn` | S | T0-1 | Complete |
| T0-3 | Unit-test PR linkage (both adapters) | S | T0-1 | Complete |
| T0-4 | Unit-test the ticket-JSON parser and its retry path | S | T0-1 | Complete |
| T0-5 | Provider injection seam + integration-test the merge gate | M | T0-1 | Complete |
| T0-6 | Replace the placeholder CI workflow | S | T0-1 | Complete |
| T0-7 | Correct the false test claims in `implementation-notes.md` | S | T0-2…T0-5 | Complete |
| T0-8 | Remove the stale "Stubbed here" comment | XS | — | Complete |
| T0-9 | ~~Persist ETags to `status_cache.etag_map_json`~~ Persist the conditional-request cache | M | T0-1 | Complete |
| T0-10 | Warn at startup when the SQLite path is ephemeral | S | — | Complete |

**T0-1 — Test runner.**
Choose **Vitest**. Rationale: Vite is already a dependency, so it shares the
existing TS/ESM resolution with zero new toolchain, and it covers both `server/`
and `web/`. This is a flat-cost decision; taken, not asked. Add `"test": "vitest
run"` and extend `verify` to `typecheck && check:seam && test`.

**T0-2 — `deriveColumn` (`server/poller/reconcile.ts:25`).**
A pure function with five precedence branches — the cheapest high-value test in
the repo. Table-driven. Must pin the precedence the code actually implements:
`Shipped` (issue closed **or** PR merged) outranks `Blocked` (any run or check
failed), which outranks `Building`, `Ready to test`, and `Queued`. Include the
fine-grained-PAT case at `reconcile.ts:37-42`, where `pr.checks` omits Actions CI
and an in-progress run must still yield `Building`.

**T0-3 — PR linkage (`providers/github.ts:340`, `providers/gitlab.ts:222`).**
The regex is deliberately bounded so issue `#1` does not match a PR body
referencing `#10`. That boundary is exactly the kind of thing that silently
regresses. Test both adapters against the same table.

**T0-4 — Ticket JSON (`server/routes/chat.ts:99-169`).**
`tryParseTicket` strips code fences and the route retries once with a correction
prompt. Test: bare JSON, fenced JSON, JSON with prose preamble, malformed JSON
(asserts the retry fires), and malformed twice (asserts a clean 4xx, not a
crash).

**T0-5 — Merge gate.**
`POST /api/tickets/:id/merge` (`server/routes/tickets.ts:252`) is the single
highest-blast-radius endpoint in the codebase: it merges to production. It
re-validates the gate server-side (PR open, mergeable, no failing or pending
checks) and that logic must be tested.

*Design note, and the reason this is M not S:* `getProvider`
(`server/providers/index.ts`) is a module-level memoized factory reading
`process.env.GITHUB_TOKEN`. There is no injection point. This ticket must add a
test seam — a `setProviderFactory()` override, or accepting the factory as an
argument — before the gate can be tested against a fake `GitProvider`. Keep the
memoization: it preserves the in-process ETag cache across poll cycles, which was
a real rate-limit fix.

Seed an in-memory SQLite DB, install a fake provider, and assert 409 on each
rejection branch and a single `mergePR` call on the happy path.

**T0-6 — CI.**
`.github/workflows/ci.yml` is unadapted template boilerplate: it runs `bun
install --frozen-lockfile` and `bun run format:check` against a project that uses
npm and has neither script. It would fail immediately if it ever ran. Replace
with Node 20 + `npm ci` + `npm run verify` + `npm run build`.

**T0-7 — Documentation integrity.**
`docs/implementation-notes.md` lines 29, 33, and 51 claim unit and integration
tests, one with a ✅. None exist. Rewrite those lines to state what was actually
validated (typecheck, seam guard, manual smoke) and append a dated correction
entry rather than silently editing history — the file's stated purpose is a
decision log for human review.

**T0-9 — Conditional-request cache persistence.** *(Landed. This ticket's original
mechanism was wrong; recorded here because the reasoning is the useful part.)*

The problem was real: caching lived in an in-process map in `github.ts`, so on
Cloud Run every container recycle triggered a full-cost refetch burst against the
rate limit.

The originally-specified fix — *"load the persisted `status_cache.etag_map_json`
map into the provider on construction"* — **could not work and would have
introduced a silent bug.** `cond()` returns `cached.data` on a 304, and an HTTP
304 carries no body; that is the entire point of the round trip. Hydrating
`{etag, data: undefined}` makes `cond()` return `undefined` on the first 304 after
a cold start, which throws a `TypeError` downstream that `safeReconcile` swallows
— the ticket just stops updating, forever. Verified by simulation on 2026-07-09.

The grain was wrong too: `condCache` keys are per-repo/resource
(`pulls.list:owner/name`) and shared across a repo's tickets, while `status_cache`
is per-ticket.

**What was built instead** (option (a), approved 2026-07-09):

- a disposable `http_cache(key PRIMARY KEY, etag, body_json, updated_at)` table,
  keyed at the real grain, storing the body alongside the ETag;
- `cond()` extracted from `github.ts` into `providers/cond-cache.ts` as a testable
  `CondCache` that **refuses to hydrate any entry lacking a body or an etag** —
  the guard that makes the original bug unrepresentable;
- the store injected at boot from `server/index.ts`, so `providers/` never imports
  the db layer and tests default to in-process-only caching;
- corrupt rows dropped on load; oversized (>512 KB) and unserializable bodies never
  persisted;
- dead `getEtagMap()` and the always-`{}` `status_cache.etag_map_json` column
  removed, via an idempotent `ALTER TABLE ... DROP COLUMN` migration.

The rebuild rule holds: `http_cache` is disposable, and wiping it costs exactly one
full re-fetch.

**T0-10 — Ephemeral DB warning.**
`DISPATCH_DB_PATH` and the Filestore guidance already exist in `DEPLOY.md §4`.
The smallest useful change is a startup warning when the resolved DB path is not
on a mounted volume, so the failure mode is announced rather than discovered
after a redeploy wipes the repo registry.

---

## [2] Tier 1 — The vibecoder wedge

**Goal.** Make "no terminal, no laptop, no checkout" true from first click to
first ship, for a user who cannot read a diff and has never minted a PAT.

**Exit criteria**
- A new user connects GitHub in the browser, picks a repo, clicks one button, and
  Dispatch verifies end-to-end that a build will actually trigger — with no shell.
- A card leads with "what changed, what to click to test it" and a single verdict,
  not a list of check names.
- Shipping something bad is recoverable in one click.
- The tool cannot silently spend unbounded money.

### Tickets

| ID | Ticket | Title | Size | Depends on | Status |
|---|---|---|---|---|---|
| T1-0 | #1 | **Spike:** GitHub App installation tokens and the anti-recursion rule | S | — | Complete (ADR-0002) |
| T1-1 | #2 | GitHub App: manifest registration + OAuth install flow | L | T1-0 | Complete (PR #11) |
| T1-2 | #3 | Per-repo credential resolution (replaces the global env token) | M | — (see below) | Complete (PR #10) |
| T1-3 | #4 | `POST /api/repos/:id/setup` — write workflows + secrets via API | L | T1-1, T1-2 | **Complete** (PRs #22, #24) |
| T1-4 | #5 | Canary verification: prove the build triggers, at setup time | M | T1-3 | ◆ **Next** — unblocked |
| T1-5 | #6 | Plain-language change summary on the card | M | T0-1 | Complete |
| T1-6 | #7 | Preview-first card: hero preview + single verdict chip | S | T1-5 | Complete |
| T1-7 | #8 | **Spike:** revert mechanism per provider | S | — | Complete (ADR-0003) |
| T1-8 | #9 | One-click revert | M | T1-7 | Complete (ADR-0004) |
| T1-9 | #10 | Spend tracking + daily budget cap | M | T0-1 | Complete |

**Spun out of this tier, and both still open:**

| Ticket | Title | Why it exists |
|---|---|---|
| #21 | Account-level provider calls under an App | **Done (PR #13).** T1-2 could not resolve the rate-limit probe, health route, or `discoverRepos()` — they have no repo, so no installation. `getAccountProviders()` now returns one adapter per credential; Discover fans out and merges, health reports one entry per credential, and the env-only `getProvider()` factory is gone. `GITHUB_TOKEN` is optional. |
| #22 | Live-verify the App path | **Done (PR #15).** Both criteria observed on a real App. AC 6: with `GITHUB_TOKEN` corrupted, a repo under the installation still polled, at a rate-limit ceiling of 6950 (installation-scoped; a PAT is capped at 5000). AC 13: a PR opened by the installation token triggered `pull_request` with no approval gate. ADR-0006 [8] and ADR-0002 [5] moved from *inferred* to *observed*. |
| #23 | `UNIQUE` never deduped GitHub repos | **Done (PR #16).** `host` is `NULL` for GitHub and SQLite treats each `NULL` as distinct, so every **Track** click appended a row. Expression index on `COALESCE(host, '')`; `POST /api/repos` is now idempotent (200 + existing row). |
| #24 | Onboard `dispatch` with a compliant `claude.yml` | **Done (PR #18).** The repo card's ⚠ flag was correct — the repo had no Claude workflow. Made it false rather than hiding it, and stopped `install-claude-action.sh` re-introducing the `GH_PAT` ADR-0006 [2] deleted. |
| #25 | `claude.yml` never ran | **Done (PR #21).** `github_token` has no default in `action.yml`; omitting it makes `claude-code-action` mint from *Anthropic's* Claude GitHub App and 401. Pass `${{ github.token }}` explicitly. Found by T1-3's AC 9, which forbids inferring the branch discriminator and forced a real run. |

**T1-0 — Spike, and it gates the whole tier.**
The claim I want verified before building on it: *events authenticated with a
GitHub App installation token do trigger workflow runs, whereas events
authenticated with the default `GITHUB_TOKEN` do not.* If true, a GitHub App
dissolves the anti-recursion footgun that `install-claude-action.sh` currently
works around with a separate `GH_PAT` — and the entire `GH_PAT` concept
disappears from onboarding. If false, the App still buys us scoped per-repo
tokens but we must keep minting a PAT, and T1-3 gets meaningfully uglier.

Do not start T1-1 before this is settled. Timebox to half a day; the answer is a
paragraph and a link.

> **Done and fully settled (2026-07-09/10).** The spike produced ADR-0002 and
> ADR-0006. ADR-0006 [2] went further than the spike asked: **the workflow no longer
> opens PRs at all.** `claude-code-action` pushes a branch under the default
> `GITHUB_TOKEN`, and Dispatch's own server opens the pull request with its
> installation token. That deletes the `gh pr create` post-step and leaves `GH_PAT`
> with no caller.
>
> The arm this rests on — that a PR opened with an *installation token* triggers
> `pull_request` runs without approval — was inferred from a fine-grained PAT
> observation. **#22 observed it directly on 2026-07-10 and it holds** (ADR-0006 [8]).
> `GH_PAT` is gone for good, and T1-3 is the ticket it was always going to be.
>
> One correction from doing it: "uses the default `GITHUB_TOKEN`" means passing
> `github_token: ${{ github.token }}`, not omitting the input. See #25.

> **Corrected 2026-07-09 (SES-0001, shipped as PR #10).** This table and the graph
> below drew `T1-1 ─► T1-2`, contradicting the prose immediately after it. T1-2 does
> **not** depend on T1-1: minting is unit-testable against a fake private key and a
> fake `fetch`, so the seam lands first with the env token still flowing through it,
> exactly as this section says. T1-3 depends on both. T1-2 is **done**; it defines the
> `InstallationStore` interface that T1-1 implements. The account-level call sites it
> could not resolve became ticket #21.

**T1-1 / T1-2 — The auth model change.**
Today `providers/index.ts` memoizes on `(provider, host)` and reads a single
global `GITHUB_TOKEN` from the environment. A GitHub App issues **per-installation**
tokens that expire hourly. This is not a drop-in change:

- the memo key must become `(provider, host, installationId)`;
- token minting and refresh need to live behind the existing provider seam so
  nothing outside `server/providers/` learns about installations;
- `GITHUB_TOKEN` must keep working, because it is the documented local path and
  the whole GitLab story.

Treat this as the riskiest refactor in the plan. It touches every adapter call
site indirectly, and it is why T1-2 is separated from T1-1: land the credential
seam first, with the env token still flowing through it, then swap the source.

> **Both landed (PR #10, PR #11). What the plan did not anticipate:**
>
> - **The private key became runtime state.** Self-registration means the key arrives
>   in an HTTP callback, not from the environment, so Dispatch must *write* it. It
>   lives in SQLite, AES-256-GCM encrypted under `DISPATCH_ENCRYPTION_KEY`, because
>   `snapshot.ts` uploads the whole database to a versioned bucket. `DEPLOY.md` §1.1
>   and §4.1. Boot **refuses to start** when an App is registered and the key is gone.
> - **`GITHUB_TOKEN` did not go away here — #21 retired it.** Measured, not inferred:
>   with an App registered and no env token, the process booted and the board served,
>   but `/api/discover` 502'd and `/api/health` reported `configured: false` while an
>   App was registered. The plan said "`GITHUB_TOKEN` must keep working"; it did not
>   anticipate that its *absence* would make the health check lie. #21 fixed both, and
>   the env token now buys only repos outside an installation, plus GitLab.
> - **Three of ADR-0006's claims about GitHub's manifest format were wrong**, and all
>   three would have compiled: there is no `?org=` parameter (ownership is chosen by
>   the path), `webhook_secret` is nullable, and the manifest code is documented to
>   expire in an hour but is never promised single-use. Corrected in ADR-0006 [5].
>   Verify an external format against the API before encoding it, not after.

**T1-3 — Browser onboarding.**
Port `scripts/install-claude-action.sh` (250 lines of bash) into TypeScript
behind one endpoint. It already knows everything that needs to happen — commit
`.github/workflows/claude.yml`, commit a stack-aware `ci.yml` from
`scripts/repo-ci/`, commit the `plan`/`implement`/`debug` skills from
`scripts/repo-skills/`, and set the Claude auth secret. The templates stay where
they are and get embedded at build time. Secrets go through the Secrets API,
which requires libsodium sealed-box encryption — the one genuinely fiddly part.

Preserve the OAuth-token-preferred behavior and, critically, the rule discovered
in `implementation-notes.md` on 2026-06-12: **when installing in OAuth mode,
delete any existing `ANTHROPIC_API_KEY` repo secret**, because the API key
outranks the OAuth token in Claude's auth precedence and would keep billing the
metered API.

> **Complete (2026-07-10).** Six stages, plan in the ticket. Stages 1–2 landed on
> PR #22; stages 3–6 on PR #24.
>
> | # | Stage | State |
> |---|---|---|
> | 1 | Sample the branch discriminator (AC 9) | done |
> | 1a | Stop the issue body telling Claude to open the PR | done |
> | 2 | Seam: `listBranches`, `getCommitIdentity`, `createPullRequest` | done |
> | 3 | Poller opens the PR for Claude's branch, never a human's | done — `reconcile.ts:159`, `open-pr.test.ts` |
> | 4 | `POST /api/repos/:id/setup` + sealed-box secrets | done — `routes/repos.ts:204` |
> | 5 | Templates embedded at build time | done — `server/setup/embedded.ts`, `check:templates` |
> | 6 | UI affordance + docs | done — "Set up automation" on the repo card |
>
> **AC 9 is the load-bearing criterion, and it earned its keep.** It forbids
> inferring the human-vs-Claude discriminator, because opening a PR from somebody's
> work-in-progress branch is not recoverable. Forcing a real run surfaced #25 before
> a line of T1-3 was written. The sample (`server/poller/__fixtures__/`) kills three
> plausible rules:
>
> - `author.login === "claude[bot]"` **never matches** — GitHub resolves a commit's
>   author by *email*, and Claude's noreply address carries `github-actions[bot]`'s
>   numeric id, so that is the login reported.
> - `author.type === "Bot"` alone also matches Dependabot and every other Actions
>   commit.
> - The commit message carries `Co-authored-by: <the issue author>`, so any "was a
>   human involved" check says yes.
>
> The rule is both together: `author.type === "Bot" && commit.author.name === "claude[bot]"`.
>
> **GitLab has no equivalent to sample.** `claude-code-action` is GitHub-only, and
> GitLab's commit payload resolves no account and reports no bot/user distinction. The
> seam is implemented for parity, but `getCommitIdentity` returns `null` there rather
> than a guess, and the poller's auto-open path stays GitHub-only. Inventing a GitLab
> discriminator is the exact mistake AC 9 exists to prevent.

**T1-4 — Canary, and the reason this tier is worth the money.**
Writing a workflow file is not the same as the workflow running. The failure mode
this tool exists to prevent is a user who files a ticket, watches the card sit in
`Queued` forever, and has no idea why. So after setup: file a throwaway issue
with the `@claude` mention, poll for a `workflow_run` within a bounded window,
then close the issue and delete the branch. Record pass/fail on the repo card.

This turns the single nastiest piece of tribal knowledge in `docs/adding-a-repo.md`
— that a PR opened by the default token silently never triggers CI — into an
automated check that fails loudly at setup time instead of quietly at first build.

**T1-5 / T1-6 — Make the card legible to a non-engineer.**
On PR open, call Anthropic once with a bounded diff (file list plus truncated
patch) and cache the result in `status_cache`: what changed in plain English,
what to click to test it, and a risk flag. Render it above the fold in
`web/src/pages/CardDetail.tsx`. Demote the per-check list behind a disclosure and
replace it with one green/red chip.

*Scoped out deliberately:* preview screenshots. They require a headless browser
in the container and are not worth the image size in this tier. Follow-up ticket.

**T1-7 / T1-8 — Revert.**
I am not going to assert a mechanism I have not verified. GitHub exposes a Revert
button in the UI; I do not know that it exposes a public API for it, and building
a revert by hand through the Git Data API without a local checkout is genuinely
awkward. So: spike first.

The honest fallback, which delivers most of the value: deep-link to the
provider's own revert affordance, then detect and track the resulting revert PR
on the board. One click, no local git, no invented API. Ship that if the spike
comes back negative.

**T1-9 — Spend cap.**
The Messages API returns token usage on every response. Add a `spend` table,
record usage per chat turn and per summary call, and gate further Anthropic calls
on `DISPATCH_DAILY_BUDGET_USD`. Fail with a clear, non-destructive error that
preserves the user's typed input (the existing S4 contract). Actions-minutes cost
is Tier 2; this ticket covers the spend a vibecoder can trigger by talking.

**Deliberately deferred to Tier 2, not dropped:** the automated review gate before
Ship. It matters — industry benchmarks put roughly 45% of AI-generated code in
violation of the OWASP Top 10, and Dispatch holds a token that merges to
production. But doing it properly means the
review-artifact contract (T2-5), and doing it improperly means a second
half-trusted signal. It waits.

---

## [3] Tier 2 — Depth for AI professionals

**Goal.** Close the review loop inside the tab, stop the board from lying about
production, and become the only *team-shareable* board in a category of
single-user desktop apps.

**Exit criteria**
- A reviewer can read the diff and steer the agent without leaving Dispatch.
- `Shipped` means deployed, not merged.
- More than one person can use one Dispatch instance, safely.

### Tickets

| ID | Title | Size | Depends on |
|---|---|---|---|
| T2-1 | `getPRDiff()` on the provider interface + in-app diff view | L | T0-5 |
| T2-2 | Inline diff comments that post as `@claude` steer comments | M | T2-1 |
| T2-3 | Split `Shipped` into `Merged` → `Deployed` | M | T0-2 |
| T2-4 | Per-ticket cost telemetry (Actions minutes + Claude tokens) | M | T1-9 |
| T2-5 | Review-artifact contract + Ship gated on verdict | L | T1-3 |
| T2-6 | Real multi-user auth (OIDC) | L | — |
| T2-7 | Webhook ingestion, polling retained as backstop | M | T2-6, T1-1 |

**T2-1 / T2-2 — The review loop.**
Add `getPRDiff(ref, prNumber)` to `GitProvider` and implement it in both
adapters — the seam holds, nothing outside `providers/` learns about Octokit.
Render a unified diff; let a comment on a line post as an `@claude` steer comment
anchored to `file:line`, reusing the existing `POST /api/tickets/:id/comment`
path. This is the feature that keeps a professional from bouncing to github.com,
which is currently the explicit v1 non-goal we should now reverse.

**T2-3 — Stop conflating merged with deployed.**
`deriveColumn` returns `Shipped` the moment the PR merges or the issue closes.
The production deploy run is *already fetched* — `reconcile.ts:108-112` switches
the runs ref to the default branch precisely for this case — and then discarded
for column purposes. Add the state, derive it from that run, extend the T0-2
table. Small code change, meaningful honesty change.

**T2-5 — The review contract, and the bridge to TerMinal.**
TerMinal already renders `.reviews/<pr>/<sha>.md` plus `findings.json` and
`suggestions.json`, with a merge bar of `verdict: approve` + `test_status: pass`
+ zero findings ≥ medium. Dispatch already installs skills into target repos
(`scripts/repo-skills/`).

Have the CI review step emit that same artifact, have Dispatch fetch and render
it, and gate Ship on the same bar. The two products then share one review
contract without either importing the other: TerMinal is the local workbench,
Dispatch is the browser board, and one repo can be driven from either. This is
the highest-leverage integration available and most of it exists on both sides
already.

**T2-6 — The moat.**
`DISPATCH_PASSWORD` is a shared password over HTTP Basic
(`server/lib/auth.ts`), deliberately simple, explicitly a gate to sit behind an
IAM-authenticated proxy. It is not multi-user. Replacing it with OIDC plus a
`users` table and per-repo ACLs is what makes Dispatch a team product — and every
local competitor structurally cannot follow, because they are single-user desktop
apps with no server. Keep `DISPATCH_PASSWORD` for the localhost path.

This is the ticket that changes what Dispatch *is*. It should not be started
casually, and it should probably be its own session.

**T2-7 — Webhooks.**
`reconcileTicket` is already decoupled from the scheduler and documented as
webhook-ready (`ARCHITECTURE.md §15`). Add `POST /api/webhooks/:provider` with
HMAC verification, call `reconcileTicket` directly, and keep the 5-minute poll as
a reconciliation backstop — never as the primary path. Requires a public URL,
which is why it depends on T2-6 landing first.

---

## [4] Decisions taken, and decisions still open

**Taken (flat cost — reversible, logged not asked):**
- Vitest as the test runner (T0-1). Shares Vite's existing resolution.
- Correction-entry style for the doc fix (T0-7), not silent rewriting.
- Preview screenshots dropped from T1-6.
- AES-256-GCM in SQLite for the App private key, not GCP Secret Manager (T1-1,
  ADR-0006 [6.1]) — Secret Manager needs `secretmanager.admin` on the runtime SA
  and couples a deploy-anywhere tool to one cloud.
- `forRepo()` falls back to `GITHUB_TOKEN` for a repo the App was not granted,
  rather than returning a token that 404s on every call (T1-1).

**Open, and each needs an answer before its ticket starts:**

1. ~~**T1-0 — GitHub App installation tokens vs. the anti-recursion rule.** Settle
   by spike, not by argument. Gates all of Tier 1.~~
   **Fully resolved 2026-07-10.** The spike produced ADR-0002 and ADR-0006, and
   ADR-0006 [2] went further: the workflow stops opening PRs entirely, Dispatch's
   server opens them, and `GH_PAT` loses its only caller. The load-bearing arm — that
   a PR opened by an *installation token* triggers `pull_request` runs without
   approval — was inferred from a PAT observation, and **#22 observed it directly.
   It holds.** `GH_PAT` is deleted for good; ADR-0006 [8] and ADR-0002 [5] now say
   *observed*. Nothing gates T1-3.
2. ~~**T1-7 — Revert mechanism.** Spike. Fallback (deep-link + track the resulting
   PR) is acceptable and should be assumed until the spike says otherwise.~~
   **Resolved 2026-07-09 — the spike said otherwise.** Both providers expose a
   public revert API, so the fallback is demoted to the permission-denied path.
   They are asymmetric: GitHub's mutation opens a PR, GitLab's REST endpoint
   commits directly to a branch and must have an MR synthesized around it. See
   `docs/decisions/0003-revert-mechanism-per-provider.md` (ADR-0003); #9 amended.
3. **T2-6 — OIDC provider.** GitHub as the identity provider is the obvious
   default given every user already has an account and we are already asking for
   an App installation. Recommend it; confirm before building.
4. **New (T1-1) — what should Discover *show* when an App is installed?** This is the
   open product decision inside #21, and it must be answered before that ticket is
   built. An installation token cannot enumerate an account's repos, so either
   Dispatch fans out over `GET /app/installations` → `GET /installation/repositories`
   and merges, or it drops server-side discovery on the App path and lets GitHub's
   own installation picker be the discovery UI. The second is less code and matches
   where the operator already chose repos in #2's flow — but it changes what the
   Repos page's **Discover** section means.

**Escalating-cost items flagged for explicit approval before execution**, per the
decision protocol: ~~T1-1 (registers an external GitHub App)~~ — *dissolved by
ADR-0006 [5]: the operator registers their own App, on their own account, by their
own click on github.com; nothing escalating is executed by an agent* — T1-3 (writes
workflow files and secrets into user repos), T1-8 (creates revert PRs), T2-6
(changes the auth model). None of these should be executed as a side effect of
"work the plan."

---

## [5] Sequencing

`✔` = merged. `◆` = the next thing to do.

```
T0 (all) ✔ ─────────────────────────────────► gate: verify green in CI
   │
   ├─ T1-0 ✔ spike ─► T1-1 ✔ ─┬─► #22 ✔ ─► T1-3 ✔ ─► ◆T1-4  (browser onboarding)
   │                  T1-2 ✔ ─┘     ▲                        (seam; landed independently)
   │                                └── observed ADR-0006 [8]; it holds
   ├─ T1-5 ✔ ─► T1-6 ✔                                    (legible card)
   ├─ T1-7 ✔ spike ─► T1-8 ✔                              (revert)
   ├─ T1-9 ✔                                              (spend cap)
   └─ #21 ✔                                               (retire the env token)
        │
        ├─ T2-1 ─► T2-2                               (review loop)
        ├─ T2-3                                       (merged vs deployed)
        ├─ T2-4
        ├─ T2-5  ◄── depends on T1-3                  (review contract / TerMinal bridge)
        └─ T2-6 ─► T2-7                               (auth, then webhooks)
```

Tier 1's four tracks were independent and ran in parallel; three are done. The
onboarding track is strictly serial, and **T1-3 has now landed** — what remains of
Tier 1 is T1-4 alone. **#22 was inserted ahead of T1-3 on purpose:** T1-3 and T1-4
are both built on ADR-0006 [8]'s unobserved arm, so verifying it cost fifteen
minutes and de-risked two L/M tickets. It held.

#21 landed (PR #13), so "no PAT" is now true of Discover too — which is how a repo
gets onboarded in the first place.

Tier 2 should not start before Tier 1's onboarding track lands, because T2-5
depends on Dispatch owning the workflow it needs to modify.

## [6] What this plan deliberately does not do

- No terminal, no local worktrees, no local agent execution.
- No mobile-native app; responsive web remains sufficient.
- No attempt to replace the provider's code-review UI wholesale — T2-1 closes the
  common loop, deep review still links out.
- No abandonment of the rebuild rule. Every feature here keeps the provider as the
  source of truth and every new cache table disposable.
