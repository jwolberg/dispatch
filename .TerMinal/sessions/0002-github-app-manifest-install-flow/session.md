---
id: 2
slug: github-app-manifest-install-flow
anchor: SES-0002
title: "GitHub App (#2) — manifest registration, install flow, encrypted key at rest"
status: active
started: 2026-07-09T22:11:01Z
ended: null
goal: "Land ticket #2 (T1-1): GitHub App manifest registration + OAuth install flow — per-deployment App registration, SQLite-backed InstallationStore wired at boot, encrypted private key at rest, value-registration redactor"
tickets: [2]
branches: []
prs: []
related_research: []
related_docs:
  - docs/decisions/0002-github-app-tokens-and-the-anti-recursion-rule.md
  - docs/decisions/0005-durable-state-via-gcs-snapshot.md
  - docs/decisions/0006-dispatch-opens-the-pr-and-the-app-is-registered-per-deployment.md
  - docs/BUILD_PLAN-v2.md
  - DEPLOY.md
prior_sessions: [1]
---

## [1] Goal

Make GitHub App registration and installation possible entirely from the browser,
per deployment, and persist the resulting credentials safely. Done means: an
operator registers their own App via GitHub's manifest flow, installs it on repos,
the installation lands in SQLite with the private key encrypted at rest, and
`server/index.ts` injects a real `InstallationStore` so the seam #3 landed stops
being dead code and a tracked repo actually polls with a minted installation token.

`GITHUB_TOKEN` must keep working as the local-development path throughout.

## [2] Context & pointers

### [2.1] In-scope tickets

**#2 — GitHub App: manifest registration + OAuth install flow** (T1-1, high, `now`,
depends on #1 which is closed). 13 acceptance criteria in frontmatter. Grouped:

- *Registration* — manifest POST to `github.com/settings/apps/new` (optionally
  `?org=`); App name is an editable UI field, defaulted; nothing about the App is
  committed to this repo (ADR-0006 [5]).
- *Persistence* — app id, installation id, account, repo selection in SQLite,
  surviving container restart.
- *Wiring* — `server/index.ts` calls `setInstallationStore()`; without it #3's
  seam is dead code and `AppTokenSource` is never constructed in production.
- *Secret safety* — private key encrypted at rest under an env-supplied key;
  a test asserts the key never reaches `safeMessage()` output; `DEPLOY.md` gains a
  lifecycle rule expiring noncurrent object versions.
- *Verification* — integration test on the callback (valid code, replayed code,
  mismatched state); a live end-to-end check that a tracked repo polls with a
  minted installation token, not `GITHUB_TOKEN`; a live PR opened with an
  installation token whose `workflow_run` is recorded in ADR-0006 [8].

Manifest permissions per the ticket: `pull_requests: write`, `contents: write`,
`workflows: write`, `issues: write`, `secrets: write`, `actions: read`,
`metadata: read`.

Unblocks #4, #21, and (transitively) #5 and #15.

### [2.2] What #3 already landed (scope reduction — verified, not assumed)

Read before planning; this changes the checklist:

- **The redactor is already inverted.** `server/lib/redaction.ts` has
  `registerSecret()` / `unregisterSecret()` and a `registered` value set alongside
  the `SECRET_ENV_KEYS` env scan. ADR-0006 [6.3] assigned this to #2; ADR-0006 [7]
  records the correction — it landed in #3 because a minted token was the first
  secret outside `process.env`. **#2's remaining obligation is to call
  `registerSecret()` when a private key is loaded from SQLite, and to test it.**
- **The seam exists.** `server/providers/installations.ts` defines `Installation`,
  `RepoKey`, and the `InstallationStore` interface #2 must implement.
  `server/providers/index.ts` has `setInstallationStore()`, memoizes on
  `(provider, host, installationId)`, and falls back to `EnvTokenSource` when the
  store is unset or returns null. `resetProviderCache()` exists and is already
  called on `setInstallationStore()`.
- **Token minting is done and tested.** `server/providers/token-source.ts` has
  `AppTokenSource` with RS256 JWT signing (`node:crypto`, no new dep), hourly
  refresh with a 10-minute margin, single-flight mint, and stale-token-guarded
  `invalidate()`. `token-source.test.ts` and `github-auth.test.ts` cover it.

So #2 is **registration, persistence, encryption, and boot wiring** — not minting.

### [2.3] Research & docs

- **ADR-0006** (`docs/decisions/0006-…md`) is the governing document.
  - [5] — no central Dispatch App; each operator registers their own via the
    manifest flow. The App name/client id/key are never committed here.
  - [6] — the private key is *runtime state*, not boot state: it arrives in the
    callback. [6.1] rejects GCP Secret Manager (needs `secretmanager.admin`;
    couples a deploy-anywhere tool to one cloud) → SQLite. [6.2] `snapshot.ts`
    `VACUUM INTO`s and uploads the whole DB verbatim, and `DEPLOY.md:126` enables
    bucket versioning on purpose, so a rotated key stays readable in an old object
    version forever → encrypt the column *and* set a lifecycle rule.
  - [8] — "**Inferred, not observed**: that a PR opened by an App installation
    token triggers `pull_request` runs without approval." **#2 registers the first
    App; the moment one exists, close this inference.** This is checklist [3.7].
- **ADR-0002** [5] flags the same open inference; [3.1] records
  `can_approve_pull_request_reviews: false` on `jwolberg/situation`.
- **ADR-0005** — durable state via GCS snapshot; the mechanism [6.2] worries about.
- `DEPLOY.md` §4 grants the runtime SA only `storage.objectAdmin` on one bucket.
  Line ~125–126 create the bucket with uniform access + public-access-prevention
  and enable versioning.
