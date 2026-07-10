---
id: 2
title: "GitHub App: manifest registration + OAuth install flow"
status: in-progress
priority: high
horizon: now
hitl: false
type: feature
source: docs/BUILD_PLAN-v2.md
created: 2026-07-09
updated: 2026-07-09
prs:
  - "https://github.com/jwolberg/dispatch/pull/11"
refs:
  - "docs/BUILD_PLAN-v2.md"
  - "T1-1"
  - "ADR-0002"
  - "ADR-0006"
depends_on: [1]
acceptance:
  - "An operator can register their OWN GitHub App from the browser via the manifest flow, with no shell step and no App name or client id committed to this repo"
  - "The App name is an editable field on the setup screen, defaulted but not hardcoded; personal-vs-org ownership is chosen in GitHub's own UI, by POSTing the manifest to /settings/apps/new or /organizations/<org>/settings/apps/new (there is no ?org= parameter — corrected 2026-07-09, see ADR-0006 [5])"
  - "The conversion callback is one-shot: Dispatch rejects a replayed code itself, because GitHub documents the code as valid for an hour but never promises single use"
  - "An operator can install that App on one or more repos and land back in Dispatch with the installation recorded"
  - "Installation records (app id, installation id, account, repo selection) persist in SQLite and survive a container restart"
  - "server/index.ts calls setInstallationStore() with a SQLite-backed InstallationStore at boot — without this the seam #3 landed stays dead code and AppTokenSource is never constructed in production"
  - "An end-to-end check proves a tracked repo under an installation polls using a minted installation token, not GITHUB_TOKEN — the App path is verified live, not only by unit tests (MOVED to #22: needs an App on a real account, which only the operator can register)"
  - "The App private key is persisted in SQLite (not env, not Secret Manager) and encrypted at rest under a key supplied via env; the ciphertext is what reaches the GCS snapshot"
  - "redaction.ts is inverted to value-registration: a secret registers its value with the redactor when loaded, so safeMessage() redacts secrets that live in SQLite and never in process.env"
  - "A test asserts that a private key stored in SQLite does not appear in the output of safeMessage() for an error that embeds it"
  - "DEPLOY.md documents a lifecycle rule expiring noncurrent object versions, because bucket versioning otherwise preserves a rotated key indefinitely"
  - "GITHUB_TOKEN continues to work as the local-development path with no App installed"
  - "Integration test covers the callback handler: valid code, replayed code, and mismatched state each behave correctly"
  - "Once the App exists, a PR is opened with its installation token in a scratch repo and the resulting workflow_run is recorded in ADR-0006 [8], closing the inference flagged there and in ADR-0002 [5] (MOVED to #22)"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Onboarding today requires minting a fine-grained PAT with an exact scope matrix.
That is the terminal we removed from the main loop, still sitting in the setup
step. A GitHub App registered via the manifest flow lets a user click through
registration and installation entirely in the browser.

This ticket lands registration and installation only. Credential *resolution*
— actually using installation tokens to make API calls — is #3, deliberately
separated so the risky refactor lands in two reviewable pieces.

**Dispatch is a public repo that anyone deploys for themselves, so there is no
central Dispatch App** (ADR-0006 [5]). Each operator registers their own at first
run. The App's name and owning account are inputs on the setup screen, not
constants in this repository.

## Acceptance criteria

See frontmatter. The three that are new since ADR-0006, and the reason this
ticket is no longer `hitl`:

- Registration is **per deployment**. Nothing about the App is committed here, so
  there is no "which org owns it" decision for a human to make up front — it is a
  field the operator fills in, about their own account.
- The private key is **runtime state**, not boot state. It arrives in the manifest
  callback, so it must be written, encrypted, and kept out of logs. See below.
- The first App that exists is the instrument that closes ADR-0002 [5]'s open
  inference. Use it.

## Design notes

Nothing outside `server/providers/` should learn what an installation is. Land
the storage and the flow; leave the memo-key change to #3.

**The private key is the whole risk in this ticket** (ADR-0006 [6]). Three traps,
all of which are live in `main` today:

1. **`redaction.ts` will not redact it.** `redactSecrets()` iterates a hardcoded
   `SECRET_ENV_KEYS` and pulls each value from `process.env`. A key in SQLite is
   never in `process.env`, so `safeMessage()` returns it verbatim into a log line
   or an error body. Invert the redactor to value-registration **before** storing
   a key. This is a prerequisite, not a follow-up.
2. **`snapshot.ts` uploads the whole database, unencrypted.** `VACUUM INTO` then
   `POST` the bytes. Encrypt the key column at rest, under a key from env, so the
   ciphertext is what leaves the process.
3. **Bucket versioning outlives key rotation.** `DEPLOY.md:126` enables versioning
   on purpose — a corrupt snapshot stays recoverable — which also means a rotated
   private key stays readable in an old object version forever. A lifecycle rule
   expiring noncurrent versions is the fix, and it belongs in `DEPLOY.md`.

Do **not** reach for GCP Secret Manager. It needs `roles/secretmanager.admin` on
the runtime SA (`DEPLOY.md` §4 grants only `storage.objectAdmin`) and couples a
deploy-anywhere tool to one cloud. ADR-0006 [6.1].

### Invalidating a memoized adapter when an installation changes

Raised by review of #3's seam (2026-07-09), and deliberately left to this ticket.

`providers/index.ts` memoizes one adapter — and therefore one `AppTokenSource`,
holding one `privateKey` — per `(provider, host, installationId)`, for the life of
the process. `setInstallationStore()` clears the whole cache, but nothing else
does.

So once this ticket lands a real SQLite-backed store: if an operator regenerates
the App's private key, or uninstalls and reinstalls the App, the memoized
`AppTokenSource` keeps minting against credentials that no longer exist. A 401
triggers exactly one re-mint (`github.ts`), and that re-mint uses the same stale
key, so the adapter fails permanently until the process restarts.

The store is the only thing that knows an installation changed. Decide how it
tells the factory — `resetProviderCache()` on any write to the installations table
is the crude, correct answer, and it is probably enough.

Depended on #1, which is closed: ADR-0002 settled the anti-recursion question and
ADR-0006 settled what it implies for scopes. The manifest requests
`pull_requests: write` because **Dispatch's server** opens PRs now (ADR-0006 [2]),
plus `contents: write` and `workflows: write` for #4's setup commits,
`issues: write`, `secrets: write`, `actions: read`, `metadata: read`.

## Action needed

None blocking. ADR-0006 [5] dissolved the approval gate that used to live here:
registration is the operator's own click, about the operator's own account, in
GitHub's UI. The escalating-cost action never leaves their hands.
