---
id: 2
slug: github-app-manifest-install-flow
anchor: SES-0002
title: "GitHub App (#2) — manifest registration, install flow, encrypted key at rest"
status: closed
started: 2026-07-09T22:11:01Z
ended: 2026-07-10T18:40:00Z
goal: "Land ticket #2 (T1-1): GitHub App manifest registration + OAuth install flow — per-deployment App registration, SQLite-backed InstallationStore wired at boot, encrypted private key at rest, value-registration redactor"
tickets: [2]
branches:
  - feat/2-github-app-manifest-install-flow
prs:
  - "https://github.com/jwolberg/dispatch/pull/11"
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

- [x] write failing test: `encrypt`/`decrypt` round-trips, rejects a tampered
      ciphertext, and refuses a missing/short `DISPATCH_ENCRYPTION_KEY`
- [x] implement `server/lib/crypto.ts` (AES-256-GCM, `node:crypto`, no new dep)
- [x] write failing test: boot fails loudly when an `installations` row exists and
      `DISPATCH_ENCRYPTION_KEY` is unset — never silently degrade to plaintext

### [3.2] Persistence + the store (`InstallationStore` implementation)

- [x] write failing test: `installations` round-trips through a reopened DB; the
      private key column is ciphertext on disk and PEM after `forRepo()`
- [x] write failing test: a private key loaded from SQLite does **not** appear in
      `safeMessage()` output for an error that embeds it (AC 9)
- [x] write failing test: writing an installation calls `resetProviderCache()`
      (the stale-key trap in [2.4])
- [x] implement the `installations` schema migration + schema.sql comment naming
      this the first **confidential** table
- [x] implement `server/db/installations.ts` → `SqliteInstallationStore`, calling
      `registerSecret()` on every key it decrypts

### [3.3] Manifest registration

- [x] write failing test: the manifest has exactly the seven permissions from
      [2.1], carries a CSRF `state`, and takes the App name from the request
- [x] implement `GET /api/github/app/manifest` + the form POST target
      (`github.com/settings/apps/new`, optional `?org=`)
- [x] write failing test: the conversion callback handles valid code, **replayed
      code**, and **mismatched state** correctly (AC 12)
- [x] implement `POST /api/github/callback` — exchange the code once for app id,
      client id, client secret, private key, webhook secret; persist encrypted

### [3.4] Install flow + boot wiring

- [x] write failing test: the install callback records installation id, account,
      and repo selection
- [x] implement the install redirect + callback
- [x] wire `setInstallationStore(new SqliteInstallationStore(db))` in
      `server/index.ts` (AC 5 — without this the whole seam stays dead)
- [x] write failing test: with no App installed, `getProviderForRepo()` still
      resolves the `GITHUB_TOKEN` adapter (AC 11 — the local path must not regress)

### [3.5] Setup screen

- [x] App name field (defaulted, editable), optional org field, Register button,
      then Install button; installation state rendered on the repo card

### [3.6] Close out

- [x] fix the stale `#2` comment at `providers/index.ts:124` → point at #21
- [x] `DEPLOY.md`: `DISPATCH_ENCRYPTION_KEY` + the noncurrent-version lifecycle
      rule (AC 10)
- [x] `npm run verify` green
- [x] open PR + link the url into ticket #2 `prs:`

### [3.7] Live verification — needs a real App (AC 6, 13) → **moved to #22**

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

### [4.2] 2026-07-09 — the ADR was wrong about GitHub's format

Before writing the manifest builder, checked the format against GitHub's OpenAPI
description and the live `permissions` object of three real Apps. Three of
ADR-0006 [5]'s claims were false, and all three would have compiled. See [5.4].
Cost about fifteen minutes; would otherwise have cost a wrong-owner App.

### [4.3] 2026-07-09 — a leak the tests did not catch

Mutating `safeMessage(err)` to `String(err)` on the 502 path left the suite green.
The weak test was hiding a real gap: `convertManifestCode()` held the plaintext PEM
from the moment GitHub returned it until `saveApp()` encrypted it, and never told
the redactor. Anything throwing in that window would have logged the private key.
Now registered on the success *and* failure paths; two tests pin it.

### [4.4] 2026-07-10 — /session-end found a durability bug in merged code

