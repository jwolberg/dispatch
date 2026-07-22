---
id: 37
title: "Spec chat runs a real spec-shaping skill, not a one-paragraph instruction"
status: closed
priority: medium
horizon: next
hitl: false
type: feature
source: manual
created: 2026-07-22
updated: 2026-07-22
prs: []
refs:
  - "server/anthropic/prompts.ts"
  - "server/setup/templates.ts"
  - "https://github.com/EveryInc/compound-engineering-plugin"
depends_on: []
acceptance:
  - "The spec-shaping instruction lives in its own server-side module with a name, description, and body — not an inline const in prompts.ts"
  - "buildSystemPrompt composes that skill body with the existing repo-context sections; the injected repo context (description, CLAUDE.md, README, file tree) is unchanged"
  - "The skill body is derived from ce-brainstorm's method (open with the sharpest unknown, one question per turn, converge on a right-sized spec) and carries MIT attribution to EveryInc/compound-engineering-plugin"
  - "GENERATE_TICKET_INSTRUCTION still yields parseable ticket JSON — the existing chat and generate-ticket tests pass unchanged"
  - "No skill files are written into tracked repos: templatesFor() and scripts/repo-skills/ are untouched by this ticket"
  - "A test asserts the skill body is present in the system prompt for a repo-scoped chat"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

The spec chat's entire behavioral spec is one sentence — `SPEC_INSTRUCTION` at
`server/anthropic/prompts.ts:13`. It names the artifact it wants (title, problem,
ACs, files, test plan, out-of-scope) but says nothing about *how* to get there
from a vague idea, which is the actual hard part and the whole reason the page
exists. The result is a chat that collects requirements rather than interrogating
them.

`ce-brainstorm` in the compound-engineering plugin does exactly this job — vague
idea to right-sized requirements doc, explicitly positioned as the step before
planning — and it is MIT licensed. This ticket distills that method into a
first-class, server-side spec-shaping skill and makes it the chat's operating
instruction.

## Design notes

**Server-side, no repo writes.** This skill governs Dispatch's own chat surface,
so it belongs in Dispatch. It is deliberately *not* routed through
`scripts/repo-skills/` → `embed-templates` → `.claude/skills/`: that pipeline
exists because `claude-code-action` can only load skills committed to the target
repo (`server/setup/templates.ts:141`), and nothing in a user's CI would ever run
a spec-chat skill. Committing one into every tracked repo would be noise.

**Structure it for a second skill.** One skill is the scope here, but shape the
module so adding a mode later (bug report, refactor, migration) is a new entry
rather than a refactor. No picker UI in this ticket — the chat page keeps its
current single mode.

**Adapt, don't copy.** `ce-brainstorm` is 26 KB written for a full agent with a
filesystem, subagents, and a document to write. Spec chat is a stateless Messages
API call with `read_file`/`list_files` and a transcript. Take the interrogation
method; drop everything that assumes tools it does not have. Keep the result
short enough that it does not crowd the injected repo context — the existing
one-question-per-turn constraint is load-bearing for a chat UI and should survive.

**Watch the budget.** A longer system prompt costs tokens on every turn of every
chat, bounded by `DISPATCH_DAILY_BUDGET_USD`. Worth a sanity check on the delta
against a typical session rather than assuming it is free.

## Out of scope

- Loading the tracked repo's own `.claude/skills/` into chat (the earlier
  framing — file separately if wanted).
- Upgrading the `ci-*` skills with CE method; that one *does* travel the
  `scripts/repo-skills/` pipeline and is its own ticket.
- Any UI affordance for choosing a mode.
