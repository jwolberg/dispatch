---
title: A PR's review artifact lives on the PR head, not the default branch
date: 2026-07-12
tags: [review-gate, providers, readFile, ship-gate, T2-5]
anchor: LRN-review-head-ref
---

## The gotcha

The Ship gate (#15) reads a PR's code-review artifact through the provider seam's
`readFile(repo, path)`. That call resolves content on the **default branch** (it
passed no `ref`). But an artifact for an *open* PR is committed on the **PR's own
head branch** and is not on the default branch until the PR merges. So the gate
could never see a real review and would refuse **every** Ship — fail-closed, but
permanently closed.

The #15 tests didn't catch it: their fake `readFile` returned the artifact
regardless of ref, so the default-branch-vs-head bug was invisible until #34
wired up real emission.

## The fix (#34)

- `readFile`/`listFiles` take an optional `ref` (branch/tag/sha); both adapters
  thread it through. Existing callers (spec-chat #27) pass nothing and keep
  reading the default branch.
- `fetchReview` reads at the **PR head ref**. It *lists* the review dir and reads
  each `<sha>.md`, because the CI commits the artifact **on top of** the code —
  which shifts the head SHA, yet that commit's tree still contains the file. The
  newest `generated:` artifact wins; the check gate stops a stale review from
  shipping (a fresh code push leaves its review check pending).

## The rule

When you read a file that belongs to an **open PR's state** (a review artifact, a
generated report, anything CI writes onto the branch), read it at the **PR head
ref**, never the default branch. Default-branch reads only see merged state. And
remember that committing a file onto a branch **moves the head** — anchor by
listing the directory or by a stable name, not by the pre-commit SHA.

## Still unverified

`claude-code-action`'s CI-runtime behavior (that it writes the three files, that
the commit step pushes) is NOT exercised by the test suite — it needs one real
onboarded-repo PR. See [[verify-external-formats-before-encoding-them]] for why
we don't trust the un-sampled path.
