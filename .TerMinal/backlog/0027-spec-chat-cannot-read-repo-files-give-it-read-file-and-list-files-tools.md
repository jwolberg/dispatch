---
id: 27
title: "Spec-chat cannot read repo files — give it read_file and list_files tools"
status: in-progress
priority: high
horizon: now
hitl: false
type: feature
source: "observed on a spec chat against jwolberg/situation, 2026-07-10"
created: 2026-07-10
updated: 2026-07-11
prs:
  - "https://github.com/jwolberg/dispatch/pull/38"
refs:
  - "server/anthropic/prompts.ts"
  - "server/anthropic/client.ts"
  - "server/routes/chat.ts"
  - "server/providers/types.ts"
  - "server/providers/github.ts:230"
  - "server/providers/gitlab.ts:136"
  - "server/lib/redaction.ts"
  - "scripts/check-seam.sh"
depends_on: []
acceptance:
  - "RepoProvider exposes readFile(repo, path) and listFiles(repo, path); both GitHub and GitLab implement them, and a fake provider proves the seam in tests"
  - "streamMessage and createMessage accept tools and a runTool callback, and loop while stop_reason === 'tool_use'"
  - "createMessage no longer silently drops non-text content blocks — a tool_use block in the response is acted on, not discarded"
  - "A spec chat asked about a file it can see in the tree fetches that file's contents and answers from them, verified by a route test with a stubbed provider"
  - "read_file on a denylisted path (.env, .env.local, deploy.pem, id_rsa, credentials.json) returns a refusal and NEVER returns file contents — proven by a test asserting the secret value appears nowhere in the tool result, the transcript, or the persisted chat row"
  - "redactSecrets() is applied to every tool result before it reaches the model or the chats table"
  - "A turn is capped at 8 tool-use iterations and 10 file reads; exceeding either ends the loop with a message the model can see, and a test proves an adversarial loop terminates"
  - "Files larger than the cap are truncated with an explicit marker so the model knows it received a fragment"
  - "read_file rejects absolute paths and any path containing '..'"
  - "npm run verify passes, including the provider-seam guard"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Spec-chat can name files it cannot read. Observed on a chat against
`jwolberg/situation`:

> **user:** Tell me how MAET thresholds work
>
> **assistant:** I can see there's a `configs/config_maet.py` and a
> `docs/maet-integration-spec.md`, but their contents weren't included in the repo
> context.
>
> **user:** Check the files
>
> **assistant:** I don't have the ability to read files directly — I'm a
> spec-writing assistant, not an agent with filesystem access.

**The model was telling the truth.** `buildSystemPrompt` (`server/anthropic/prompts.ts`)
injects exactly four things: description, `CLAUDE.md`, a README excerpt, and a
**file tree at depth 2, names only**. And `streamMessage` / `createMessage`
(`server/anthropic/client.ts`) never pass `tools`, so there is no mechanism for the
model to ask for more. This is a missing capability, not a prompt bug — no amount of
system-prompt rewording fixes it.

Consequence: every spec written through the chat is written by a model that has read
filenames and nothing else. The specs are worse than they look.

## Approach: tools, not a bigger prompt

Give the model two tools and let it pull what it needs:

- `read_file(path)` → file contents (truncated, redacted, denylist-checked)
- `list_files(path)` → directory entries

`list_files` is **not** deferrable to v2. The injected tree is depth 2, so anything
deeper is invisible and the model cannot request what it cannot see.

### Why not a retrieval pre-pass

The simpler alternative — one cheap `createMessage` that picks *K* likely-relevant
files from the tree, fetch them, inject them — needs no streaming changes. Rejected:
it guesses once and cannot follow references. `configs/config_maet.py` almost
certainly imports `configs/config_ttl.py`, and nothing in the tree says so. Tools
chase that edge; a pre-pass cannot.

### The seam is already most of the way there

Both providers already fetch file text, privately:

- `server/providers/github.ts:230` — `private async fetchFileText(owner, repo, path)`
- `server/providers/gitlab.ts:136` — `private async fetchFile(id, path, ref)`

They are simply absent from the `RepoProvider` interface. `scripts/check-seam.sh`
forbids `@octokit` / `@gitbeaker` outside `server/providers/`, so the tool executor
**must** go through the interface — the guard enforces the right design.

## Staged plan

Each stage is independently verifiable. `npm run verify` is the gate throughout.

**Stage 1 — provider seam.** Add `readFile` / `listFiles` to `RepoProvider`; lift the
existing private methods on both providers. Enforce a size cap and detect binary
content. *Verify:* unit tests against a fake provider; seam guard stays green.

**Stage 2 — client tool-use.** `streamMessage` / `createMessage` take `tools` and a
`runTool` callback and loop while `stop_reason === "tool_use"`.

Note `createMessage` currently does this (`client.ts:120-123`):

```ts
return res.content
  .filter((b): b is Anthropic.TextBlock => b.type === "text")
  .map((b) => b.text)
  .join("");
```

It **silently discards every non-text block**, so a `tool_use` block would vanish and
the call would return an empty string. That has to change regardless of this feature.

`assertWithinBudget` already sits at the choke point, so every loop iteration is
budget-checked for free. *Verify:* unit tests with a stubbed SDK, including a
tool-loop that hits the iteration cap.

**Stage 3 — route.** Bind the tools to the chat's repo in `server/routes/chat.ts`.
Emit an SSE event per tool call so the UI can render *"reading configs/config_maet.py"*
rather than appearing to hang for several seconds. *Verify:* route test with a stubbed
provider; manual check in the browser.

**Stage 4 — guardrails.** See below. *Verify:* the secrets test is the first test
written for this ticket, before any of the above.

## Guardrails

### Secrets — the one that matters

Chat transcripts persist to SQLite, and `chats` is one of the four tables whose write
triggers a **GCS snapshot upload** (`server/db/snapshot.ts`). So a model that reads
`.env` writes credentials into a durable, versioned object in
`gs://dispatch-1-499113-state` — a bucket whose noncurrent versions are retained.
The blast radius of one bad `read_file` is much larger than one chat turn.

Required:

- A denylist: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `*.p12`, `*.pfx`.
  A denylisted read returns a refusal, never contents.
- `redactSecrets()` (`server/lib/redaction.ts`) applied to every tool result before it
  reaches the model or the transcript.
- The test asserts the secret value appears in **none** of: the tool result, the
  streamed response, the `chats` row.

A denylist is a floor, not a ceiling — it cannot catch a token pasted into
`config.py`. `redactSecrets()` is the second layer, and it only knows secrets that
were registered. Accept the residual risk explicitly rather than pretending it is
closed.

### The rest

- **Budget.** A tool loop multiplies Anthropic calls per user turn. Cap at 8
  iterations and 10 reads. Exceeding either ends the loop with a message the model can
  see, so it degrades into "I could not read enough to answer" rather than hanging.
- **Truncation.** Cap file size (~64 KB); mark the truncation explicitly so the model
  knows it holds a fragment and does not confidently describe code it never saw.
- **Path safety.** Reject absolute paths and any `..` segment. The provider API is
  already repo-scoped, so this is defense in depth, not the primary control.
- **Rate limit.** Reads spend the GitHub token's quota, which the poller tracks
  (`leastRemaining`). Route reads through the existing conditional-request/ETag cache
  (`setCondCacheStore`) so a chatty session does not pause polling.

## Out of scope

Deepening the injected file tree beyond depth 2. `list_files` makes it unnecessary,
and a deeper tree costs context on every turn whether or not it is used.
