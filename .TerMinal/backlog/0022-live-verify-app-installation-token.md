---
id: 22
title: "Live-verify the App path: installation token polls, and its PR triggers a run"
status: in-progress
priority: high
horizon: now
hitl: true
type: chore
source: .TerMinal/sessions/0002-github-app-manifest-install-flow/session.md
created: 2026-07-09
updated: 2026-07-09
prs:
  - "https://github.com/jwolberg/dispatch/pull/15"
refs:
  - "docs/runbooks/register-github-app-locally.md"
  - "SES-0002"
  - "ADR-0006 [8]"
  - "ADR-0002 [5]"
  - "#2"
depends_on: [2]
acceptance:
  - "An operator registers a GitHub App on their own account through Repo Config → GitHub App, with no shell step"
  - "The App is installed on a scratch repo, and that repo's poll is observed using a minted installation token rather than GITHUB_TOKEN (#2 AC 6)"
  - "A pull request is opened with that installation token in the scratch repo, and the resulting workflow_run is recorded in ADR-0006 [8] (#2 AC 13)"
  - "ADR-0006 [8] and ADR-0002 [5] are updated: the arm moves from 'inferred, not observed' to observed, or the ADRs are amended if it turns out false"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

#2 built the whole App path and tested it against fakes. Two of its acceptance
criteria cannot be satisfied that way, because they require an App that actually
exists on GitHub, owned by the operator:

- **AC 6** — proof that a tracked repo under an installation polls with a minted
  installation token, not `GITHUB_TOKEN`.
- **AC 13** — the reason ADR-0006 exists at all.

## Why this is not busywork

ADR-0006 [8] is explicit that the central claim of the whole tier is **inferred,
not observed**:

> That a pull request opened by an *App installation token* triggers
> `pull_request` runs without approval. ADR-0002 [5] flagged this exact gap: what
> was observed was a fine-grained PAT, and GitHub's documentation treats the two
> identically for this purpose.

If the inference is wrong, #4 (`POST /api/repos/:id/setup`) and #5 (the canary) are
both shaped around a mechanism that does not work, and the `GH_PAT` that ADR-0006
deleted has to come back. #2 registers the first App — the moment one exists, this
is a fifteen-minute check that retires the largest unverified assumption in the
plan.

## Action needed

**Human.** Registering a GitHub App is the one genuinely escalating-cost click in
onboarding, and it is about the operator's own account. It never leaves their
hands (ADR-0006 [5]), which is exactly why an agent cannot do it.

**No deploy is required.** `redirect_url` and `setup_url` are browser redirects, not
server-to-server callbacks, and the manifest omits the webhook entirely on a
non-public host (GitHub rejects an unreachable `hook_attributes.url` even when
`active: false` — observed 2026-07-10).
The whole flow runs against `http://localhost:3001`.

Step-by-step: **[`docs/runbooks/register-github-app-locally.md`](../../docs/runbooks/register-github-app-locally.md)**.

Note on step 3: do *not* unset `GITHUB_TOKEN` — boot needs it for the account-level
calls (#21). Corrupt it instead. `/api/health` then reports bad credentials while a
repo under the installation keeps polling green, and nothing but an installation
token could have fetched it.

## Result — 2026-07-10, both criteria observed

The human registered App `dispatch-jay` (app id 4261376); installation 145573719
covers all of `jwolberg` (`repository_selection: all`).

**AC 6 — proven.** `scripts/verify-app-token.ts`. With `GITHUB_TOKEN` corrupted
in-process, `jwolberg/situation` fetched 16 workflow runs at rate-limit ceiling
**6950** (installation-scoped; a PAT is capped at 5000), while
`octocat/Hello-World` and the `env:GITHUB_TOKEN` account both failed
`Bad credentials`. The harness skips the conditional-request cache on purpose — a
replayed ETag would serve a cached 200 and fake the result.

**AC 13 — proven, the arm holds.** `scripts/verify-app-pr-triggers-run.ts` on
`jwolberg/cohort-bot`: a PR opened by the installation token created `pull_request`
run [29065952153](https://github.com/jwolberg/cohort-bot/actions/runs/29065952153)
— `status: completed`, `conclusion: success`, no approval gate, `actor` =
`triggering_actor` = `dispatch-jay[bot]`. #4 and #5 proceed as written; `GH_PAT`
stays deleted. The workflow was committed to the PR head only, so the scratch
repo's `main` was never modified; branch and PR were removed after.

**AC on ADRs — done.** ADR-0006 [8] and ADR-0002 [5] both moved from
"inferred, not observed" to observed, with the run linked.

Two defects surfaced while doing this, fixed in the same PR:

- The runbook's `echo … >> .env` was not idempotent. Run twice, `.env` held two
  `DISPATCH_ENCRYPTION_KEY` lines; `dotenv` takes the last, so the first became
  dead weight that decrypted nothing. Runbook now guards with `grep -q`, and
  `.env.example` documents the variable (it never did).
- `.gitignore` covered `.env` but not `.env.bak`/`.env.*`, so a routine backup of
  `.env` would have been a committable file full of live secrets.
