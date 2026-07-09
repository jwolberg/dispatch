---
id: 4
title: "POST /api/repos/:id/setup — write workflows + secrets via API"
status: open
priority: high
horizon: now
hitl: true
type: feature
source: docs/BUILD_PLAN-v2.md
created: 2026-07-09
updated: 2026-07-09
prs: []
refs:
  - "docs/BUILD_PLAN-v2.md"
  - "T1-3"
  - "scripts/install-claude-action.sh"
  - "ADR-0002"
depends_on: [3]
acceptance:
  - "One POST commits .github/workflows/claude.yml, a stack-aware ci.yml from scripts/repo-ci/, and the plan/implement/debug skills from scripts/repo-skills/ into the target repo"
  - "The Claude auth secret is set via the Secrets API using libsodium sealed-box encryption"
  - "When installing in OAuth mode, any existing ANTHROPIC_API_KEY repo secret is deleted"
  - "OAuth-token-preferred behavior from install-claude-action.sh is preserved"
  - "Re-running setup on an already-configured repo is idempotent and does not duplicate commits"
  - "Templates are embedded at build time; scripts/repo-ci/ and scripts/repo-skills/ remain the single source"
  - "Setup runs end-to-end from the browser with no shell step"
  - "No secret value is logged, returned in a response body, or written to an artifact"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

`scripts/install-claude-action.sh` is 250 lines of bash that already knows
everything onboarding needs to do. Porting it into TypeScript behind one endpoint
is what makes "no terminal" true from first click.

The endpoint commits the Claude workflow, a stack-aware CI workflow, and the
`plan`/`implement`/`debug` skills into the target repo, and sets the Claude auth
secret.

## Acceptance criteria

- One `POST /api/repos/:id/setup` commits `.github/workflows/claude.yml`, a
  stack-aware `ci.yml` from `scripts/repo-ci/`, and the skills from
  `scripts/repo-skills/`.
- Claude auth secret set through the Secrets API with libsodium sealed-box
  encryption.
- In OAuth mode, an existing `ANTHROPIC_API_KEY` repo secret is **deleted**.
- OAuth-token-preferred behavior preserved.
- Idempotent on re-run.
- Templates embedded at build time from their existing locations.
- Whole flow runs from the browser.
- No secret is ever logged or returned.

## Design notes

The sealed-box encryption is the one genuinely fiddly part; everything else is a
transliteration of the bash.

**Credential shape changed by ADR-0002.** `GH_PAT` leaves onboarding, but it is
replaced by `APP_CLIENT_ID` (a repo variable) + `APP_PRIVATE_KEY` (a repo
secret), which `actions/create-github-app-token` uses to mint an installation
token inside the workflow. Before implementing, settle the tradeoff recorded in
ADR-0002 [4]: an App private key mints tokens for *every* installation of the
App, so writing it into each user repo inverts the blast radius versus a
per-repo fine-grained PAT. Two alternatives are costed there and neither has
been chosen. **This is an approval gate, not an implementation detail.**

**Also from ADR-0002 [3.1]:** setup should detect
`can_approve_pull_request_reviews` on the target repo. With it off, a
`GITHUB_TOKEN`-authored PR 403s at creation. An App installation token is
unaffected by that toggle, so the App path sidesteps it — but the canary (#5)
must still report the condition clearly if a repo lands in that state.

The `ANTHROPIC_API_KEY` deletion is not a nicety. Per `docs/implementation-notes.md`
(2026-06-12): the API key outranks the OAuth token in Claude's auth precedence,
so leaving it in place silently keeps billing the metered API. Cover it with a
test.

## Action needed

**Human, before execution:** this endpoint writes workflow files and secrets into
a user's repository — an escalating-cost, outward-facing action flagged in
`docs/BUILD_PLAN-v2.md §4` for explicit approval. Confirm before executing, and
confirm the scratch repo used for testing. Do not run against a real user repo
during development.
