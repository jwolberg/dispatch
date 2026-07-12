---
title: Merge stacked PRs bottom-up to main, or the stack tangles
date: 2026-07-12
tags: [git, stacked-mr, workflow, merge]
anchor: LRN-stack-merge-order
---

## What went wrong

A stack of three PRs was built — #45 (feat/13→main), #46 (feat/14→feat/13),
#47 (feat/15→feat/14). Instead of merging **bottom-up to main**, the top two were
merged into their **intermediate bases** (#46 into feat/13, #47 into feat/14).
Result: `main` had only the pre-stack code, `#45` carried #13+#14, and **#15's
code was stranded in feat/14** with no open PR pointing at main. Recovered by
opening a single consolidation PR from the stack tip (`feat/15 → main`, #48),
which contained all three cleanly, then closing the redundant #45.

Separately, any branch cut **before** a dependency merged to main conflicts once
that dependency lands (here: #11 merged, then the Tier 2 branches — built off the
older main — conflicted on the files #11 also touched: `CardDetail.tsx`,
`api/tickets.ts`, `server/index.ts`, and the shared `implementation-notes.md`
log). The fix is mechanical: merge the updated `main` into the feature branch,
resolve, re-verify.

## The rules

1. **Stacked PRs merge bottom-up to `main`.** Merge #45 (→main) first, then #46,
   then #47 — never a middle/top PR into its intermediate base. Merging into an
   intermediate base strands everything above it.
2. If the stack is already tangled, **open one consolidation PR from the stack
   tip to `main`** (it contains the union) and close the redundant members.
3. Expect a **conflict when a dependency merges to main after you branched** —
   `git merge origin/main`, resolve, `npm run verify`. Common victims: files the
   dependency also edited, and the shared `implementation-notes.md` log (both
   branches append at the top). If the log conflicts get old, per-ticket note
   files would remove that class of conflict.
