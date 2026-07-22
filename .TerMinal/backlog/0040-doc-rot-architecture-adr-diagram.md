---
id: 40
title: "Close the doc gap left by #37–#39, and the webhook box that was never built"
status: in-progress
priority: medium
horizon: now
hitl: false
type: docs
source: doc audit after #37/#38/#39 shipped
created: 2026-07-22
updated: 2026-07-22
prs: []
refs:
  - "docs/ARCHITECTURE.md"
  - "docs/decisions/0007-ticket-handoff-travels-through-the-issue.md"
  - "docs/pipeline-architecture-diagram.html"
depends_on: []
acceptance:
  - "ARCHITECTURE's backend-route table lists every mounted route, including POST /api/tickets/:id/handoff"
  - "The handoff is documented as a named flow alongside Steer and Ship"
  - "An ADR records why the handoff travels through the issue, with the rejected alternatives and the disclosure cost"
  - "The pipeline diagram no longer shows a webhook receiver that does not exist"
  - "The diagram shows the handoff exit path, drawn from the issue rather than from the backend"
  - "The rendered diagram is visually verified, not just hand-edited"
  - "Tickets #37, #38 and #39 read closed with their merged PR urls scrubbed"
agent_id: docs
agent_scope: global
agent_kind: classic
---

## Description

Auditing after #37–#39 merged turned up more drift than those tickets caused.

**Caused by #38:** the backend-route table in `ARCHITECTURE.md` gained no entry
for `POST /api/tickets/:id/handoff`, and the handoff was not documented as a
flow next to Steer and Ship. The design reasoning — provider as the bus, no
poller, no artifact, laptop never calls Dispatch — lived only in a ticket and
implementation notes, which is the hardest place to find it later.

**Pre-existing, found while looking:** the route table was already missing seven
routes that shipped in T1/T2 (`summary`, `diff`, `review`, `cost`,
`revert-url`, `skill`, `repos/:id/setup`). And `pipeline-architecture-diagram.html`
draws a **webhook receiver** in the backend box. No webhook router is mounted;
the App manifest registers `/api/webhooks/github` with `active: false`; ticket
#17 is still open; the README says polling. The diagram has been showing a
planned state as though it were built.

## Design notes

The ADR is numbered 0007 and deliberately cross-references ADR-0004 — same
shape of decision (hand the user a link rather than perform the write), and the
pair is more useful than either alone. It states the disclosure cost plainly:
pressing the button publishes a previously-private chat transcript to the issue.

The diagram's new edge is drawn **from the issue**, not from the backend. A
backend → laptop arrow would assert a connection that ADR-0007 explicitly says
does not exist — exactly the failure mode the webhook box represents.

## Out of scope

- `docs/img/dispatch_arch.png` (README hero). It is a binary with no source
  file — no `.mmd`, `.drawio`, or `.excalidraw` anywhere in the repo — so it
  cannot be updated without redrawing it blind. Filed as a follow-up instead.
- `DEPLOY.local.md`, which is git-excluded and personal to one deployment.
- Ticket #17 itself. This corrects the diagram to match reality; it does not
  decide whether webhooks should be built.
