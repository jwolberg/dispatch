---
id: 29
title: "Onboarding claude.yml omits allowed_bots, so App-filed issues fail claude-code-action"
status: in-progress
priority: high
horizon: now
hitl: false
type: bug
source: feedback
created: 2026-07-10
updated: 2026-07-11
prs:
  - https://github.com/jwolberg/dispatch/pull/29
refs: []
depends_on: []
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
agent_run_id: da6ebb37-1694-496d-8f6d-2d13933897ef
agent_run_source: session
agent_session_id: da6ebb37-1694-496d-8f6d-2d13933897ef
agent_run_started_at: 2026-07-11T00:57:50.402Z
agent_run_status: completed
---

## Description

Once a deployment registers a GitHub App, Dispatch files issues with the App
installation token (`installationFor()` in `server/db/installations.ts` resolves
the repo to the installation). The issue is then authored by the App bot
(`<app-slug>[bot]`, type: Bot) instead of the human `GITHUB_TOKEN` PAT.

`anthropics/claude-code-action@v1` refuses to run for a bot-initiated trigger
unless the bot is allow-listed, failing with:

> Workflow initiated by non-human actor: `<app-slug>` (type: Bot).
> Add bot to allowed_bots list or use '*' to allow all bots.

The `claude.yml` Dispatch writes into onboarded repos
(`server/setup/embedded.ts`, `repo-ci/claude.yml`) sets no `allowed_bots`, so
the issue **files successfully (201)** but the Claude Code build step fails
immediately — which presents on the board as "opened a ticket and it failed."

Traced on production `jwolberg/situation` (2026-07-10): issues #3–#17 were filed
via the PAT (human actor) and built fine; after the App was registered, a filed
issue is bot-authored and `claude-code-action` rejects it. Run 29132221316 shows
the exact error. `situation` is patched directly (separate PR); this ticket is
the source-of-truth fix so every future onboarded repo is correct.

Note the failure is invisible in logs: `POST /api/tickets` (`server/routes/tickets.ts:68`)
returns the provider error as JSON and never reaches the logging middleware, so
the only trace is the workflow run log.

## Acceptance criteria

- The onboarding `claude.yml` template (`server/setup/embedded.ts`,
  `repo-ci/claude.yml`) sets `allowed_bots` on the `claude-code-action@v1` step
  to the deployment's App bot login (`<app-slug>[bot]`) when an App is
  registered, falling back cleanly for the PAT-only path.
- The App slug is resolved from the registered App (not hardcoded), since each
  deployment registers its own App (ADR-0006 §5). If templating the slug per
  deployment is out of scope for the embedded string, document the required
  manual edit and cover it in onboarding.
- A test asserts the provisioned `claude.yml` contains an `allowed_bots` entry
  that matches the App bot login for an App-backed deployment.
- Onboarding docs (DEPLOY.md §3.6 / README) note that App-filed issues require
  `allowed_bots`, so a reader hitting a failed build has the fix.
