# Implementation

## Scope Implemented

- **Requested scope:** Tier 0 (T0-1 … T0-10) from `docs/BUILD_PLAN-v2.md`
- **Related phase:** Tier 0 — "Earn the right to ship publicly"
- **Related ticket(s):** T0-1 … T0-10 — **all Complete**. T0-9 was blocked mid-run
  on a schema decision (its planned mechanism was a latent bug); the decision was
  taken (new `http_cache` table) and it landed.

### Input-file substitutions (stated assumptions)

The `/implement` skill expects `/docs/spec.md` and `/docs/BUILD_PLAN.md`. Neither
holds the requested scope, so:

- **Spec** → `docs/PRD-dispatch.md` (v1.1). This matches the standing assumption
  already recorded in `docs/BUILD_PLAN.md` and `docs/implementation-notes.md`:
  *"No `/docs/spec.md`. Treated `PRD-dispatch.md` as the spec."*
- **Build plan** → `docs/BUILD_PLAN-v2.md`. `docs/BUILD_PLAN.md` covers v1
  (Phases 1–6, all Complete) and contains no T0 tickets.
- `/docs/ux.md` is absent; `docs/ARCHITECTURE.md` served the clarifying role, as
  in v1. Used for clarification only — no scope added.

---

## Approach

**Strategy.** Tier 0 is a credibility gate, not a feature. The repo claimed a test
suite it did not have and shipped a CI workflow that could not run. The work was
therefore: make the claims true, in the order that keeps the tree green at every
commit.

**Key decisions**

- **Vitest** as the runner (flat-cost, taken not asked). Vite is already a
  dependency, so it shares the existing TS/ESM resolution and adds no new
  toolchain. Resolved to 4.1.10 and works against this repo's Vite 5.
- **`pool: "forks"`, `fileParallelism: false`.** `better-sqlite3` is a native
  module and the integration suites share one on-disk test database. Serial files
  plus `resetDb()` between tests is sufficient isolation and keeps the suite ~2s.
- **No `supertest`.** Node 20 has global `fetch`, so `withServer()` binds the
  router to an ephemeral port and tests over a real socket. One fewer dependency.
- **Three small extractions, each forced by testability, none speculative:**
  `providers/linkage.ts` (the rule was duplicated in both adapters and welded to
  their network calls), `lib/ticket-json.ts` (the parser was private to an Express
  route), and `setProviderFactory()` (the merge route was unreachable without a
  real token). Behavior unchanged in all three.
- **T0-1 and T0-2 share one commit.** `vitest run` exits non-zero when it finds no
  test files, so the harness alone would have left `verify` red. Deviation from
  strict commit-per-ticket, logged here.
- **Corrections annotated in place, not deleted.** `implementation-notes.md` is a
  human-review log; silently rewriting a false entry destroys the evidence that it
  was ever believed.

**Assumptions**

- `data/` is gitignored, so the test database (`data/test-dispatch.db`) needs no
  new ignore rule.
- CI's `npm ci` fetches a `better-sqlite3` prebuild for linux-x64; no native
  toolchain step added. (Unverified on a real runner — see Open Issues.)

---

## Implementation Plan

Executed in this order, each step ending green:

1. T0-1 — add vitest, `test` script, fold into `verify`.
2. T0-2 — `deriveColumn` table tests (pure, zero dependencies).
3. T0-3 — extract `providers/linkage.ts`; point both adapters at it; test.
4. T0-4 — extract `lib/ticket-json.ts`; test parser; test the route's retry contract.
5. T0-5 — add `setProviderFactory()`; test every merge-gate branch; mutation-check it.
6. T0-6 — replace the CI workflow; prove the exact command sequence locally.
7. T0-8 — delete the stale comment.
8. T0-7 — correct the log (after the tests it lied about actually exist).
9. T0-10 — boot-time ephemeral-DB warning.
10. T0-9 — **stopped and flagged** (below).

