---
id: 25
title: "claude.yml never runs: omitting github_token makes claude-code-action demand the Claude GitHub App"
status: closed
priority: high
horizon: now
hitl: false
type: bug
source: "observed while sampling for #4 AC 9"
created: 2026-07-10
updated: 2026-07-10
prs: []
refs:
  - ".github/workflows/claude.yml"
  - "scripts/install-claude-action.sh"
  - "ADR-0006 [2]"
  - "#24"
  - "#4"
depends_on: []
acceptance:
  - "claude.yml passes github_token explicitly, so claude-code-action uses the default GITHUB_TOKEN and never attempts the Claude GitHub App token exchange"
  - "scripts/install-claude-action.sh emits the same corrected template"
  - "An @claude issue on jwolberg/dispatch reaches Claude instead of failing at auth — verified by a run that gets past the token exchange"
  - "ADR-0006 [2] says 'passed explicitly', not merely 'the default GITHUB_TOKEN' — the distinction is the whole bug"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

`#24` shipped a `claude.yml` that **omits** the `github_token` input, on the strength
of ADR-0006 [2]:

> `claude-code-action` pushes a branch using the default `GITHUB_TOKEN`

The intent is right; the mechanism is wrong. Omitting the input does not fall back
to the default token — it makes the action perform an **App token exchange** against
Anthropic's own Claude GitHub App. Observed on
[run 29068754525](https://github.com/jwolberg/dispatch/actions/runs/29068754525),
which failed in 27s:

```
App token exchange failed: 401 Unauthorized -
Claude Code is not installed on this repository.
Please install the Claude Code GitHub App at https://github.com/apps/claude
```

The action's own `action.yml` says so plainly — `github_token` has **no default**:

```yaml
github_token:
  required: false
  description: GitHub token with repo and pull request permissions
               (optional if using GitHub App)
```

`jwolberg/situation` never hit this because its pre-#24 workflow passed
`github_token: ${{ secrets.GH_PAT }}` — an explicit token, so the exchange was
skipped. Deleting `GH_PAT` in #24 removed the token *and* silently opted the
workflow into a GitHub App that is not installed.

## Fix

One line, plus the same line in the installer's template:

```yaml
github_token: ${{ github.token }}
```

That is the default `GITHUB_TOKEN`, which is exactly what ADR-0006 [2] intended. It
still opens no pull request, still writes no App credential into the repo, and still
requires nothing but `contents: write` to push the branch. The Claude GitHub App
stays uninstalled and unneeded.

## Why this matters beyond the one-line fix

There are now **three** distinct GitHub Apps in play, and conflating any two of them
produces a plausible-looking wrong answer:

1. `dispatch-jay` — Dispatch's own App. Mints installation tokens so Dispatch's
   server can read repos and open PRs. Registered per deployment (ADR-0006 [5]).
2. **The Claude GitHub App** (`github.com/apps/claude`) — Anthropic's. Only used by
   `claude-code-action` when `github_token` is absent. **Not installed, not wanted.**
3. Nothing else. There is no third credential in the repo.

This is the second time in two days that an *inferred* mechanism turned out false
under observation (the first: ADR-0006 [8]'s `pull_request` arm, closed by #22 — and
it held). The lesson generalizes: `ADR-0006 [4]`'s standing instruction to *sample,
never infer* applies to the action's inputs, not just to branch identities.

## Note

The `claude.yml` for the `issues` / `issue_comment` events is always read from the
**default branch**, never from a PR head. So this fix does nothing until it merges,
and it cannot be tested from a branch.
