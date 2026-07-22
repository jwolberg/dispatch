---
id: 39
title: "Rate-limit probe logs a dead credential once, not every tick"
status: in-progress
priority: medium
horizon: now
hitl: false
type: dx
source: production logs, 2026-07-22
created: 2026-07-22
updated: 2026-07-22
prs: []
refs:
  - "server/poller/scheduler.ts:55"
  - "server/providers/index.ts"
depends_on: []
acceptance:
  - "A credential that keeps failing the same way logs once, not once per poll cycle"
  - "The warning names which credential failed, so a multi-credential deployment can tell the PAT from an App account"
  - "A credential that starts failing differently logs again — a new failure mode is news"
  - "Recovery is logged once when a previously failing credential succeeds again"
  - "A healthy credential alongside a failing one still feeds the gauge; one bad credential never suppresses measurement"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Production emitted 353 identical `[poller] rate-limit check failed: Bad
credentials` lines in six hours — one per poll cycle, forever, for a PAT that is
expired. The noise buries real signal in the logs and makes the service look
broken when it isn't: the same six hours show 429 successful conditional
requests against the tracked repo via the GitHub App.

Two defects compound. The message repeats indefinitely, and it does not say
*which* credential failed. Since #21 a deployment can hold several — a PAT plus
one App installation per account — so "Bad credentials" alone does not identify
what to go fix.

## Design notes

Log on transition, not on state. Track the last failure message per credential;
warn when it changes (including first occurrence) and stay silent while it
repeats. Log once on recovery so the resolution is visible.

Keying on the *message* rather than a boolean means a credential that starts
failing a new way still reports. The risk is a message carrying a varying
substring (a request id, a timestamp) which would defeat suppression — the
current provider errors are stable, and that is worth a comment rather than a
sanitizer.

`AccountProvider.label` is already documented as safe to render (an account
login, or the env var's name), so naming the credential in the log leaks
nothing.

## Out of scope

- Rotating or removing the dead PAT in production. Deliberately left in place —
  this ticket is about the logging, and the operator chose to keep the
  credential attached.
- Surfacing credential health in the UI.
