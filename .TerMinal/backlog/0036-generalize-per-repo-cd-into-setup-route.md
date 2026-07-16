---
id: 36
title: "Generalize per-repo CD into the setup route (ADR-0008 Phase 2)"
status: open
priority: medium
horizon: next
hitl: false
type: feature
source: "ADR-0008 + jwolberg/cohort-bot PR #10"
created: 2026-07-13
updated: 2026-07-13
prs: []
refs:
  - "ADR-0008"
  - "jwolberg/cohort-bot#10"
depends_on: [33]
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

`jwolberg/cohort-bot` now has a real, working CD pipeline, hand-built as the
"one real deploy run" ADR-0008 §4 said must exist before designing the
generalized per-repo abstraction:

- `.github/workflows/deploy.yml` — on push to `main`, `gcloud builds submit
  --config deploy/cloudbuild.yaml` against the target GCP project.
- Keyless auth via Workload Identity Federation (ADR-0008 §3): a WIF pool +
  provider in the target project, scoped to `assertion.repository` and
  `assertion.ref` (this exact repo, `refs/heads/main` only), bound to a
  narrowly-scoped deploy service account (`cloudbuild.builds.editor` +
  staging-bucket object access + `serviceusage.serviceUsageConsumer` — see the
  gotcha below).
- Human gate on production (ADR-0008 §6): a `production` GitHub Environment
  with a required reviewer. Merging to `main` opens the door; the deploy job
  waits at `status: waiting` until approved (verified live via
  `gh api repos/<owner>/<repo>/actions/runs/<id>/pending_deployments`).

This ticket is ADR-0008 Phase 2: take this pattern and make it a real Dispatch
feature instead of a hand-authored one-off.

## Acceptance criteria

- A per-repo deploy target (GCP project, region, Cloud Build config path,
  substitutions) is stored on the `repos` row, entered through the UI (mirrors
  the existing "Set up automation" flow in `RepoCard.tsx`).
- The setup route (`server/setup/`) can commit a real `deploy.yml` to the
  target repo from a template (mirrors `templatesFor()` / `embedded.ts`),
  parameterized by the stored deploy target — not hand-edited per repo.
- WIF pool/provider/service-account provisioning is either automated (if a
  safe, minimal-permission API path exists) or reduced to a documented,
  copy-pasteable runbook — do not silently re-invent a long-lived credential
  (`GCP_SA_KEY`) as the "simple" path; ADR-0006/0008 already rejected that
  shape for GitHub auth and the same reasoning applies here.
- The production-gate Environment (required reviewers) is created/verified by
  the same flow, not left as a manual step.
- Dispatch records which workflow is the deploy workflow per repo (this is
  also what #33 needs to stop reading "any successful main-branch run" as
  Deployed — the two tickets should land together or in the right order).

## Known gotcha to carry forward

`gcloud builds submit` from a minimal-permission service account fails with:

> The user is forbidden from accessing the bucket [PROJECT_cloudbuild].
> ... or if the user has the "serviceusage.services.use" permission.

despite the SA already having `cloudbuild.builds.editor` and object-level
access on the staging bucket. The real fix is `roles/serviceusage.serviceUsageConsumer`
(bundles `serviceusage.services.use`) — a separate permission Cloud Build needs
to attribute the source-upload API usage to the project. Worth a
`docs/learnings/` entry regardless of when this ticket is picked up.

## Depends on

- #33 (precise deploy-run identification) — this feature is what makes #33's
  "per-repo, explicit" identification possible without a name heuristic.
