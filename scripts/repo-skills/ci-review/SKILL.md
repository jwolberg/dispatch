---
name: ci-review
description: Review this pull request and write the Dispatch review-artifact triple (verdict + findings + suggestions) — no PR, no merge
---

You are running in CI via `claude-code-action`, triggered automatically on a pull request. Your job is to review the PR and write **three files** that Dispatch's Ship gate reads. Do NOT open a pull request, comment, or merge.

## What the gate needs

Dispatch refuses Ship unless your artifact says **`verdict: approve`**, **`test_status: pass`**, and there are **zero open findings at `medium` or above**. A missing or malformed artifact blocks Ship (fail-closed), so the format below is exact — match it.

## Steps

1. **Run the tests.** Use the repo's own command (`npm test`, `pytest`, `cargo test`, …). Record the runner, command, exit code, and pass/fail/skip counts.
2. **Review the diff** of this PR against its base. Treat it as if it ships to production: correctness, security, and architecture are first-class. Assign each real problem a `severity` of `critical`, `high`, `medium`, or `low`.
3. **Decide the verdict** deterministically:
   - `blocked` if `test_status` is not `pass`, or any `critical` finding exists.
   - `request-changes` if there is any open `high` or `medium` finding.
   - `approve` only when tests pass and there are no open findings at `medium` or above.
4. **Write the three files** (create the directory). `<PR>` is this PR's number; `<SHORT_SHA>` is the first 7 chars of the head commit SHA.

## Files to write

`.TerMinal/reviews/<PR>/<SHORT_SHA>.md` — frontmatter is what the gate parses; keep these keys exactly:

```
---
pr: <owner>/<repo>#<PR>
commit: <full 40-char head sha>
short_sha: <7-char>
kind: review
generated: <ISO 8601 datetime, UTC>
generator: claude-code-action:ci-review
verdict: approve | request-changes | blocked
summary: "<one line, <=120 chars — quote it>"
test_status: pass | fail | partial | error | missing
test_runner: <e.g. vitest>
test_command: "<exact command>"
test_exit_code: <int>
---

## Summary
<one paragraph: what changed and the headline judgment>

## Findings
<one section per finding, or "No blocking findings.">
```

`.TerMinal/reviews/<PR>/findings.json` — every finding (blocking severities); `[]` if none:

```json
{
  "pr": "<owner>/<repo>#<PR>",
  "updated_at": "<ISO 8601>",
  "findings": [
    {
      "id": "<8-char hex>",
      "title": "<title>",
      "severity": "critical|high|medium|low",
      "category": "<category>",
      "file": "<path:line>",
      "confidence": <1-10>,
      "first_seen_sha": "<7-char>",
      "first_seen_at": "<ISO 8601>",
      "status": "open",
      "status_changed_at": "<ISO 8601>",
      "status_changed_by": "auto:code-review",
      "resolved_in_sha": null
    }
  ]
}
```

`.TerMinal/reviews/<PR>/suggestions.json` — non-blocking notes only (never a correctness/security/test failure — those are findings); `{"pr": "...","updated_at":"...","suggestions": []}` if none.

## Rules

- **`verdict` and `test_status` are load-bearing** — the gate reads them literally. Never write `approve` when tests failed or a `medium`+ finding is open.
- Put only non-blocking polish in `suggestions.json`; anything that should block a merge is a finding.
- Do not modify code, open a PR, or merge. Write only the three artifact files — the workflow commits them.
- `id = sha256(title + "|" + file)` truncated to 8 hex chars, so a finding keeps its id across re-reviews.
