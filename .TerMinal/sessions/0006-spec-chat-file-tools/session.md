---
id: 6
slug: spec-chat-file-tools
anchor: SES-0006
title: "#27 — Give spec-chat repo-file access (read_file / list_files tools)"
status: closed
started: 2026-07-11T21:20:00Z
ended: 2026-07-11T22:05:00Z
goal: "Give spec-chat repo-file access (#27): add read_file and list_files tools so the spec-refinement chat can ground tickets in the actual repo contents instead of only the cached tree/CLAUDE.md"
tickets: [27]
branches:
  - feat/27-spec-chat-file-tools
prs:
  - "https://github.com/jwolberg/dispatch/pull/38"
related_research: []
related_docs:
  - docs/BUILD_PLAN-v2.md
prior_sessions: [5]
---

## [1] Goal

Fix **#27** (feature, high/now). Spec-chat can name files it cannot read:
`buildSystemPrompt` injects only description + CLAUDE.md + a README excerpt + a
**depth-2, names-only** file tree, and `streamMessage`/`createMessage` never pass
`tools` — so the model has no mechanism to ask for more. Every spec is written by
a model that has read filenames and nothing else.

**Done** = the model gets two tools — `read_file(path)` and `list_files(path)` —
and pulls what it needs through the provider seam, inside a bounded, **secure**
tool-use loop. The load-bearing constraint is security: chat transcripts persist
to `chats`, which triggers a **GCS snapshot upload**, so a single bad `read_file`
of `.env` writes credentials into a durable, versioned bucket. Denylist +
`redactSecrets()` on every tool result, proven by a test asserting the secret
value appears nowhere.

## [2] Context & pointers

### [2.1] Ticket in scope

**#27 — spec-chat read_file/list_files** (`open` → in-progress, high/now, no
deps). Acceptance criteria (verbatim in ticket) — the security + loop-bound ones
are the sharp edges:

- `RepoProvider` exposes `readFile(repo, path)` + `listFiles(repo, path)`; both
  adapters implement them; a fake proves the seam.
- `streamMessage`/`createMessage` accept `tools` + a `runTool` callback and loop
  while `stop_reason === "tool_use"`. `createMessage` must **stop silently
  dropping non-text blocks** (today it filters to TextBlock only → a tool_use
  block vanishes and it returns "").
- A spec chat asked about a visible file fetches its contents and answers from
  them (route test, stubbed provider).
- `read_file` on a denylisted path (`.env`, `.env.local`, `deploy.pem`, `id_rsa`,
  `credentials.json`) returns a **refusal, never contents** — test asserts the
  secret appears in none of: tool result, transcript, persisted `chats` row.
- `redactSecrets()` applied to **every** tool result before model or DB.
- A turn is capped at **8 tool-use iterations and 10 file reads**; exceeding
  either ends the loop with a model-visible message; a test proves an adversarial
  loop terminates.
- Files over the cap (~64 KB) truncated with an explicit marker.
- `read_file` rejects absolute paths and any `..` segment.
- `npm run verify` green, seam guard included.

### [2.2] The seam (verified this session)

- **Providers already fetch file text, privately** — `github.ts:231`
  `fetchFileText(owner, repo, path)`, `gitlab.ts:137` `fetchFile(id, path, ref)`.
  They're absent from `RepoProvider` (`types.ts` has no `readFile`/`listFiles`).
  `scripts/check-seam.sh` forbids `@octokit`/`@gitbeaker` outside
  `server/providers/`, so the tool executor MUST go through the interface — the
  guard enforces the right design.
- **Anthropic choke point** — `client.ts:61` `streamMessage`, `client.ts:92`
  `createMessage`; both call `assertWithinBudget` first, so every loop iteration
  is budget-checked for free. `createMessage` currently returns
  `res.content.filter(TextBlock).map(text).join("")` — silently drops non-text.
- **Redaction** — `server/lib/redaction.ts` exports `redactSecrets(input)` +
  `registerSecret`/`unregisterSecret`. Only knows registered secrets — a floor,
  not a ceiling (accept residual risk explicitly).
- **Route** — `server/routes/chat.ts:71` builds the system prompt and streams via
  `streamMessage` (SSE `send()` at :77); a non-stream path uses `createMessage`
  (:134). Tools bind to the chat's repo here; emit an SSE event per tool call.
- **Persistence risk** — `chats` writes trigger a GCS snapshot
  (`server/db/snapshot.ts`), bucket `gs://dispatch-1-499113-state` retains
  noncurrent versions. This is why the secrets test is written FIRST.

### [2.3] Prior sessions

