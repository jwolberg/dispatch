---
id: 26
title: "Re-onboard jwolberg/situation through POST /setup — proves #4 AC 12 and removes a live GH_PAT"
status: open
priority: high
horizon: now
hitl: true
type: chore
source: "session-end SES-0003; observed 2026-07-10"
created: 2026-07-10
updated: 2026-07-10
prs: []
refs:
  - "server/routes/repos.ts"
  - "scripts/install-claude-action.sh"
  - "ADR-0006 [2]"
  - "#4"
  - "#25"
depends_on: [4]
acceptance:
  - "An operator clicks 'Set up automation' on jwolberg/situation's repo card and the flow completes with no shell step — this is #4's AC 12, which has never been exercised against a real repo"
  - "situation's .github/workflows/claude.yml no longer references secrets.GH_PAT and carries no `gh pr create` post-step"
  - "The GH_PAT repo secret is gone from situation; exactly one secret remains, CLAUDE_CODE_OAUTH_TOKEN"
  - "situation's workflow passes github_token: ${{ github.token }} explicitly (#25), verified by parsing the committed file, not by reading the installer"
  - "A second run of setup on situation commits nothing (idempotency, #4 AC 10) — asserted from the response's `files[].committed`, all false"
  - "#4 AC 12 is marked observed in the ticket, and #4 closes"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Two open threads close with one action.

**#4's AC 12 is unproven.** "Setup runs end-to-end from the browser with no shell
step" is implemented — route, sealed-box secrets, templates, and the card button all
merged — but it has never run against a real repository, because doing so writes
commits and a secret to somebody's repo. #22 refused to close AC 13 on a fake; this
deserves the same bar.

**`jwolberg/situation` still runs the model ADR-0006 [2] deleted.** Observed
2026-07-10:

| Repo | Secrets | `secrets.GH_PAT` in workflow | `gh pr create` post-step |
|---|---|---|---|
| `jwolberg/dispatch` | `CLAUDE_CODE_OAUTH_TOKEN` | no | no |
| `jwolberg/situation` | `CLAUDE_CODE_OAUTH_TOKEN`, **`GH_PAT`** | **yes (×2)** | **yes** |

That `GH_PAT` is a live credential with a blast radius the App path does not have:
it can write to every repo the PAT can reach. It exists only to feed a post-step that
no longer needs to exist, because Dispatch opens the pull request now.

Re-onboarding `situation` through `POST /api/repos/:id/setup` writes the corrected
workflow, sets one secret, and — per the installer's own logic, which the route
mirrors — leaves no `GH_PAT` behind. The setup route does **not** currently delete
`GH_PAT`; only `install-claude-action.sh` does. Decide which: either the route deletes
it too (symmetry, and the reason it deletes `ANTHROPIC_API_KEY` already), or this
ticket removes it by hand and says so.

## Action needed

**Human.** It writes commits and a repository secret to a real repo. It also runs a
real `claude-code-action` afterwards if you want to see the loop close end to end:
file an `@claude` issue, watch Claude push a branch, and watch Dispatch's poller open
the pull request — the first time that whole path runs unassisted.

## Watch for

The poller only opens a PR while Dispatch is **running**. If nothing appears, check
that the server is up before concluding the discriminator is wrong. The
discriminator itself is sampled and fixtured (`server/poller/__fixtures__/`); do not
re-derive it from documentation.
