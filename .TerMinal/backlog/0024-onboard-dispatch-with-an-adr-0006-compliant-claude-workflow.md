---
id: 24
title: "Onboard dispatch with an ADR-0006-compliant claude.yml, and drop GH_PAT from the installer"
status: closed
priority: high
horizon: now
hitl: true
type: chore
source: "operator asked why the Tracked card warns 'No Claude automation detected'"
created: 2026-07-10
updated: 2026-07-09
prs: []
refs:
  - "scripts/install-claude-action.sh"
  - ".github/workflows/claude.yml"
  - "ADR-0006 [2]"
  - "ADR-0006 [8]"
  - "#4"
depends_on: []
acceptance:
  - "jwolberg/dispatch carries .github/workflows/claude.yml, so detectAutomation() returns true and the repo card's warning clears — truthfully, not by suppressing the banner"
  - "The workflow drops the `gh pr create` post-step and the GH_PAT secret entirely (ADR-0006 [2]); claude-code-action pushes a branch under the default GITHUB_TOKEN and nothing else"
  - "scripts/install-claude-action.sh writes the same compliant template — it must not re-introduce GH_PAT into any repo it onboards"
  - "No App credential is written into the repo: no GH_PAT, no APP_CLIENT_ID, no APP_PRIVATE_KEY. Exactly one secret is needed, the Claude auth token"
  - "ADR-0006 [8]'s evidence citation, which points at the post-step's line numbers, is corrected rather than left dangling"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

The Tracked repo card shows **⚠ No Claude automation detected** for
`jwolberg/dispatch`. The banner is **correct** — the repo has only `ci.yml` — and
`automation_detected` has exactly one consumer, that banner. Nothing functional
reads it. The right way to make it go away is to make it false.

What is stale is the remedy it points at. `scripts/install-claude-action.sh` still
commits a `gh pr create` post-step authenticated with a `GH_PAT` secret. **ADR-0006
[2] deleted exactly that**: the workflow no longer opens PRs, `claude-code-action`
pushes a branch under the default `GITHUB_TOKEN`, and Dispatch's server opens the
pull request with its App installation token. Running the installer today would
re-introduce the `GH_PAT` that ADR-0006 removed. That is the "old method".

## Why this is carved out of #4 rather than folded into it

#4 (`POST /api/repos/:id/setup`) owns the full job: the compliant template, the
`createPullRequest` provider seam, and the poller that opens the PR. But its AC 9
requires the human-vs-Claude branch discriminator be

> sampled from a real `claude-code-action` run and cited in a test fixture, never
> inferred from documentation

and **you cannot sample a run without the workflow installed**. So installing
`claude.yml` is a *prerequisite* of #4, not a consequence of it. This ticket does
only the prerequisite, on the one repo, plus the installer correction that #4's
AC 2 would otherwise have to make anyway.

## Known, accepted gap

Until #4 lands, Dispatch **cannot open a pull request** — there is no `pulls.create`
anywhere in `server/`. So after this ticket:

- `@claude` on an issue triggers a run, and Claude pushes a branch. ✅
- Nothing opens a PR for that branch. ❌ The board's `findLinkedPR` finds none, and
  the card sits pre-PR (`reconcile.ts:129`).

This is the honest intermediate state, and it is strictly better than the old
method, which closed the loop by handing every onboarded repo a `GH_PAT`. It also
produces the very run #4 needs to sample. **Do not "fix" the gap by restoring the
post-step.**

## Human step

The workflow needs one secret, and only the operator can set it:

```bash
claude setup-token                       # produces the OAuth token
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo jwolberg/dispatch
```

Prefer OAuth over `ANTHROPIC_API_KEY` — an `ANTHROPIC_API_KEY` repo secret outranks
the OAuth token in Claude's auth precedence and would silently bill the metered API.
Until the secret exists, the workflow is inert: it triggers and fails at auth. The
banner clears regardless, because detection reads the workflow file, not the secret.
