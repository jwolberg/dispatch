---
id: 0007
title: A ticket handoff travels through the issue, not through Dispatch
anchor: ADR-0007
status: accepted
date: 2026-07-22
supersedes:
superseded-by:
---

Taken on #38, 2026-07-22. Records why "send this ticket to my laptop" ships as a
transcript comment plus a copied command rather than a queue, a daemon, or a
published artifact.

## [1] Context

A ticket filed from Dispatch — often from a phone, away from the desk — needs to
become real work in a local TerMinal session later. The obvious framing is that
Dispatch holds a ticket and must transfer it somewhere.

That framing is wrong, and the schema says so. The `tickets` row is
`(repo_id, chat_id, issue_number, created_at)`. Title, body, labels, PR linkage
and check state are all re-derived from the provider into `status_cache` on every
poll and are never authoritative (§6/§7). Dispatch is a projection of the issue.

Exactly one artifact exists *solely* in Dispatch: the spec-chat transcript in
`chats.transcript_json`. It never reaches the issue. Everything else a laptop
could want, the laptop can already fetch itself.

The second constraint is the network. Dispatch runs on Cloud Run; a laptop sits
behind NAT. The server cannot push to it. Transfer is therefore either a pull on
a cadence or a carry by hand.

## [2] Decision

`POST /api/tickets/:id/handoff` posts the spec-chat transcript to the issue as a
single marked comment, then returns `dispatch-pickup <repo>#<n>`.
`scripts/terminal-pickup.sh`, run inside the local clone, reads the issue from
the provider and enqueues a `file-ticket` request into TerMinal's automation
inbox.

**The provider is the bus. The laptop never calls Dispatch**, holds no Dispatch
credential, and works when Dispatch is down.

Idempotency lives on the issue: the comment opens with
`<!-- dispatch:spec-transcript -->`, and a repeat handoff calls `getIssue` and
skips when it finds it. No `handed_off` column exists, consistent with the
project rule of storing only what cannot be derived from the system of record.

## [3] Alternatives rejected

**A local poller** ("already queued when I arrive"). Needs a daemon on the
laptop, Dispatch credentials stored there, and queue state in Dispatch. Its
failure mode is silence — indistinguishable from "nothing was sent" — which is
the worst property an absent-operator mechanism can have. The envelope is shaped
so a poller could consume it unchanged if this is ever wanted.

**A published Claude artifact.** Proposed at the outset. It would be a third
copy of data the provider already holds authoritatively, stale from the first
state change, and it cannot trigger anything locally — something on the laptop
would still have to pick it up. An artifact is a display surface, not a bus.

**Embedding the issue body in the pickup command.** Rejected on safety, not
elegance: a body containing backticks or `$(...)` would execute on the laptop
when pasted. The command carries coordinates only, and the script builds its
envelope in `jq`, so issue text is never a shell word.

## [4] Costs, stated plainly

- **The transcript becomes public to anyone with repo access.** It is posted to
  the issue. That is the point — it makes the transcript derivable everywhere —
  but it is a real disclosure of a conversation that was previously private to
  the Dispatch instance, and pressing the button is the moment it happens.
- **The human is the transport.** Nothing arrives before you sit down. This is a
  deliberate trade against the daemon, not an oversight.
- **`repoRoot` comes from `$PWD`.** Dispatch cannot know where a repo is cloned,
  and a `repos.local_path` column would need a repo-edit endpoint that does not
  exist — repo settings are write-once at track time. Running the script from
  inside the clone is the smaller answer.
- **One coupling to the issue-body format.** The script strips the `@claude`
  trailer using the separator `issueBody()` writes (`server/providers/prompt.ts`).
  Change that wording and the trailer starts leaking into local tickets.

## [5] Relationship to ADR-0004

Same shape, same instinct: given a choice between performing a write on the
user's behalf and handing the user a link to finish themselves, prefer the link.
ADR-0004 declined to call `revertPullRequest`; this declines to run a queue and a
daemon. The difference is that this one does perform one write — the transcript
comment — because that write is what makes the handoff need no infrastructure at
all.

## [6] Update — the last mile is the issue URL, not the inbox (2026-07-22)

The delivery in [2] — `scripts/terminal-pickup.sh` enqueuing a `file-ticket`
envelope into TerMinal's automation inbox — was exercised end-to-end the same
day and **the TerMinal watcher never drained `new/`**. A canonical
`automation.requested` envelope with a harmless action did not move either, so it
is not our envelope: the app-side watcher does not consume the queue on this
build, and (new constraint) TerMinal's app code will not change.

So the delivery is replaced, not the decision. The transcript push and its
marker (§[2]) are unchanged, which means the **issue URL is already a complete,
per-user-authenticated record**. `POST /api/tickets/:id/handoff` now returns that
URL and a paste-ready import prompt; you paste it into a Claude/Codex tab in
TerMinal and the agent files the backlog ticket from the issue via `gh`.

This makes the thesis *more* true, not less: the fragile hop (a queue plus a
watcher that had to work) is gone, and the only thing between Dispatch and a local
ticket is a URL plus the agent already running in TerMinal. The import prompt
embeds only the URL — never issue text — so the shell-safety property in §[3]
holds unchanged. `scripts/terminal-pickup.sh` is removed rather than left
pointing at a queue that never drains. See #42.
