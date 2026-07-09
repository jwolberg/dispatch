# Build Plan v2 — Tiers 0–2

**Status:** Tier 0 **complete** (10/10). Tiers 1–2 not started.
**Supersedes:** nothing. `docs/BUILD_PLAN.md` covers v1 (Phases 1–6, complete).
**Source:** assessment of 2026-07-09 (Dispatch vs. TerMinal vs. the 2026 orchestrator market).
**Last updated:** 2026-07-09 — see `docs/implementation.md` for the Tier 0 run.

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

| ID | Title | Size | Depends on |
|---|---|---|---|
| T1-0 | **Spike:** GitHub App installation tokens and the anti-recursion rule | S | — |
| T1-1 | GitHub App: manifest registration + OAuth install flow | L | T1-0 |
| T1-2 | Per-repo credential resolution (replaces the global env token) | M | T1-1 |
| T1-3 | `POST /api/repos/:id/setup` — write workflows + secrets via API | L | T1-2 |
| T1-4 | Canary verification: prove the build triggers, at setup time | M | T1-3 |
| T1-5 | Plain-language change summary on the card | M | T0-1 |
| T1-6 | Preview-first card: hero preview + single verdict chip | S | T1-5 |
| T1-7 | **Spike:** revert mechanism per provider | S | — |
| T1-8 | One-click revert | M | T1-7 |
| T1-9 | Spend tracking + daily budget cap | M | T0-1 |

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

**Open, and each needs an answer before its ticket starts:**

1. **T1-0 — GitHub App installation tokens vs. the anti-recursion rule.** Settle
   by spike, not by argument. Gates all of Tier 1.
2. **T1-7 — Revert mechanism.** Spike. Fallback (deep-link + track the resulting
   PR) is acceptable and should be assumed until the spike says otherwise.
3. **T2-6 — OIDC provider.** GitHub as the identity provider is the obvious
   default given every user already has an account and we are already asking for
   an App installation. Recommend it; confirm before building.

**Escalating-cost items flagged for explicit approval before execution**, per the
decision protocol: T1-1 (registers an external GitHub App), T1-3 (writes
workflow files and secrets into user repos), T1-8 (creates revert PRs), T2-6
(changes the auth model). None of these should be executed as a side effect of
"work the plan."

---

## [5] Sequencing

```
T0 (all)  ──────────────────────────────────► gate: verify green in CI
   │
   ├─ T1-0 spike ─► T1-1 ─► T1-2 ─► T1-3 ─► T1-4     (browser onboarding)
   ├─ T1-5 ─► T1-6                                    (legible card)
   ├─ T1-7 spike ─► T1-8                              (revert)
   └─ T1-9                                            (spend cap)
        │
        ├─ T2-1 ─► T2-2                               (review loop)
        ├─ T2-3                                       (merged vs deployed)
        ├─ T2-4
        ├─ T2-5  ◄── depends on T1-3                  (review contract / TerMinal bridge)
        └─ T2-6 ─► T2-7                               (auth, then webhooks)
```

Tier 1's four tracks are independent of each other and can run in parallel once
Tier 0 is green. Tier 2 should not start before Tier 1's onboarding track lands,
because T2-5 depends on Dispatch owning the workflow it needs to modify.

## [6] What this plan deliberately does not do

- No terminal, no local worktrees, no local agent execution.
- No mobile-native app; responsive web remains sufficient.
- No attempt to replace the provider's code-review UI wholesale — T2-1 closes the
  common loop, deep review still links out.
- No abandonment of the rebuild rule. Every feature here keeps the provider as the
  source of truth and every new cache table disposable.