**Files created:** `vitest.config.ts`, `server/test/helpers.ts`,
`server/providers/linkage.ts`, `server/lib/ticket-json.ts`,
`server/poller/reconcile.test.ts`, `server/providers/linkage.test.ts`,
`server/lib/ticket-json.test.ts`, `server/routes/chat.test.ts`,
`server/routes/tickets.test.ts`, `server/lib/env.test.ts`.

**Files modified:** `package.json`, `.github/workflows/ci.yml`,
`server/providers/index.ts`, `server/providers/github.ts`,
`server/providers/gitlab.ts`, `server/routes/chat.ts`, `server/lib/env.ts`,
`server/index.ts`, `docs/implementation-notes.md`.

---

## Code Changes

### File: `package.json`, `vitest.config.ts`
- **Change summary:** T0-1. Adds the `vitest` devDependency, a `test` script, and
  extends `verify` to `typecheck && check:seam && test`. `verify` is now the
  single gate CI runs.

### File: `server/providers/linkage.ts` (new)
- **Change summary:** T0-3. Extracts the F4.4 linkage rule from both adapters.
```ts
export function linksToIssue(issueNumber: number, candidate: LinkCandidate): boolean {
  const bodyRef = new RegExp(`#${issueNumber}(?!\\d)`);
  const branchRef = new RegExp(`(?<!\\d)${issueNumber}(?!\\d)`);
  return bodyRef.test(candidate.body ?? "") || branchRef.test(candidate.branch ?? "");
}
```
- `github.ts` and `gitlab.ts` now both call `findLinked(...)`. No behavior change.

### File: `server/lib/ticket-json.ts` (new)
- **Change summary:** T0-4. `tryParseTicket` / `stripFences` moved out of
  `routes/chat.ts` verbatim. The route keeps the retry policy; the module answers
  only "is this a valid ticket?".

### File: `server/providers/index.ts`
- **Change summary:** T0-5. Adds a test-only injection seam.
```ts
let factoryOverride: ProviderFactory | null = null;
export function setProviderFactory(factory: ProviderFactory | null): void {
  factoryOverride = factory;
  resetProviderCache();
}
export function getProvider(provider: ProviderId, host?: string | null): GitProvider {
  if (factoryOverride) return factoryOverride(provider, host);
  /* …unchanged memoized construction… */
}
```
- Production path untouched: `factoryOverride` stays null, adapters stay memoized,
  and the in-process ETag cache still survives poll cycles.

### File: `server/lib/env.ts`, `server/index.ts`
- **Change summary:** T0-10. `ephemeralDbWarning()` (pure; fs probe injected) plus
  `warnIfEphemeralDb()` called after `getDb()` at boot. Fires only when
  `ALLOW_NONLOCAL=1` and the DB's directory is not a mount point (device-id
  comparison against its parent).

### File: `.github/workflows/ci.yml`
- **Change summary:** T0-6. Was unadapted template boilerplate (`bun install
  --frozen-lockfile`, `bun run format:check`, `bun test`) against an npm project
  with none of those scripts. Now node 20 → `npm ci` → `npm run verify` →
  `npm run build`.

### File: `server/providers/github.ts`
- **Change summary:** T0-8. Removed the stale two-line "Methods below are …
  Stubbed here" comment. Every method beneath it is fully implemented.

### File: `docs/implementation-notes.md`
- **Change summary:** T0-7. Annotates the three false test claims in place and
  appends a dated correction entry plus a standing rule.

---

## Acceptance Criteria Mapping

Criteria from `docs/PRD-dispatch.md` §11 that this work touches:

- **Criterion:** #3 — *"A spec chat produces a Generate-ticket preview whose JSON
  always parses (10 consecutive generations, 0 unhandled parse failures)."*
  - **Implementation:** 20 parser cases prove `tryParseTicket` returns `null`
    (never throws) for ten shapes of unusable input; 5 route cases prove the
    retry-once contract and a clean 502 on double failure.
  - **File(s):** `server/lib/ticket-json.ts`, `server/lib/ticket-json.test.ts`,
    `server/routes/chat.test.ts`
  - *Note:* the **live** 10× run still needs `ANTHROPIC_API_KEY`. Robustness is now
    proven; the live pass remains deferred.

- **Criterion:** #7 — *"Ship merges the PR, the issue auto-closes, and the card
  reaches Shipped without manual refresh."*
  - **Implementation:** 14 merge-gate cases, including immediate reconciliation to
    `Shipped` and both provider-failure paths (F6.4).
  - **File(s):** `server/routes/tickets.test.ts`

- **Criterion:** #8 — *"A failed check moves the card to Blocked with the failing
  check named."*
  - **Implementation:** `deriveColumn` precedence pinned — Blocked outranks
    Building; Shipped outranks Blocked.
  - **File(s):** `server/poller/reconcile.test.ts`

- **Criterion:** #12 — *"…no GitLab-specific code outside the adapter — verified by
  grepping for `gitbeaker` imports outside `providers/`."*
  - **Implementation:** the seam guard is now a hard CI step inside `npm run
    verify`, not a command someone remembers to run.
  - **File(s):** `.github/workflows/ci.yml`, `scripts/check-seam.sh`

- **Criterion:** F4.4 (PR linkage) — digit-bounded matching now pinned in both
  directions for both adapters.
  - **File(s):** `server/providers/linkage.test.ts`

---

## Build Plan Mapping

Tickets from `docs/BUILD_PLAN-v2.md` §1:

| Ticket | Status | What was completed | Remaining work |
|---|---|---|---|
| T0-1 | Complete | vitest + `test` script + folded into `verify` | — |
| T0-2 | Complete | 13 `deriveColumn` cases | — |
| T0-3 | Complete | `linkage.ts` extracted; 22 cases; both adapters migrated | — |
| T0-4 | Complete | `ticket-json.ts` extracted; 20 parser + 5 retry-contract cases | — |
| T0-5 | Complete | `setProviderFactory()` seam; 14 merge-gate cases; mutation-verified | — |
| T0-6 | Complete | CI = node 20 + `npm ci` + `verify` + `build` | Unproven on a real runner |
| T0-7 | Complete | False claims annotated; correction entry + standing rule appended | — |
| T0-8 | Complete | Stale comment removed | — |
| T0-9 | Complete | `http_cache` table + `CondCache` with a cold-start guard; 21 cases | — |
| T0-10 | Complete | Pure `ephemeralDbWarning()` + boot warning; 5 cases | — |

### T0-9 — the plan's mechanism was a latent bug (flagged, decided, then landed)

**What the plan said.** "Load the persisted `status_cache.etag_map_json` map into
the provider on construction and write it back on reconcile."

**Why that could not work.**

1. `github.ts` `cond()` returns **`cached.data`** on a 304 response.
2. An HTTP 304 carries **no body** — that is the entire point of the ETag round trip.
3. So the cache must persist the **body** alongside the ETag. Hydrating
   `{ etag, data: undefined }` makes `cond()` return `undefined` on the first 304
   after a cold start, which flows into `prs.find(...)` / `issue.state` as a
   `TypeError`. `safeReconcile` swallows it, so the ticket would simply stop
   updating — a silent, permanent failure.

Verified with a throwaway simulation of `cond()` hydrated from an etag-only map:
it returned `undefined` and threw `TypeError` downstream. (Scratch test removed,
not committed.)

**The grain was also wrong.** `condCache` keys are per-repo/resource
(`pulls.list:owner/name`), shared across every ticket in that repo, while
`status_cache` is keyed per-ticket.

**Decision taken (approved):** option (a), a new disposable table.

**What shipped:**
- `http_cache(key PRIMARY KEY, etag, body_json, updated_at)` — correct grain, body
  stored with the etag, disposable so the rebuild rule holds.
- `providers/cond-cache.ts` — `cond()` extracted from `github.ts` into a testable
  `CondCache` that **refuses to hydrate an entry lacking a body or a string etag**,
  making the original bug unrepresentable. Mutation-checked: removing that guard
  fails exactly the two cold-start regression tests.
- Store injected at boot from `server/index.ts` via `setCondCacheStore()`, so
  `providers/` never imports the db layer and tests default to in-process caching.
- `loadHttpCache()` drops corrupt rows rather than surfacing a bodyless entry;
  bodies >512 KB and unserializable bodies are never persisted (in-process only).
- Dead `getEtagMap()` and the always-`{}` `status_cache.etag_map_json` column
  removed, with an idempotent `ALTER TABLE ... DROP COLUMN` migration — verified on
  a simulated legacy database: column dropped, rows preserved, `http_cache`
  created, idempotent on reopen.

---

## Validation

**Command:** `npm run verify` → `typecheck` → `check:seam` → `vitest run`

```
✓ typecheck        server + web, clean
✓ seam clean       no @octokit/@gitbeaker imports outside server/providers/
✓ Test Files  8 passed (8)
✓      Tests  100 passed (100)   ~3.1s
```

`npm run build` → web bundle builds clean (200.97 kB, gzip 63.40 kB).

**Tests are not tautological.** The merge gate was mutation-checked:

| Mutation | Result |
|---|---|
| Delete the `pr.mergeable === false` check | exactly 1 test fails |
| Accept pending checks (drop `\|\| c.state === "pending"`) | exactly 1 test fails |

`server/routes/tickets.ts` was restored byte-identically afterwards (`git diff`
empty).

**Manual verification.** `warnIfEphemeralDb` exercised in all three modes: silent
in local dev, silent on a real mount point (`/`), loud on an unmounted container
path (`/data`) with the DEPLOY.md pointer in the message.

**Visible user outcome.** No user-facing behavior changed — this tier is a gate,
by design. The observable difference: `npm run verify` and CI now **fail** on a
regression in board-column derivation, PR linkage, ticket parsing, or the merge
gate, where previously they could not fail at all.

---

## Open Issues

- **CI is unproven on a real runner.** The workflow was validated by running its
  exact command sequence locally on macOS/Node 22. The `better-sqlite3` prebuild
  fetch under `npm ci` on `ubuntu-latest` + Node 20 has not been exercised; if no
  linux-x64 prebuild exists for the pinned version, a build-tools step is needed.
  The first push answers this.
- **`engines` says `node >=20`; local dev ran Node 22.** Unchanged from before.
- **Test DB is shared across suites** (`data/test-dispatch.db`, gitignored) with
  `fileParallelism: false`. Fine at this size; if the suite grows, give each file
  its own database.
- **Coverage is deliberately narrow.** Tier 0 tests the pure logic and the one
  endpoint that merges to production. The poller's reconcile loop, the board
  route, and every adapter's network path remain untested — they need either live
  credentials or an HTTP-level fake, which is outside Tier 0's scope.
- **`http_cache` has no eviction.** Entries are overwritten per key and the key set
  is bounded by (tracked repos × endpoints), so it cannot grow without bound. No
  TTL or vacuum is wired; if a repo is untracked its rows linger until the table is
  cleared. Harmless (disposable), but worth a sweep if repo churn is high.

---

## BUILD_PLAN Update

`docs/BUILD_PLAN-v2.md` §1 carries the per-ticket status table.

- **Current phase:** Tier 0 — Earn the right to ship publicly — **Complete**
- **Current ticket:** none
- **Updated ticket status:** T0-1 … T0-10 → **Complete**
- **Blockers:** none. (T0-9 was blocked mid-run on a schema decision; resolved in
  favour of a new disposable `http_cache` table, and landed.)
- **Recommended next ticket:** **T1-0** — the spike on whether GitHub App
  installation tokens trigger workflow runs where the default `GITHUB_TOKEN` does
  not. It gates the whole of Tier 1 and should be settled before any of T1-1…T1-4
  is designed. Tier 0's exit criteria are met: `verify` is green (100 tests) and no
  doc claim is unbacked by code.
