---
id: 34
title: "CI review step emits the review-artifact triple into the repo"
status: open
priority: high
horizon: next
hitl: false
type: feature
source: docs/BUILD_PLAN-v2.md
created: 2026-07-11
updated: 2026-07-11
prs: []
refs:
  - "T2-5"
  - "scripts/repo-ci/"
  - "scripts/repo-skills/"
depends_on: [15, 4]
acceptance:
  - "A pull_request-triggered workflow runs the code-review and writes .TerMinal/reviews/<pr>/<sha>.md + findings.json + suggestions.json into the repo, matching the code-review agent contract"
  - "The workflow is installed through the existing #4 setup path (scripts/repo-ci + embed-templates), not hand-added"
  - "The artifact the workflow emits parses cleanly through #15's parseReviewArtifact — verified against a committed sample"
  - "The review credential is handled via the existing secret pattern, never committed"
  - "Emitting the artifact does not itself trigger a recursive review run"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Follow-up carved out of #15 (T2-5). #15 landed the **consumption** side: Dispatch
fetches and renders the review artifact and the merge route is gated fail-closed
on `verdict: approve` + `test_status: pass` + zero findings ≥ medium, re-validated
server-side. Until CI actually emits the artifact, that gate stays closed for
every PR (which is the safe direction).

This ticket is the **emission** side: a `pull_request` workflow that runs the
code-review and commits the artifact triple into the repo it describes, installed
through the same #4 setup path that writes `claude.yml`/`deploy.yml`. It was split
out because it is a substantial standalone build that (a) runs in the *user's* CI,
(b) writes a workflow + a review credential into user repos (a careful external
surface), and (c) has its own anti-recursion and auth concerns — none of which
the fail-closed gate needs in order to be correct.

## Design notes

- Reuse `scripts/repo-ci/` + `scripts/embed-templates.mjs` (the #4 AC-11 source
  of truth) so the template is embedded and installed like the others.
- Match the artifact paths and schema `parseReviewArtifact` already reads
  (`.TerMinal/reviews/<pr>/<short_sha>.md`, `findings.json`); pin it with a
  committed sample that round-trips through the parser.
- Anti-recursion: emitting/committing the artifact must not re-trigger the review
  (path filters / actor checks), mirroring the ADR-0006 reasoning for the PR path.
- Verify the emitted `verdict`/`test_status`/severity values against real
  code-review output before locking the format (per the sample-never-infer rule).
