---
id: 42
title: "Handoff delivers a GitHub issue URL to import, not a TerMinal inbox envelope"
status: in-progress
priority: medium
horizon: now
hitl: false
type: feature
source: manual — the TerMinal inbox watcher does not drain (verified 2026-07-22)
created: 2026-07-22
updated: 2026-07-22
prs: []
refs:
  - "server/lib/handoff.ts"
  - "server/routes/tickets.ts"
  - "docs/decisions/0007-ticket-handoff-travels-through-the-issue.md"
depends_on: []
acceptance:
  - "POST /api/tickets/:id/handoff returns the issue URL and a ready-to-paste import prompt embedding it"
  - "The transcript push and its idempotency marker are unchanged — the issue stays the complete artifact"
  - "A ticket with no chat still returns the issue URL and import prompt (no transcript to carry is not an error)"
  - "The response no longer references the TerMinal automation inbox or a pickup command"
  - "scripts/terminal-pickup.sh (the dead inbox path) is removed, not left pointing at a watcher that never drains"
  - "ADR-0007, README, ARCHITECTURE, and the pipeline diagram describe the issue-URL transport"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

The #38 handoff delivered the ticket through TerMinal's automation inbox
(`terminal-cli inbox enqueue`). Running it end-to-end on 2026-07-22 proved the
Dispatch half works but the **TerMinal watcher never drains `new/`** — the
envelope sat untouched, and even a canonical `automation.requested` envelope with
a harmless action did not move. Under the new constraint that TerMinal's app code
will not change, that path is permanently dead.

Pivot to the transport that needs no TerMinal receiver at all: the handoff
already pushes the spec-chat transcript onto the issue, so the **issue URL is a
complete, per-user-authenticated artifact**. The button hands you that URL (and a
paste-ready import prompt); you paste it into a Claude/Codex tab in TerMinal and
the agent files a `.TerMinal/backlog` ticket from it via `gh`. Nothing on the
TerMinal side has to change, and Dispatch hosts nothing new.

## Design notes

This is a refinement of ADR-0007's last mile, not a reversal of it. The thesis —
the provider is the bus, the one write is the transcript, idempotency lives on
the issue — is unchanged and in fact *more* true now: the fragile hop (the inbox)
is gone, and the only thing between Dispatch and a local ticket is a URL plus the
agent that is already running in TerMinal.

The route must fetch the issue up front so every path (including no-transcript)
can return the canonical `issue.url`. One `getIssue` per handoff — a button
press, not a hot path.

The import prompt names the URL, tells the agent to read via `gh`, strip the
`@claude` implementation trailer Dispatch appends, infer type from labels, and
file with `/ticket`. No issue text is embedded in a shell string anywhere — the
agent fetches it itself, same safety property as before.

## Out of scope

- A dedicated `/import-dispatch-ticket` Claude skill for one-word imports. The
  paste-ready prompt is self-contained; a skill is a nicety, filed separately if
  wanted.
- A deterministic non-agent importer script. If wanted later it writes the
  backlog file directly — never the inbox.
- Fixing the TerMinal inbox watcher. That is TerMinal-side and explicitly frozen.
