---
id: 8
slug: tier2-in-app-diff-view
anchor: SES-0008
title: "Tier 2 kickoff — #11 in-app diff view"
status: active
started: 2026-07-11T00:00:00Z
ended: null
goal: "Tier 2 track — start with #11 (in-app diff view)"
tickets: [11]
branches: [feat/11-in-app-diff-view]
prs: []
related_research: []
related_docs:
  - "docs/BUILD_PLAN-v2.md"
  - "docs/decisions"
prior_sessions: [6, 7]
---

## [1] Goal

Open the Tier 2 track ("depth for AI professionals"), starting with **#11 (T2-1):
render the PR's unified diff inside the app** so a professional reviewer doesn't
bounce to github.com to read what changed. Done = an open PR's diff renders on
the card, bounded and truncation-surfaced, consuming the `getPRDiff()` that #6
already landed, with the provider seam intact and both adapters tested against
one shared table.

## [2] Context & pointers

### [2.1] Tickets

**#11 — In-app diff view (T2-1)** · `open` → `in-progress` · medium · depends_on: [6] ✓
Acceptance criteria:
1. Unified diff renders in the app for an open PR, from #6's `getPRDiff()`.
2. Seam holds — nothing outside `server/providers/` imports Octokit / a GitLab client.
3. Large diffs bounded: a documented file/byte cap, truncation **shown** to the
   user, not silently dropped.
4. Both adapters tested against the same table (as linkage does).
5. Diff responses participate in the existing conditional-request cache, not
   refetched every poll.

Rest of Tier 2 (out of scope this ticket, sequenced after): #12 (T2-2 inline
steer comments, depends #11), #13 (T2-3 merged→deployed), #14 (T2-4 cost
telemetry), #15 (T2-5 review contract), #16 (T2-6 OIDC), #17 (T2-7 webhooks).

### [2.2] Research & docs — what already landed (prerequisites verified)

- **Start-gate cleared.** #11's design note says "must not start before Tier 1's
  onboarding track lands." #5 (T1-4 canary) is now `closed` — Tier 1 onboarding
  track is done. Build plan prose (`docs/BUILD_PLAN-v2.md`, updated 2026-07-10)
  is stale on this point; the live ticket board is authoritative.
- **`getPRDiff()` exists on the seam** — `server/providers/types.ts:306`, impl in
  `github.ts:543` and `gitlab.ts:369`, shared normalization in `providers/diff.ts`.
- **AC #5 already holds at the provider layer** — `github.ts` `getPRDiff` calls
  `this.cond(...)` (the `CondCache`), so any client endpoint that calls it
  inherits conditional-request caching. Verify gitlab side too.
- **AC #4 already holds** — `providers/diff.test.ts` tests both adapters against
  one shared table (file normalization, line counting, statuses, page cap).
- **AC #3 partly holds** — `PRDiff.truncated = files.length >= DIFF_MAX_FILES` is
  already carried in the data. Gap: the *view* must surface it, and there is no
  per-file **byte cap** on the patch text yet (a single huge patch can blow the
  payload). That byte cap + its truncation flag is the new bounded-ness work.

### [2.3] Where the gap is

`getPRDiff()` is currently consumed only **server-side** (`routes/summary.ts:102`)
to feed summarization. There is **no client-facing diff endpoint** and no diff
view. The work: a read route returning the card PR's `PRDiff`, and a render in
`web/src/pages/CardDetail.tsx` (300 lines; hero verdict+summary at [T1-6], diff
goes in a collapsible section below it).

### [2.4] Prior sessions

- SES-0007 (#32 password gate) — closed. SES-0006 (#27 spec-chat file tools) —
  closed; established the `readFile`/`listFiles` seam pattern and the seam-guard
  test discipline this ticket must respect (AC #2).

### [2.5] Git / PR state

Branch `main`, clean of source changes. Last merges: #43/#42/#41 (session-end +
password gate). No open PRs. No merged-but-unclosed tickets → no `/merge-sync`
needed before starting.

## [3] Checklist

### [3.1] Ticket 0011 — client-facing diff endpoint (backend) ✓

- [x] RED: diff route returns bounded `PRDiff` for an open PR; clean no-pr /
      error states; 404 unknown ticket (`server/routes/diff.test.ts`)
- [x] RED: an oversized patch is clipped + truncation reported via `boundDiff`
- [x] impl `GET /tickets/:id/diff` (`server/routes/diff.ts`) — reuses
      `getProviderForRepo(ref).getPRDiff` (inherits cond-cache) → `boundDiff`
      (256 KB view budget). No new Octokit import; seam guard green. See [5.1].

### [3.2] Ticket 0011 — in-app diff view (frontend) ✓

- [x] RED: `parsePatch` classifies unified-diff lines by direction
      (`web/src/lib/diffLines.test.ts`) — the pure rule, per the suite's
      no-jsdom convention (components verified by typecheck + eye)
- [x] impl `web/src/lib/diffLines.ts`, `components/DiffView.tsx`, `diffApi` in
      `api/tickets.ts`, and a lazy-mount `DiffSection` in `CardDetail.tsx`
- [x] `npm run verify` green — typecheck, seam, templates, 649 tests

### [3.3] Ticket 0011 — land

- [x] commit per ticket
- [ ] `/pr-creation` — push branch, open PR, link url into #11 `prs:`
- [ ] (after human merge) `/merge-sync` to close #11

## [4] Log

### [4.1] 2026-07-11 — session seeded

Verified all #11 prerequisites present (getPRDiff on seam + cond-cache, shared
adapter test table, PRDiff.truncated). Confirmed start-gate cleared via #5 being
closed. Scoped the real remaining work to a client diff endpoint + CardDetail
view + a per-file patch byte cap. Build plan prose is stale (says T1-4 pending);
board is source of truth.

## [5] Decisions

### [5.1] Reuse `boundDiff` for the view's byte cap — don't touch `PRFileDiff`

AC #3 wants a documented byte cap with truncation surfaced. `server/anthropic/
bound-diff.ts` already implements exactly this (`boundDiff()` → `BoundedDiff`
with per-file `patchTruncated` + top-level `truncated`), tested in
`bound-diff.test.ts`. Reusing it in the diff route — with a generous *view*
budget (much larger than the 24 KB Anthropic prompt budget, since a human wants
to read the whole real PR) — satisfies AC #3 without adding a field to
`PRFileDiff` or editing the shared adapter table. Smallest change, reuses a
tested seam. The route returns `BoundedDiff`; the view shows a truncation notice
and preserves the link-out to the provider for the full diff (ticket's stated
"closes the common loop, not every loop").

Chose a view budget of 256 KB (`DIFF_VIEW_PATCH_BUDGET_BYTES`): large enough to
render essentially any hand-reviewed PR whole, small enough to bound the browser
payload. Flat-cost constant; revisit if real PRs trip it.

## [6] Outcomes

_(filled by /session-end)_

## [7] Follow-ups

_(filled by /session-end)_

## [8] Documentation

_(filled by /session-end)_
