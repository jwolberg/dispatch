---
id: 6
title: "Plain-language change summary on the card"
status: closed
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
  - "getPRDiff(repo, prNumber) is added to the GitProvider interface and implemented in both adapters; nothing outside server/providers/ imports Octokit or a GitLab client type"
  - "PRStatus carries headSha (already fetched by both adapters today, then discarded)"
  - "The summary is generated LAZILY on first card open, not by the poller, and Anthropic is called exactly once per (ticket, head SHA)"
  - "The result — what changed in plain English, what to click to test it, and a risk flag — is cached in a disposable summary_cache table keyed by head SHA, NOT in status_cache (whose only writer is the poller, per ARCH §8)"
  - "A new SHA on the same PR invalidates the cached summary; the same SHA never re-bills"
  - "The summary renders above the fold in web/src/pages/CardDetail.tsx"
  - "The diff sent to the model is truncated to a documented byte budget, and the truncation is stated in the prompt so the model knows it sees a partial view"
  - "The risk flag is a closed set, not free text, so #7 can render it as a chip"
  - "A failed or budget-blocked summary call degrades to no summary, never to a broken card, and never to a 500"
  - "Every summary call is recorded through recordSpend with kind 'summary' and gated by assertWithinBudget"
  - "Unit tests cover the bounding/truncation logic and the SHA cache key"
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

- Exactly one Anthropic call per (ticket, PR head SHA), with a bounded diff.
- Result cached in `summary_cache` (see Design notes); not recomputed per poll.
- Rendered above the fold in `web/src/pages/CardDetail.tsx`.
- New SHA invalidates the cache.
- Diff truncated to a documented byte budget; truncation is stated in the prompt
  so the model knows it is seeing a partial view.
- Failure or budget block → no summary, card still renders.
- Tests for truncation and cache key.

## Design notes

**Two gaps in the original ticket, settled 2026-07-09.**

*It needed a diff and there was no way to fetch one.* `GitProvider` exposes only
`additions` / `deletions` / `changedFiles` on `PRStatus`. Fetching an actual diff
is `getPRDiff()` — the headline of #11 (T2-1, Tier 2, size L). The plan's own
sequencing has T1-5 depending on nothing, so it never noticed. **Decision:
`getPRDiff()` is pulled forward into this ticket** and implemented in both
adapters. #11 shrinks to the in-app diff *view* and no longer owns the seam
method. Approved by the human, 2026-07-09.

*It named the wrong cache table.* The ticket said "cache the result in
`status_cache`", but `db/status.ts` states the poller is that table's only writer
(ARCH §8), and it is keyed per-ticket with no SHA — so it cannot satisfy this
ticket's own "a new SHA invalidates the cached summary". **Decision:** a new
disposable `summary_cache` table keyed by head SHA. Rebuild rule holds — wiping
it costs one re-summarize.

`PRStatus` gains `headSha`. Both adapters already fetch `pr.head.sha` and use it
to collect checks, then throw it away — the same shape of waste T2-3 describes
for the deploy run.

**Generated lazily, on first card open — not by the poller.** Approved by the
human, 2026-07-09. The poller runs every 5 minutes across every tracked ticket;
summarizing there bills for cards nobody opens, and #10's daily cap means that
budget is taken directly from the user's chat. Lazy costs a spinner on first
view.

Interacts with #10 (spend cap): a summary call is billable. Gate it with
`assertWithinBudget` and record it with `recordSpend({kind: "summary"})` — the
`SpendKind` slot already exists and this is its first caller.

Risk flag is a small closed set (`low` / `review-this`), not free text — #7
renders it as a chip.
