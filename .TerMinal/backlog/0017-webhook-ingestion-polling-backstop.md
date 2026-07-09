---
id: 17
title: "Webhook ingestion, polling retained as backstop"
status: open
priority: medium
horizon: next
hitl: false
type: feature
source: docs/BUILD_PLAN-v2.md
created: 2026-07-09
updated: 2026-07-09
prs: []
refs:
  - "docs/BUILD_PLAN-v2.md"
  - "T2-7"
  - "ARCHITECTURE.md"
depends_on: [16, 2]
acceptance:
  - "POST /api/webhooks/:provider verifies the HMAC signature and rejects unsigned or mis-signed payloads with 401, before any parsing"
  - "A verified payload calls reconcileTicket directly"
  - "The 5-minute poll is retained as a reconciliation backstop and is never the primary path"
  - "A replayed webhook delivery is idempotent — reconciling twice produces the same state"
  - "Signature verification is constant-time"
  - "Tests cover: valid signature, invalid signature, absent signature, and replay"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

`reconcileTicket` is already decoupled from the scheduler and documented as
webhook-ready (`ARCHITECTURE.md §15`). Add `POST /api/webhooks/:provider` with
HMAC verification, call `reconcileTicket` directly, and keep the 5-minute poll as
a reconciliation backstop.

## Acceptance criteria

- HMAC verified before parsing; unsigned/mis-signed → 401.
- Verified payload → direct `reconcileTicket` call.
- Poll retained as backstop, never primary.
- Replays are idempotent.
- Constant-time signature comparison.
- Tests: valid, invalid, absent, replay.

## Design notes

Depends on #16 because this requires a public URL, and on #2 because the App is
what delivers the webhook secret.

Keeping the poll is not belt-and-braces timidity — a dropped webhook delivery is
a normal event, and the poll is what makes a missed delivery cost five minutes
instead of forever. It stays.

Verify the signature *before* parsing the body, not after. Parsing attacker-
controlled JSON is already granting the attacker something.
