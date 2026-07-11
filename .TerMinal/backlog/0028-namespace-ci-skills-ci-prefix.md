---
id: 28
title: "Namespace Dispatch CI skills as ci-plan/ci-implement/ci-debug so they coexist with repos' interactive plan/implement/debug"
status: in-progress
priority: high
horizon: now
hitl: false
type: bug
source: feedback
created: 2026-07-10
updated: 2026-07-11
prs:
  - "https://github.com/jwolberg/dispatch/pull/36"
refs: []
depends_on: []
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Dispatch provisions three CI skills into every target repo at
`.claude/skills/{plan,implement,debug}/SKILL.md` (`server/setup/templates.ts`).
Those names collide with the interactive `plan`/`implement`/`debug` skills that
repos like cohort-bot already carry. Because `.claude/` is gitignored in those
repos, a provisioning write silently overwrites the repo's interactive versions
in the working tree — observed loading cohort-bot on the production console.

Fix: namespace Dispatch's CI variants under a `ci-` prefix
(`ci-plan`/`ci-implement`/`ci-debug`) so the two sets coexist. Dispatch stops
writing to the bare `plan`/`implement`/`debug` paths entirely, leaving each
repo's interactive skills untouched. This is namespacing, not migration — no
cleanup of already-provisioned repos is required, and the repos' own interactive
skills are deliberately kept.

## Acceptance criteria

- Source of truth renamed: `scripts/repo-skills/{plan,implement,debug}/` →
  `scripts/repo-skills/ci-{plan,implement,debug}/`, and each `SKILL.md`
  `name:` frontmatter updated to match its new directory.
- `server/setup/templates.ts` deploys skills to
  `.claude/skills/ci-<skill>/SKILL.md` (the `SKILLS` list + commit path), and
  never writes the bare `plan`/`implement`/`debug` paths.
- `server/lib/skills.ts` `SkillId`, `SKILLS`, and every `skillPrompt` body name
  the `ci-*` skill (`use the **ci-plan** skill`, etc.) so console buttons stay
  in lockstep with the deployed skill names.
- `server/setup/embedded.ts` regenerated via `npm run embed:templates`; the
  `check:templates` gate passes (embedded == on-disk).
- `scripts/repo-ci/claude.yml` names the three `ci-*` skills explicitly in
  `claude_args`' `--append-system-prompt` so mention-mode CI stays stable after
  the rename; the change flows through the embedded copy and Dispatch's own
  `.github/workflows/claude.yml`.
- Tests updated to assert the `ci-*` deployed paths
  (`server/routes/setup.test.ts`) and `ci-*` skill ids
  (any `server/lib/skills*.test.ts`); a test asserts Dispatch no longer writes
  the bare `plan`/`implement`/`debug` skill paths.
- `npm run verify` (typecheck → seam guard → tests) is green.

## Design notes

- Deployment pipeline already exists; no new setup script is needed. The seam
  is: `scripts/repo-skills/` + `scripts/repo-ci/` (source) →
  `npm run embed:templates` bakes into `server/setup/embedded.ts` →
  `server/setup/templates.ts` commits into the target repo. `check:templates`
  fails CI if source and embedded drift.
- Console invokes skills at runtime via prose `@claude use the **<name>** skill`
  comments (`server/lib/skills.ts`), matched against the deployed skill's
  `name:` frontmatter — so the rename must move through `skills.ts` in lockstep
  or the buttons post prompts naming a skill that no longer exists.
- `install-claude-action.sh` copies `repo-ci/*.yml` but not the skills, so it
  only needs attention if the `claude.yml` `--append-system-prompt` change
  affects it (it reads the same source file, so it inherits the change).
- Grep guard for stragglers before verify:
  `git grep -nE 'repo-skills/(plan|implement|debug)|skills/(plan|implement|debug)/SKILL'`.

## Staged plan

1. **RED** — update `server/routes/setup.test.ts` and skills tests to expect
   `ci-*` paths/ids; confirm they fail against current code.
2. Rename `scripts/repo-skills/` dirs + `name:` frontmatter.
3. Wire `server/lib/skills.ts` and `server/setup/templates.ts` to `ci-*`.
4. Update `scripts/repo-ci/claude.yml` `--append-system-prompt`.
5. `npm run embed:templates` to regenerate `server/setup/embedded.ts`.
6. `npm run verify` → green. Grep for stragglers.
