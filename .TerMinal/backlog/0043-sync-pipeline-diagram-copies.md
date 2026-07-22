---
id: 43
title: "Sync the in-app pipeline diagram + hero PNG with the docs copy"
status: in-progress
priority: low
horizon: now
hitl: false
type: docs
source: manual — drift found after #40/#42 edited only the docs copy
created: 2026-07-22
updated: 2026-07-22
prs:
  - "https://github.com/jwolberg/dispatch/pull/66"
refs:
  - "web/public/pipeline.html"
  - "docs/pipeline-architecture-diagram.html"
  - "docs/img/dispatch_arch.png"
depends_on: []
acceptance:
  - "web/public/pipeline.html (served by the Architecture page) matches docs/pipeline-architecture-diagram.html"
  - "docs/img/dispatch_arch.png reflects the current diagram (poller, TerMinal handoff via issue URL)"
agent_id: docs
agent_scope: global
agent_kind: classic
---

## Description

The pipeline diagram exists in two copies: `docs/pipeline-architecture-diagram.html`
and `web/public/pipeline.html` (the one the in-app Architecture page serves at
`/pipeline.html`). #40 and #42 edited only the docs copy — webhook→poller, the
Local TerMinal box, the handoff edge, and the issue-URL handoff text — so the
**in-app diagram silently went stale**. The hero PNG (`docs/img/dispatch_arch.png`)
was likewise a render of the pre-edit diagram.

This brings `web/public/pipeline.html` back in sync with the docs copy and
re-exports the PNG from the current diagram. The two HTML files are now identical
and the PNG matches both.

## Design notes

Root cause: nothing guards the two HTML copies against drift — the sync is by a
comment in `Architecture.tsx` and human discipline. Worth a `check:diagram` step
(diff the two files, fail if they differ) so a future edit to one can't silently
leave the other stale. Filed as out-of-scope below rather than built here.

## Out of scope

- A `check:diagram` guard in `npm run verify`. Recommended follow-up — it is what
  would have caught this. File separately.
- Collapsing the two copies into one source. The app serves from `web/public/`
  and the docs link to `docs/`; a single source with a build-time copy would also
  work, but that is a bigger change than this sync.
