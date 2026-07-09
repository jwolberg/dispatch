---
id: 6
title: "Plain-language change summary on the card"
status: open
priority: high
horizon: now
hitl: false
type: feature
source: docs/BUILD_PLAN-v2.md
created: 2026-07-09
updated: 2026-07-09
prs: []
refs:
  - "docs/BUILD_PLAN-v2.md"
  - "T1-5"
depends_on: []
acceptance:
  - "On PR open, Anthropic is called exactly once with a bounded diff (file list plus truncated patch)"
  - "The result — what changed in plain English, what to click to test it, and a risk flag — is cached in status_cache and not recomputed on subsequent polls for the same SHA"
  - "The summary renders above the fold in web/src/pages/CardDetail.tsx"
  - "A new SHA on the same PR invalidates the cached summary"
  - "The diff sent to the model is truncated to a documented byte budget, and truncation is visible in the prompt"
  - "A failed or budget-blocked summary call degrades to no summary, never to a broken card"
  - "Unit tests cover the bounding/truncation logic and the cache key"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

The target user cannot read a diff. A card that leads with a list of check names
tells them nothing. On PR open, summarize the change once in plain English: what
changed, what to click to test it, and whether it looks risky.

Independent of the onboarding track — this can run in parallel once Tier 0 is
green.

## Acceptance criteria

- Exactly one Anthropic call per PR SHA, with a bounded diff.
- Result cached in `status_cache`; not recomputed per poll.
- Rendered above the fold in `web/src/pages/CardDetail.tsx`.
- New SHA invalidates the cache.
- Diff truncated to a documented byte budget; truncation is stated in the prompt
  so the model knows it is seeing a partial view.
- Failure or budget block → no summary, card still renders.
- Tests for truncation and cache key.

## Design notes

`status_cache` is a disposable cache table (rebuild rule): wiping it costs one
re-summarize, nothing more.

Interacts with #10 (spend cap): a summary call is billable and must be recorded
and gated like a chat turn. Land whichever first, wire the other on arrival.

Risk flag should be a small closed set (e.g. `low` / `review-this`), not free
text — #7 renders it as a chip.
