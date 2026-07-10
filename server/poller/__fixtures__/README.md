# Sampled fixtures — how Claude's branch is told apart from a human's

Ticket **#4 AC 9** forbids inferring this from documentation. These two files are
raw `GET /repos/{owner}/{repo}/commits/{ref}` responses, trimmed to the identity
fields, captured on **2026-07-10**.

| File | Provenance |
|---|---|
| `claude-branch-tip.json` | `jwolberg/dispatch`, branch `claude/issue-20-20260710-0438`, pushed by [run 29069518765](https://github.com/jwolberg/dispatch/actions/runs/29069518765) — a real `claude-code-action` run under the post-#24/#25 workflow. Issue #20. |
| `human-branch-tip.json` | `jwolberg/dispatch`, branch `feat/24-onboard-claude-workflow`, tip pushed by a human over SSH. |

Both branches were deleted after capture; the shas remain resolvable.

## What the sample actually says

```
                     Claude's tip                        A human's tip
commit.author.name   "claude[bot]"                       "Jay Wolberg"
commit.author.email  41898282+claude[bot]@users.no...    jmwolberg@gmail.com
author.login         "github-actions[bot]"   ← NOT claude[bot]
author.type          "Bot"                               "User"
author.id            41898282                            7315948
```

**Three ways to get this wrong**, each of which reads plausibly from the docs:

1. **`author.login === "claude[bot]"` never matches.** GitHub resolves a commit's
   author by email. The noreply address `41898282+claude[bot]@users.noreply.github.com`
   carries the numeric id of `github-actions[bot]` (41898282), so the API reports
   that login — even though the git-level name is `claude[bot]`.
2. **`author.type === "Bot"` alone is too broad.** Dependabot, Renovate, and any
   other Actions-authored commit satisfy it. Opening a pull request from Dependabot's
   branch is exactly the unrecoverable mistake AC 9 exists to prevent.
3. **The commit message carries `Co-authored-by: <the issue author>`** — here,
   `jwolberg`. Anything keying off trailers, or off "was a human involved", says yes.

## The discriminator

Both conditions, together:

```ts
tip.author?.type === "Bot" && tip.commit.author.name === "claude[bot]"
```

`author.type` is resolved by GitHub from the commit email and cannot be set by the
git client alone; `commit.author.name` is the only field that distinguishes Claude
from every other Actions bot. Requiring both means a human branch fails on the
first, and Dependabot fails on the second.

A human with push access could forge both by setting `user.name` and a matching
noreply `user.email`. That is not a new trust boundary — anyone who can push to the
repo can already push to `claude/issue-N-…` directly.

## Refreshing these

Re-run a real `claude-code-action` and re-capture; do not hand-edit. The branch name
(`claude/issue-<n>-<yyyymmdd>-<hhmm>`) is recorded for context only — matching is done
by `linksToIssue()` on the issue number, never by a branch-name convention.
