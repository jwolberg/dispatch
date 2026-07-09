---
id: 16
title: "Real multi-user auth (OIDC)"
status: open
priority: high
horizon: next
hitl: true
type: security
source: docs/BUILD_PLAN-v2.md
created: 2026-07-09
updated: 2026-07-09
prs: []
refs:
  - "docs/BUILD_PLAN-v2.md"
  - "T2-6"
  - "server/lib/auth.ts"
depends_on: []
acceptance:
  - "OIDC login replaces HTTP Basic for the deployed path, with a users table and per-repo ACLs"
  - "DISPATCH_PASSWORD continues to work for the localhost path"
  - "Every API route enforces authorization server-side; hiding UI is not authorization"
  - "A user with no ACL entry for a repo cannot read its tickets or trigger its agent runs, and this is covered by tests on the deny path"
  - "Sessions expire, and logout invalidates them server-side"
  - "No token, secret, or session id is written to a log line"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

`DISPATCH_PASSWORD` is a shared password over HTTP Basic (`server/lib/auth.ts`),
deliberately simple, explicitly a gate meant to sit behind an IAM-authenticated
proxy. It is not multi-user.

Replacing it with OIDC plus a `users` table and per-repo ACLs is what makes
Dispatch a team product — and every local competitor structurally cannot follow,
because they are single-user desktop apps with no server. This is the ticket that
changes what Dispatch *is*.

## Acceptance criteria

- OIDC login + `users` table + per-repo ACLs on the deployed path.
- `DISPATCH_PASSWORD` retained for localhost.
- Server-side authorization on every route.
- Deny-path tests: no ACL → no read, no run trigger.
- Session expiry; server-side logout invalidation.
- Nothing sensitive logged.

## Design notes

Should be its own session. Do not start casually.

Blocks #17 (webhooks), which needs a public URL and therefore needs this to land
first.

## Action needed

**Human, before execution — two separate things:**

1. **Open decision** (`docs/BUILD_PLAN-v2.md §4`): which OIDC provider? GitHub is
   the obvious default — every user already has an account, and by #2 we are
   already asking for an App installation. Recommended, but confirm before
   building.
2. **Approval gate:** this changes the auth model, flagged as escalating-cost.
   Confirm explicitly; do not execute as a side effect of "work the plan."
