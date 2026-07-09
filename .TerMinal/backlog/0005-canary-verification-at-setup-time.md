---
id: 5
title: "Canary verification: prove the build triggers, at setup time"
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
  - "T1-4"
  - "docs/adding-a-repo.md"
  - "ADR-0002"
depends_on: [4]
acceptance:
  - "After setup, Dispatch files a throwaway issue containing an @claude mention in the target repo"
  - "It polls for a matching workflow_run within a bounded window and records pass or fail"
  - "The canary passes only when the run reaches a conclusion of success — a run in action_required (awaiting approval) is a FAIL, not a pass. Presence of a workflow_run is never sufficient. See ADR-0002."
  - "A test asserts the canary fails against a fixture whose run status is action_required"
  - "On completion it closes the throwaway issue and deletes any branch the run created, on both the pass and fail paths"
  - "Pass/fail and the timestamp are persisted and rendered on the repo card"
  - "A failed canary produces an actionable message naming the likely cause, not a generic error"
  - "The cleanup path is covered by a test that asserts no throwaway artifacts survive a failed canary"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Writing a workflow file is not the same as the workflow running. The failure mode
Dispatch exists to prevent is a user filing a ticket, watching the card sit in
`Queued` forever, and having no idea why.

So after setup, prove it: file a throwaway issue with an `@claude` mention, poll
for a `workflow_run` within a bounded window, then clean up. Record the verdict
on the repo card.

This converts the nastiest piece of tribal knowledge in `docs/adding-a-repo.md`
— that a PR opened by the default token silently never triggers CI — into an
automated check that fails loudly at setup time instead of quietly at first
build.

## Acceptance criteria

- Throwaway issue with `@claude` filed post-setup.
- Bounded poll for a matching `workflow_run`; verdict recorded.
- **Pass requires `conclusion: success`.** A run sitting in `action_required` is
  a fail. Per ADR-0002, a PR opened by the default `GITHUB_TOKEN` *does* create a
  workflow run — it just never executes without a human clicking "Approve
  workflows to run". A presence check would therefore report a green canary on
  precisely the broken configuration this ticket exists to detect.
- Test asserts a fail against an `action_required` fixture.
- Issue closed and any created branch deleted — on both pass and fail.
- Verdict + timestamp persisted and shown on the repo card.
- Failure message names the likely cause (e.g. "the token that opened this event
  cannot trigger workflows"), not a generic error.
- Test asserts cleanup runs on the failure path.

## Design notes

Pick the timeout deliberately and state it: a cold GitHub Actions runner can take
a minute or more to pick up a job. Too short and the canary lies.

Cleanup on the failure path is the part that will be skipped if it is not tested.
Test it.

The canary writes to a user's repo. It must be safe to run twice, and it must
never leave an open issue behind.
