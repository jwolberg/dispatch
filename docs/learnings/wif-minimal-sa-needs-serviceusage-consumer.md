---
title: A minimal Workload-Identity service account needs serviceusage.serviceUsageConsumer, not just the obvious roles
date: 2026-07-13
tags: [gcp, cloud-build, workload-identity-federation, ci]
anchor: LRN-wif-minimal-sa-serviceusage
---

## [1] The finding

Building keyless CD for `jwolberg/cohort-bot` (ADR-0008's design, applied for
real): a GitHub Actions workflow authenticates via WIF to a deploy service
account scoped to exactly what `gcloud builds submit --config
deploy/cloudbuild.yaml` needs — `roles/cloudbuild.builds.editor` to submit the
build, plus `roles/storage.objectAdmin` on the Cloud Build staging bucket
(`gs://<project>_cloudbuild`) so the local-source tarball upload has somewhere
to write. That looked complete: those are the two operations the command
actually performs (create a build, upload source).

It failed anyway, on the very first live run:

```
ERROR: (gcloud.builds.submit) The user is forbidden from accessing the bucket
[cohort-bot-1_cloudbuild]. Please check your organization's policy or if the
user has the "serviceusage.services.use" permission.
```

The error text names the bucket, which reads like an object-ACL problem — it
isn't. `serviceusage.services.use` is a separate, easy-to-miss permission:
it's what lets the calling identity attribute the underlying Cloud Storage API
call's usage/billing to the project, independent of whatever object-level
grant it already has. Neither `roles/cloudbuild.builds.editor` nor
`roles/storage.objectAdmin` includes it (verified directly —
`gcloud iam roles describe roles/cloudbuild.builds.editor
--format="value(includedPermissions)"` has no `serviceusage.*` entry at all).
The fix: grant `roles/serviceusage.serviceUsageConsumer`, which bundles it.

## [2] Why it's easy to miss

The two roles you'd reach for by reading the command's own two operations
(submit a build, upload source) are both necessary but not sufficient — this
third permission isn't tied to *what the identity can do* in any resource ACL
sense, it's tied to *whether the identity is allowed to consume billed APIs on
this project at all*. Broad roles (Editor, Owner) carry it silently, which is
exactly why a hand-rolled minimal-permission SA is the case that surfaces it:
nobody notices until they deliberately narrow the grant. Same shape as
[[LRN-assumed-mechanisms]]/`docs/learnings/assumed-mechanisms-fail-under-observation.md`
— a mechanism assumed to be "these two roles are what the docs list for this
command" turned out to need a third permission by the same underlying API
family (`serviceusage.googleapis.com`), which the primary interaction (`build`,
`storage`) doesn't advertise as a dependency anywhere obvious.

## [3] How to apply

Any future minimal-permission service account built for `gcloud builds
submit` (or likely other `gcloud` commands that upload local source) needs
`roles/serviceusage.serviceUsageConsumer` alongside the operation-specific
roles — don't infer completeness from "the command only does two things."
Relevant to ticket #36 (generalizing this pattern into Dispatch's setup
route): whatever provisions the deploy service account should grant this role
by default, not leave it to be rediscovered per repo.
