---
id: 38
title: "Hand a Dispatch ticket off to a local TerMinal session"
status: closed
priority: medium
horizon: now
hitl: false
type: feature
source: manual
created: 2026-07-22
updated: 2026-07-22
prs: []
refs:
  - "server/routes/tickets.ts"
  - "web/src/pages/CardDetail.tsx"
  - "~/.config/TerMinal/automation-inbox"
depends_on: []
acceptance:
  - "POST /api/tickets/:id/handoff returns a ready-to-run pickup command naming the repo path and issue number"
  - "The spec-chat transcript, when one exists, is posted to the issue as a single comment carrying a machine-readable marker"
  - "Calling handoff twice does not post the transcript twice — the marker is detected in the issue's existing comments and the second call reports it as already present"
  - "A ticket with no chat_id hands off successfully and reports that there was no transcript to carry"
  - "scripts/terminal-pickup.sh enqueues a file-ticket request into the TerMinal automation inbox with repoRoot set to the directory it was run from"
  - "The pickup script never receives issue text through a shell string — it fetches from the provider itself, so backticks and $ in an issue body cannot execute"
  - "The laptop never needs Dispatch credentials: the pickup path talks only to GitHub"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

A ticket filed from Dispatch (often from a phone, away from the desk) needs to
become real work in a local TerMinal session later. Today there is no path: you
retype the repo, find the issue, and re-derive the context by hand.

The transfer is smaller than it looks. Dispatch's `tickets` row is only
`(repo_id, chat_id, issue_number, created_at)` — title, body, labels, PR, and
checks all live on the provider and are re-derived into `status_cache` every
poll. The only artifact that exists *solely* in Dispatch is the spec-chat
transcript (`chats.transcript_json`), which never reaches the issue.

So the handoff is: push the transcript to the issue (making it derivable by any
client), then hand the human a short command that a local script turns into a
TerMinal backlog ticket.

## Design notes

**GitHub is the bus; the laptop never talks to Dispatch.** Cloud Run cannot
reach a laptop behind NAT, and a poller would need Dispatch credentials stored
locally plus a daemon whose silent failure is invisible. Instead the human
carries one command across, and the pickup script reads the issue from the
provider it already has `gh` auth for. Dispatch holds no queue and gains no new
state.

**Idempotency without new storage.** The transcript comment carries a hidden
marker (`<!-- dispatch:spec-transcript -->`). A second handoff calls `getIssue`,
finds the marker among existing comments, and skips the post. This follows the
prior about not storing what can be derived from the system of record — the
issue itself records whether the transcript was already carried.

**Issue text never crosses a shell boundary.** The pickup command carries only
`owner/repo#N`; the script fetches title and body itself and builds the inbox
envelope with `jq`. Rendering a markdown body into a copy-pasteable shell string
would let backticks and `$(...)` in an issue body execute on the laptop.

**`repoRoot` comes from `$PWD`, not from Dispatch.** Dispatch cannot know where
a repo is cloned locally, and adding a `repos.local_path` column would need a
repo-edit endpoint that does not exist yet (settings are write-once at track
time). Running the pickup from inside the clone is the smaller answer; revisit
if it chafes.

## Out of scope

- A local poller that ingests tickets automatically before you sit down. The
  envelope is shaped so one could consume it later without redesign.
- Starting a session or an agent on arrival — this files an `open` ticket and
  stops there.
- Any Claude-artifact rendering of the ticket. An artifact would be a third
  copy of data GitHub already holds authoritatively, stale on the first state
  change, and it cannot trigger anything locally.