The cleanup pass asked "what makes this new write path durable?" and the answer was
"nothing." `db/installations.ts` never called `markDirty()`, and both write paths
are **GET** requests (GitHub's own redirects), which `snapshotMiddleware`
short-circuits on purpose so that a board poll never costs an upload.

Net effect on Cloud Run: register an App, redeploy, and the registration is gone.
Dispatch boots clean — no `github_app` row, so the boot gate stays silent — and
falls back to `GITHUB_TOKEN`. Exactly the failure [5.3] was written to prevent,
through a door [5.3] does not watch.

Fixed in `a3494b1`, mutation-checked, captured as
[[oauth-callbacks-are-gets-that-write]]. This is the argument for exercising the
App path locally before deploying it — see [7].

## [5] Decisions

### [5.1] AES-256-GCM envelope, `v1.iv.tag.ciphertext`, keyed by `DISPATCH_ENCRYPTION_KEY`

`node:crypto`, no new dependency. GCM over CBC because the auth tag distinguishes
"this snapshot was edited" from "this private key decrypts to garbage." Versioned
envelope so a later rotation is *detected* rather than mis-parsed, and so
`decryptSecret()` fails closed on a value that was never encrypted. Fresh random
IV per call — GCM loses confidentiality outright on IV reuse under one key.

### [5.2] `forRepo()` resolves by account, then narrows by the granted repo list

When `repository_selection` is `selected` and the repo is not among the grants,
return `null` and let `GITHUB_TOKEN` serve it. The alternative — hand back the
installation anyway — turns every call on that repo into a 404 and regresses a repo
the operator was already tracking before they installed the App. The cost is that a
stale `repos_json` silently keeps a newly-granted repo on the env token until the
install flow re-runs; #17's webhooks are the real fix.

### [5.3] Boot refuses to start when an App is registered and the key is missing

Not "warn and fall back." A registered App whose private key cannot be decrypted,
silently reverting to `GITHUB_TOKEN`, is precisely the failure mode this ticket
exists to prevent. `openInstallationStore()` throws. No App and no key is still a
clean boot — that is the documented local path.

### [5.5] A redirect target must flush its own snapshot

`snapshotMiddleware` skips `GET`/`HEAD` so a board poll never costs an upload. That
guard encodes "GETs do not write irreplaceable state" — true of every route until
this one. GitHub's `redirect_url` and `setup_url` are GETs *it* chooses, and they
write the private key. The routes flush for themselves; a failed upload logs and
redirects anyway, because the row is committed locally and stays dirty for the next
mutating request to retry. Failing an operator's install over a transient GCS error
is worse than a stale snapshot.

### [5.4] ADR-0006 [5] was factually wrong about `?org=` — corrected

The ADR (and #2's acceptance criteria, and `BUILD_PLAN-v2`) said the manifest form
POSTs to `github.com/settings/apps/new` with "an optional `?org=<org>`" to choose
org ownership. **No such parameter exists.** Ownership is chosen by the path:

| Owner | Form action |
|---|---|
| Personal | `https://github.com/settings/apps/new?state=<state>` |
| Organization | `https://github.com/organizations/<org>/settings/apps/new?state=<state>` |

`state` is the only query parameter, on either path. Two further corrections found
the same way, both now in ADR-0006 [5] and the ticket:

- `POST /app-manifests/{code}/conversions` types `webhook_secret` as **nullable**.
  Dispatch must tolerate a null, not assume a string.
- The code is documented valid for **one hour**; single use is *never stated*. So
  `/api/github/callback` enforces one-shot exchange itself rather than trusting
  GitHub to reject a replay. This became a new acceptance criterion.

Method: the seven permission keys were read out of the `app-permissions` schema in
GitHub's OpenAPI description, and cross-checked against the live `permissions`
object of three real Apps (`gh api /apps/dependabot` and friends). `workflows`
accepts only `write` — there is no `read`. This is the
[[verify-generated-formats-against-real-data]] rule paying for itself: three of the
ADR's claims about an external format were wrong, and all three would have compiled.

## [6] Outcomes

Branch `feat/2-github-app-manifest-install-flow`, eight commits.

| Commit | What landed |
|---|---|
| `3aa5e58` | `lib/crypto.ts` — AES-256-GCM envelope, `DISPATCH_ENCRYPTION_KEY` |
| `42a519a` | `db/installations.ts` — `SqliteInstallationStore`, the first confidential table |
| `20f4025` | ADR-0006 [5] corrected — no `?org=`, nullable `webhook_secret`, code not single-use |
| `50f3e55` | `routes/github-app.ts` — manifest + one-shot conversion callback |
| `2d2ca1d` | install callback + `setInstallationStore()` at boot |
| `a68a45f` | `GitHubAppSetup` — register/install UI |
| `99aa574` | `DEPLOY.md` §1.1 + §4.1; stale `#2` comment → `#21` |

433 tests pass (from 348 at session start), typecheck and seam guard clean, SPA
builds. Load-bearing behavior was mutation-checked, not just asserted: dropping the
selection guard, the `registerSecret` call, any of the three `onChange` sites, the
state consumption, or the `?org=` guard each turns the suite red.

Verified live, beyond the suite:

- All four boot paths driven against the real server — local-dev boots; registration
  is refused without a key; App + key boots and names the app; App without its key
  exits 1 with no PEM in the log.
- All three UI states driven in a real browser (`agent-browser`).

11 of 13 acceptance criteria met. The two that are not are AC 6 and AC 13, which
need an App on a real account — moved to **#22**, not quietly dropped.

## [7] Follow-ups

- **#22 (filed, `hitl: true`, blocks nothing but matters most)** — live-verify the
  App path. ADR-0006 [8]'s central claim, that a PR opened with an App installation
  token triggers `pull_request` runs without approval, is still **inferred, not
  observed**. #4 and #5 are shaped around it. #2 registers the first App; the check
  is fifteen minutes once one exists.
- **`GITHUB_TOKEN` is still required even with an App installed.** The rate-limit
  probe, the health route, and `discoverRepos()` are account-level calls with no
  installation to resolve against. That is **#21**, and `DEPLOY.md` §3.5 now says so
  plainly rather than implying onboarding is PAT-free today.
- **`repos_json` goes stale** when the operator edits the repo selection on
  github.com. Those repos silently keep using the env token until the install flow
  re-runs. #17's webhooks are the real fix; see [5.2].
- **Webhook declared but `active: false`.** Nothing verifies signatures until #17.
- A `selected` installation beyond 1000 repos is not fully enumerated; it warns.
- **`snapshotMiddleware`'s method guard is a latent trap.** Fixed at the two call
  sites this session introduced ([5.5]); the *class* of bug survives for the next
  redirect-target route. Candidate ticket — see [[oauth-callbacks-are-gets-that-write]].
- **The App path has never been exercised end to end against real GitHub.** #22.

## [8] Documentation

- `docs/decisions/0006-…md` — dated correction appended to [5]: the `?org=`
  parameter does not exist, `webhook_secret` is nullable, the manifest code is not
  documented single-use. Original claim left standing, not rewritten.
- `DEPLOY.md` — new §1.1 (`DISPATCH_ENCRYPTION_KEY`, and why losing it stops the
  boot) and §4.1 (lifecycle rule expiring noncurrent object versions, AC 10). §3.5
  rewritten to lead with the App and to state the `GITHUB_TOKEN` caveat.
- `docs/implementation-notes.md` — dated entry: the three wrong format claims and
  how they were caught, the leak the mutation pass surfaced, and the two deliberate
  fallback decisions.
- `server/db/schema.sql` — the design comment gains a third axis. It reasoned about
  disposable vs irreplaceable; `github_app` and `installations` are the first tables
  that are **confidential**.

- `docs/learnings/verify-external-formats-before-encoding-them.md` (LRN) — the three
  wrong ADR claims, how each was caught, and the rule: an ADR is authoritative about
  *why we chose this*, never about someone else's wire format.
- `docs/learnings/oauth-callbacks-are-gets-that-write.md` (LRN) — the durability bug
  in [4.4], and the general question to ask of any new write path.
- `docs/ARCHITECTURE.md` — §5 no longer claims the App path is unwired; §6 gains the
  confidential axis (and sheds pre-existing drift: `etag_map_json` was dropped by
  T0-9, `http_cache`/`summary_cache`/`spend` were missing); §11 documents the four
  `/api/github` routes; §14 no longer says "env-only secrets."
- `docs/BUILD_PLAN-v2.md` — Tier 1 status refreshed (8/10), #22 inserted ahead of
  T1-3 in the sequencing graph, T1-0's spike recorded as *half*-settled.

**Still to document:** nothing blocking. ADR-0006 [8] gets its evidence from #22.