- `server/db/schema.sql` reasons at length about *disposable* vs *rebuildable*
  tables. It has no concept of a **confidential** table. `installations` is the
  first one, and it is neither disposable nor rebuildable — say so in the schema
  comment.

### [2.4] Design notes carried in from the ticket

- **Nothing outside `server/providers/` learns what an installation is.** The
  route and db layers hand the store to `setInstallationStore()`; the store
  implements `forRepo(key): Installation | null`.
- **Cache invalidation on installation change** (raised by review of #3's seam):
  the memoized adapter holds an `AppTokenSource` holding one `privateKey` for the
  life of the process. Regenerate the key or reinstall the App, and the adapter
  mints against dead credentials forever — a 401 triggers exactly one re-mint,
  which reuses the same stale key. The store is the only thing that knows an
  installation changed. **Call `resetProviderCache()` on any write to the
  installations table**; the ticket says this crude answer is probably enough.
- **Account-level calls are #21, not this ticket.** `getProvider()`'s doc comment
  in `providers/index.ts:124` says rewiring the rate-limit probe, health route,
  and `discoverRepos()` "belongs to #2's source swap." That is now stale — it
  became ticket #21 (`depends_on: [2, 3]`). Fix the comment; don't do the work.

### [2.5] Prior sessions

**SES-0001** (`.TerMinal/sessions/0001-per-repo-credential-seam/`, closed) — landed
#3 as PR #10. Its follow-ups produced ticket #21 and the two corrections now
recorded in BUILD_PLAN-v2 [2] and ADR-0006 [7].

### [2.6] Git / PR state

Branch `chore/merge-sync-pr-10` (the last session's cleanup; nothing in flight).
No open PRs. `git log` head is `5de452e chore(SES-0001): close the session…`.
Working tree has a large set of untracked `.claude/` and `.agents/` tooling files
unrelated to this work — leave them alone.

Branch for this session comes off `main`.

## [3] Checklist

### [3.1] Encryption at rest (ADR-0006 [6.2])

- [ ] write failing test: `encrypt`/`decrypt` round-trips, rejects a tampered
      ciphertext, and refuses a missing/short `DISPATCH_ENCRYPTION_KEY`
- [ ] implement `server/lib/crypto.ts` (AES-256-GCM, `node:crypto`, no new dep)
- [ ] write failing test: boot fails loudly when an `installations` row exists and
      `DISPATCH_ENCRYPTION_KEY` is unset — never silently degrade to plaintext

### [3.2] Persistence + the store (`InstallationStore` implementation)

- [ ] write failing test: `installations` round-trips through a reopened DB; the
      private key column is ciphertext on disk and PEM after `forRepo()`
- [ ] write failing test: a private key loaded from SQLite does **not** appear in
      `safeMessage()` output for an error that embeds it (AC 9)
- [ ] write failing test: writing an installation calls `resetProviderCache()`
      (the stale-key trap in [2.4])
- [ ] implement the `installations` schema migration + schema.sql comment naming
      this the first **confidential** table
- [ ] implement `server/db/installations.ts` → `SqliteInstallationStore`, calling
      `registerSecret()` on every key it decrypts

### [3.3] Manifest registration

- [ ] write failing test: the manifest has exactly the seven permissions from
      [2.1], carries a CSRF `state`, and takes the App name from the request
- [ ] implement `GET /api/github/app/manifest` + the form POST target
      (`github.com/settings/apps/new`, optional `?org=`)
- [ ] write failing test: the conversion callback handles valid code, **replayed
      code**, and **mismatched state** correctly (AC 12)
- [ ] implement `POST /api/github/callback` — exchange the code once for app id,
      client id, client secret, private key, webhook secret; persist encrypted

### [3.4] Install flow + boot wiring

- [ ] write failing test: the install callback records installation id, account,
      and repo selection
- [ ] implement the install redirect + callback
- [ ] wire `setInstallationStore(new SqliteInstallationStore(db))` in
      `server/index.ts` (AC 5 — without this the whole seam stays dead)
- [ ] write failing test: with no App installed, `getProviderForRepo()` still
      resolves the `GITHUB_TOKEN` adapter (AC 11 — the local path must not regress)

### [3.5] Setup screen

- [ ] App name field (defaulted, editable), optional org field, Register button,
      then Install button; installation state rendered on the repo card

### [3.6] Close out

- [ ] fix the stale `#2` comment at `providers/index.ts:124` → point at #21
- [ ] `DEPLOY.md`: `DISPATCH_ENCRYPTION_KEY` + the noncurrent-version lifecycle
      rule (AC 10)
- [ ] `npm run verify` green
- [ ] open PR + link the url into ticket #2 `prs:`

### [3.7] Live verification — needs a real App (AC 6, 13)

Cannot be satisfied by unit tests, and cannot be done for you: it requires the
operator to register an App on their own account.

- [ ] register the App, install it on a scratch repo, confirm the repo polls with
      a minted installation token rather than `GITHUB_TOKEN`
- [ ] open a PR with that installation token; record the resulting `workflow_run`
      in ADR-0006 [8], closing the inference flagged there and in ADR-0002 [5]

## [4] Log

### [4.1] 2026-07-09T22:11Z — session seeded

Scanned the seam #3 landed before planning. Two scope corrections versus the
ticket text, both recorded in [2.2] and [2.4]: the redactor inversion is already
done (only the SQLite-key registration and its test remain), and the account-level
`getProvider()` rewiring is ticket #21, not this one. Checklist reflects both.

## [5] Decisions

*(none yet)*

## [6] Outcomes

*(filled by /session-end)*

## [7] Follow-ups

*(filled by /session-end)*

## [8] Documentation

*(filled by /session-end)*
