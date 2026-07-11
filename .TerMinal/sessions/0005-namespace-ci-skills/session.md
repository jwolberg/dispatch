---
id: 5
slug: namespace-ci-skills
anchor: SES-0005
title: "#28 — Namespace Dispatch CI skills as ci-plan/ci-implement/ci-debug"
status: active
started: 2026-07-11T20:45:00Z
ended: null
goal: "Namespace Dispatch's CI skills as ci-plan/ci-implement/ci-debug (#28) so they stop silently overwriting target repos' own interactive plan/implement/debug skills in the gitignored .claude/ working tree"
tickets: [28]
branches:
  - fix/28-namespace-ci-skills
prs:
  - "https://github.com/jwolberg/dispatch/pull/36"
related_research: []
related_docs:
  - docs/BUILD_PLAN-v2.md
prior_sessions: [4]
---

## [1] Goal

Fix ticket **#28** (bug, high/now). Dispatch provisions three CI skills into
every onboarded repo at `.claude/skills/{plan,implement,debug}/SKILL.md`. Those
bare names collide with the **interactive** `plan`/`implement`/`debug` skills
repos like cohort-bot already carry — and because `.claude/` is gitignored
there, a provisioning write **silently overwrites the repo's own versions in the
working tree** (observed loading cohort-bot on the production console).

**Done** = Dispatch's CI variants are namespaced under a `ci-` prefix
(`ci-plan`/`ci-implement`/`ci-debug`) end-to-end — source, deployed path, the
`skills.ts` console-button prompts, `claude.yml`'s `--append-system-prompt`, and
the embedded copy — so the two skill sets coexist and Dispatch never writes the
bare paths again. This is **namespacing, not migration**: already-provisioned
repos need no cleanup, and each repo's interactive skills are deliberately kept.

## [2] Context & pointers

### [2.1] Ticket in scope

**#28 — Namespace CI skills** (`open` → in-progress, high/now, no deps). ACs
(verbatim in the ticket):

- Rename source `scripts/repo-skills/{plan,implement,debug}/` →
  `ci-{plan,implement,debug}/`, updating each `SKILL.md` `name:` frontmatter.
- `server/setup/templates.ts` deploys to `.claude/skills/ci-<skill>/SKILL.md`
  and **never** the bare paths.
- `server/lib/skills.ts` — `SkillId`, `SKILLS`, and every `skillPrompt` body
  name the `ci-*` skill, so console buttons stay in lockstep with the deployed
  `name:`.
- `server/setup/embedded.ts` regenerated via `npm run embed:templates`;
  `check:templates` passes (embedded == on-disk).
- `scripts/repo-ci/claude.yml` names the three `ci-*` skills in
  `claude_args`' `--append-system-prompt`; flows through the embedded copy and
  Dispatch's own `.github/workflows/claude.yml`.
- Tests assert the `ci-*` deployed paths (`server/routes/setup.test.ts`) and
  `ci-*` skill ids, plus a test that Dispatch no longer writes the bare paths.
- `npm run verify` green.

### [2.2] The seam (from the ticket's design notes, verified)

Source → embed → deploy:
`scripts/repo-skills/` + `scripts/repo-ci/` (source) → `npm run embed:templates`
bakes into `server/setup/embedded.ts` → `server/setup/templates.ts` commits into
the target repo. `check:templates` fails CI if source and embedded drift.

- Console invokes skills at runtime via prose `@claude use the **<name>** skill`
  comments (`server/lib/skills.ts`), matched against the deployed skill's `name:`
  — so the rename must move through `skills.ts` **in lockstep** or buttons post
  prompts naming a skill that no longer exists.
- `install-claude-action.sh` copies `repo-ci/*.yml` (not the skills), so it
  inherits the `claude.yml` change automatically.
- Current pre-fix state confirmed: `server/routes/setup.test.ts:84-86` asserts
  the bare `.claude/skills/{plan,implement,debug}/SKILL.md` paths;
  `server/setup/embedded.ts` keys are `repo-skills/{plan,implement,debug}/…`.
- **No `server/lib/skills*.test.ts` exists yet** — skill-id coverage will land
  as part of the RED step (either a new test or via setup.test).
- Straggler guard before verify:
  `git grep -nE 'repo-skills/(plan|implement|debug)|skills/(plan|implement|debug)/SKILL'`.

### [2.3] Prior sessions

- **SES-0004** (#5 canary) — just closed (close pending PR #35). Named #28 as the
  recommended next ticket. No carried-over blocker touches this work.

### [2.4] Git/PR state

Branch `main`. This session branches `fix/28-namespace-ci-skills` off it. Open
PRs are all small reconcile/doc chores from SES-0004 (#33 close #5, #34 renumber
#26→#32, #35 session-end) awaiting human merge — none touch the skills seam, so
no conflict. SES-0004's doc still reads `active` on main until #35 merges.

## [3] Checklist

TDD-first, following the ticket's staged plan. Branch `fix/28-namespace-ci-skills`.

### [3.1] RED
- [ ] update `server/routes/setup.test.ts` to expect `.claude/skills/ci-{plan,implement,debug}/SKILL.md` and assert the bare paths are NOT written
- [ ] add/adjust a skill-id test asserting `SKILLS`/`SkillId` are the `ci-*` ids
- [ ] confirm both fail against current code (RED)

### [3.2] Rename source + wire
- [ ] rename `scripts/repo-skills/{plan,implement,debug}/` → `ci-{plan,implement,debug}/`, update each `SKILL.md` `name:`
- [ ] wire `server/lib/skills.ts` — `SkillId`, `SKILLS`, `skillPrompt` bodies → `ci-*`
- [ ] wire `server/setup/templates.ts` — deploy path `ci-<skill>`, remove bare paths
- [ ] update `scripts/repo-ci/claude.yml` `--append-system-prompt` to name the three `ci-*` skills

### [3.3] Regenerate + verify
- [ ] `npm run embed:templates` → regenerate `server/setup/embedded.ts`
- [ ] `git grep` straggler check clean
- [ ] `npm run verify` green (typecheck → seam → templates → tests)
- [ ] open PR + link the PR url into ticket #28 `prs:`

## [4] Log

### [4.1] 2026-07-11 — session opened

Ticket is well-specced (full staged plan + ACs). Pre-fix state verified: the seam
files exist, `setup.test.ts` and `embedded.ts` still carry the bare paths. Fix is
a lockstep rename across source → `skills.ts` → `templates.ts` → `claude.yml` →
embedded, guarded by `check:templates` and a straggler grep. Low-risk namespacing;
no cleanup of already-provisioned repos.

## [5] Decisions

_Session decisions recorded here as they are made._

## [6] Outcomes

_Filled by /session-end._

## [7] Follow-ups

_Filled by /session-end._

## [8] Documentation

_Filled by /session-end._
