---
id: 35
title: "Verify the review gate end-to-end on a real onboarded-repo PR"
status: open
priority: high
horizon: now
hitl: true
type: chore
source: docs/BUILD_PLAN-v2.md
created: 2026-07-12
updated: 2026-07-12
prs: []
refs:
  - "T2-5"
  - "docs/learnings/review-artifact-lives-on-the-pr-head.md"
depends_on: [34, 15]
acceptance:
  - "On a real onboarded repo, opening a PR runs review.yml and commits .TerMinal/reviews/<pr>/<sha>.md + findings.json + suggestions.json to the PR branch"
  - "The emitted artifact parses through parseReviewArtifact (verdict + test_status + findings) — confirmed against the real file, not the sample"
  - "Dispatch's GET /tickets/:id/review renders it and the Ship gate opens only on approve + pass + zero medium-plus findings"
  - "The artifact commit does not re-trigger review (paths-ignore + [skip ci] hold in practice)"
  - "Any format or behavior drift found is fixed in scripts/repo-skills/ci-review or the parser, with the sample updated to match"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

#34 built the review-gate emission (workflow + `ci-review` skill + install) and
the read-path fix, and pinned the artifact **format** against a committed sample.
What it could NOT do in the build environment is run `claude-code-action` in real
CI. This ticket closes that gap: exercise the whole loop on a real onboarded repo
and confirm the emitter behaves as designed.

HITL because it needs a live repo, a real PR, and the human to watch the Actions
run (and to hold a credential). Until this passes, the fail-closed gate blocks
every Ship — safe, but Ship stays shut.

## Why it matters

Per [[verify-external-formats-before-encoding-them]] / the learning
[[review-artifact-lives-on-the-pr-head]], the un-sampled path (CI runtime) is
exactly where reality diverges from the design. Confirm it once before trusting
the gate in production.

## Steps

1. Ensure a repo is onboarded through `POST /setup` so `review.yml` +
   `.claude/skills/ci-review` are installed and the Claude secret is present.
2. Open a PR; watch the Actions run write and commit the artifact triple.
3. Read the committed `<sha>.md` — confirm it parses (verdict/test_status/findings)
   and that Dispatch renders it and the gate behaves (block → approve as expected).
4. Confirm the artifact commit does not spawn a second review run.
5. Fix any drift in the skill/parser and update the sample.
