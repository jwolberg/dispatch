---
id: 4
title: "POST /api/repos/:id/setup — write workflows + secrets via API"
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
  - "T1-3"
  - "scripts/install-claude-action.sh"
  - "ADR-0002"
  - "ADR-0006"
depends_on: [2, 3]
acceptance:
  - "One POST commits .github/workflows/claude.yml, a stack-aware ci.yml from scripts/repo-ci/, and the plan/implement/debug skills from scripts/repo-skills/ into the target repo"
  - "The claude.yml template drops the `gh pr create` post-step and the GH_PAT secret entirely; claude-code-action pushes a branch under the default GITHUB_TOKEN and nothing else"
  - "No App credential is written into the target repo — no GH_PAT, no APP_CLIENT_ID, no APP_PRIVATE_KEY. Exactly one secret is written: the Claude auth token"
  - "The Claude auth secret is set via the Secrets API using libsodium sealed-box encryption"
  - "When installing in OAuth mode, any existing ANTHROPIC_API_KEY repo secret is deleted"
  - "OAuth-token-preferred behavior from install-claude-action.sh is preserved"
  - "The provider seam gains createPullRequest and branch listing, for both GitHub and GitLab, with no SDK import outside server/providers/ (npm run check:seam stays green)"
  - "The poller opens a PR for a branch that links to an open dispatch-labeled issue and has no open PR, authenticated with the App installation token"
  - "The poller does NOT open a PR from a branch a human pushed — the discriminator is sampled from a real claude-code-action run and cited in a test fixture, never inferred from documentation"
  - "Re-running setup on an already-configured repo is idempotent and does not duplicate commits"
  - "Templates are embedded at build time; scripts/repo-ci/ and scripts/repo-skills/ remain the single source"
  - "Setup runs end-to-end from the browser with no shell step"
  - "No secret value is logged, returned in a response body, or written to an artifact"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

`scripts/install-claude-action.sh` is 250 lines of bash that already knows
everything onboarding needs to do. Porting it into TypeScript behind one endpoint
is what makes "no terminal" true from first click.

The endpoint commits the Claude workflow, a stack-aware CI workflow, and the
`plan`/`implement`/`debug` skills into the target repo, and sets the Claude auth
secret.

**ADR-0006 removed the hard part.** The workflow no longer opens pull requests, so
it no longer needs a non-default token, so no App credential is written into a
user's repo at all. What used to be this ticket's approval gate is now a deletion.

## Acceptance criteria

See frontmatter. What changed, and why:

- **`claude.yml` loses its `gh pr create` post-step** (`install-claude-action.sh:136–151`)
  and its `GH_PAT` secret. `claude-code-action` pushes a branch with the default
  `GITHUB_TOKEN`; that always worked, because pushing was never the blocked
  operation.
- **Dispatch's poller opens the PR** with its App installation token. The PR is
  App-authored, so `pull_request` runs execute without approval, and Actions never
  attempts a PR creation that `can_approve_pull_request_reviews: false` would 403.
- **One secret, not two.** The Claude auth token. Its blast radius is the
  operator's own Anthropic account, which onboarding already accepts.

## Design notes

The sealed-box encryption is the one genuinely fiddly part; everything else is a
transliteration of the bash.

**Detecting `can_approve_pull_request_reviews` is no longer required.** ADR-0002 [3.1]
demanded it because a `GITHUB_TOKEN`-authored PR 403s at creation when the setting
is off. Under ADR-0006 [3] Actions never creates a PR, so the setting is
unreachable. #5's canary still reports the condition if a repo somehow lands there.

**The `ANTHROPIC_API_KEY` deletion is not a nicety.** Per `docs/implementation-notes.md`
(2026-06-12): the API key outranks the OAuth token in Claude's auth precedence, so
leaving it in place silently keeps billing the metered API. Cover it with a test.

### New provider surface

`server/providers/github.ts` has `createIssue`, `postComment`, `mergePR`,
`getWorkflowRuns` and the read path. It has **no `createPullRequest` and no branch
listing.** Both land here, behind the seam, with GitLab counterparts.

### Identifying Claude's branch — sample it, do not infer it

`linkage.ts`'s `linksToIssue()` already matches a branch to an issue by
digit-bounded number, so `claude/issue-7-…` → #7 needs no new regex and no
branch-name convention. Reuse it.

But "links to an open `dispatch` issue and has no open PR" **also matches a human
branch named `fix-7`**, and opening a pull request from somebody's
work-in-progress is not a recoverable mistake. The likely discriminator is the
branch tip's committer identity (`github-actions[bot]`).

**This has not been observed.** `steps.claude.outputs.branch_name` proves the
workflow knows the branch name from the inside; it says nothing about what the
poller can see from the outside. Run `claude-code-action` against a scratch repo,
read the branch and its tip commit off the API, and build the fixture from that.
ADR-0006 [4], [8].

### The poller is now load-bearing

A branch becomes a PR only while Dispatch is running. That adds no availability
requirement — Dispatch must be up to render the board — but it turns a missed poll
from "the board is stale" into "the build never proceeds." Note it in the runbook.

## Action needed

None blocking. The approval gate that lived here — ADR-0002 [4]'s blast-radius
tradeoff — was closed on 2026-07-09 by ADR-0006 [2] in favor of the option that
writes no App credential to any user repo. Still confirm the scratch repo used for
testing, and do not run setup against a real user repo during development.
