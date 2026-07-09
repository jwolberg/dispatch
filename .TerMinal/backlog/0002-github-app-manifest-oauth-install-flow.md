---
id: 2
title: "GitHub App: manifest registration + OAuth install flow"
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
  - "T1-1"
depends_on: [1]
acceptance:
  - "A user can register the Dispatch GitHub App from the browser via the manifest flow, with no shell step"
  - "A user can install that App on one or more repos and land back in Dispatch with the installation recorded"
  - "Installation records (app id, installation id, account, repo selection) persist in SQLite and survive a container restart"
  - "The App private key is read from env or secret manager, never committed and never logged"
  - "GITHUB_TOKEN continues to work as the local-development path with no App installed"
  - "Integration test covers the callback handler: valid code, replayed code, and mismatched state each behave correctly"
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

## Acceptance criteria

- Manifest-based App registration completes in the browser, no shell.
- App installation on selected repos returns the user to Dispatch with the
  installation persisted.
- Installation records survive a restart (SQLite, not in-process).
- Private key sourced from env/secret manager; never committed, never logged.
- `GITHUB_TOKEN` still works with no App installed (local path, and all of
  GitLab).
- Integration tests on the OAuth callback: happy path, replayed code, bad
  `state`.

## Design notes

Nothing outside `server/providers/` should learn what an installation is. Land
the storage and the flow; leave the memo-key change to #3.

Depends on #1 — the spike determines whether this App also removes `GH_PAT` from
onboarding, which changes what scopes we request in the manifest.

## Action needed

**Human, before execution:** registering an external GitHub App is an
escalating-cost action (per `docs/BUILD_PLAN-v2.md §4` it is flagged for explicit
approval). The human must decide the App's owning account/org and name, then
complete the browser registration and supply the resulting App ID, private key,
and webhook secret. Do not execute this ticket as a side effect of "work the
plan."