- **SES-0005** (#28) — just closed (PR #36, pending merge). Its follow-up named
  #27 as next. No blocker carries over; #27 touches `anthropic/`, `chat.ts`, and
  the provider seam — disjoint from #28's skills rename.

### [2.4] Git/PR state

Branch `main`. This session branches `feat/27-spec-chat-file-tools` off it.
**Six PRs open awaiting human merge** (#33/#34/#35/#36/#37 from prior sessions,
plus #32 already merged) — none touch `anthropic/`, `chat.ts`, or the provider
file-read seam, so no conflict with this work. `main` lacks #28, but #27 is
disjoint.

## [3] Checklist

TDD-first. Branch `feat/27-spec-chat-file-tools`. **The secrets guardrail test is
written FIRST** (ticket Stage 4), before any capability exists to leak through.

### [3.1] Stage 4 first — secrets guardrail (RED before anything reads)
- [x] write failing test: `read_file` on a denylisted path (`.env`, `*.pem`, `id_rsa*`, `credentials*`) returns a refusal and NEVER contents
- [x] write failing test: `redactSecrets()` is applied to a tool result — a registered secret value appears in none of {tool result, streamed text, `chats` row}
- [x] write failing test: `read_file` rejects absolute paths and any `..` segment

### [3.2] Stage 1 — provider seam
- [x] write failing test: fake + both adapters expose `readFile(repo, path)` / `listFiles(repo, path)`; size cap + binary detection
- [x] add `readFile`/`listFiles` to `RepoProvider`; lift the private methods on `github.ts` + `gitlab.ts`; seam guard stays green

### [3.3] Stage 2 — client tool-use loop
- [x] write failing test: `createMessage` acts on a `tool_use` block instead of returning "" (stubbed SDK)
- [x] write failing test: the loop runs `runTool` while `stop_reason === "tool_use"` and terminates at the 8-iteration / 10-read cap (adversarial loop)
- [x] implement `tools` + `runTool` on `streamMessage`/`createMessage`; truncation marker for oversized files

### [3.4] Stage 3 — route wiring
- [x] write failing test: a spec chat asked about a visible file fetches contents and answers from them (route test, stubbed provider)
- [x] bind the two tools to the chat's repo in `chat.ts`; emit an SSE event per tool call ("reading <path>")

### [3.5] Ship
- [x] `npm run verify` green (typecheck → seam → templates → tests)
- [ ] manual browser check: ask a spec chat about a deep file; confirm it reads it
- [x] open PR + link the PR url into ticket #27 `prs:`

## [4] Log

### [4.1] 2026-07-11 — session opened

#27 is a real feature (bounded, secure tool-use loop), well-specced in 4 stages.
Seam verified: both providers already fetch file text privately (`github.ts:231`,
`gitlab.ts:137`), just not on the interface; `client.ts` is the budget-checked
choke point; `chats` persistence → GCS snapshot is why the secrets test leads.
Ordering deliberately inverts the stages: **guardrail tests first**, so no
capability to leak exists before its containment is proven.

### [4.2] 2026-07-11 — all four stages shipped, PR #38

Built guardrails-first across five commits (each RED→GREEN). `npm run verify`
green at **622 tests**. Cleanup pass caught a literal-NUL-byte fixture that made
`file-read.test.ts` a git-binary blob — replaced with an explicit `\u0000` escape
(same input quirk that hit `gitlab.ts` earlier; worth a learning).

## [5] Decisions

1. **The tool executor (`tools.ts`), not the client, is the security boundary.**
   Denylist + path-safety + truncation + redaction all live at the one point
   between the model's request and the provider, so nothing can bypass them by
   calling a different code path.
2. **`SkillId`-style lockstep avoided; instead redaction is the LAST step** on
   every tool result — after truncation — so no marker or slice can reintroduce a
   registered secret.
3. **Two entry points, one loop shape:** `createMessage` (non-stream, for
   ticket-gen + the cap test) and a new `streamChat` async generator (SSE route).
   The final loop round withholds tools so an adversarial model must conclude
   rather than spin — cleaner than injecting a synthetic "stop" message.
4. **Provider `readFile` returns null for binary** (NUL-byte detection), same
   shape as "missing"; the executor's message covers both. Kept the seam simple
   (`string | null`) rather than a richer DTO.
5. **Residual risk accepted explicitly** (from the ticket): the denylist is a
   floor and `redactSecrets()` only knows *registered* secrets, so an unregistered
   token pasted into an allow-listed file is out of scope.

## [6] Outcomes

- **PR #38 opened** (`feat/27-spec-chat-file-tools`, Closes #27) — 6 commits.
  Ticket #27 → `in-progress`, PR linked. Awaiting human merge.
- New: `server/anthropic/tools.ts` (executor), `streamChat` + tool loop in
  `client.ts`, `readFile`/`listFiles` on the provider seam + both adapters, route
  wiring in `chat.ts`, SSE `tool` event + "reading X…" in the chat UI.
- Removed dead `streamMessage` (orphaned by `streamChat`) + its two test mocks.
- Cleaned a git-binary test fixture (literal NUL → `\u0000` escape).
- `npm run verify` green: **622 tests**, seam clean, templates match.

## [7] Follow-ups

- **[open] Manual browser check** of #27 — ask a spec chat about a deep file
  against a live repo + real model; confirm the read + "reading X…" UX. The route
  integration test proves the wiring; this is the human-eyeball pass. Worth a
  `/ticket` if not done before merge.
- **[open] Merge the PR stack** — #38 (#27) sits atop #33/#34/#35/#36/#37. Later
  branches don't contain each other; merging before the next ticket keeps `main`
  current.
- No test gaps: every behavior change shipped with adversarial coverage
  (denylist-before-provider, path traversal, redaction end-to-end, loop-cap
  termination, secret-never-persisted).

## [8] Documentation

- Captured in-PR and in [5] above. No ADR needed — the feature follows the
  documented provider-seam + budget-choke-point design rather than changing it.
- **Doc candidate (not written):** a `docs/learnings/` note — "spec-chat tool
  reads persist to `chats`, which snapshots to GCS, so the tool executor is a
  credential boundary: denylist before the provider, redact as the last step."
  Pairs with the earlier gitignored-`.claude`-clobber candidate from SES-0005.
  Also worth a one-liner on the literal-NUL-in-fixtures gotcha. Deferred; file
  before the next security-sensitive feature.
