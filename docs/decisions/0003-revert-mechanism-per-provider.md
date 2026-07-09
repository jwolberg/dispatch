---
id: 0003
title: Revert mechanism per provider
anchor: ADR-0003
status: accepted
date: 2026-07-09
supersedes:
superseded-by: 0004 (supersedes [7]'s recommendation only; all findings stand)
---

Spike T1-7 (ticket #8), gating #9 (T1-8, one-click revert).

`accepted` on the mechanism: both providers expose a public API, and Dispatch
should call it rather than deep-link. The plan assumed the opposite. Two facts
about GitHub's mutation rest on documentation and schema introspection rather
than an observed call — [6] says exactly which, and #9 must confirm them before
it runs against a user's repository.

## [1] Context

`docs/BUILD_PLAN-v2.md` §T1-7 declines to assert a mechanism:

> GitHub exposes a Revert button in the UI; I do not know that it exposes a
> public API for it, and building a revert by hand through the Git Data API
> without a local checkout is genuinely awkward. So: spike first.

and pre-commits to a fallback:

> deep-link to the provider's own revert affordance, then detect and track the
> resulting revert PR on the board. [...] Ship that if the spike comes back
> negative.

The spike comes back **positive, for both providers**. The fallback is not
needed as the primary path.

This matters more than it looks, because `server/providers/` is a real two-headed
abstraction — `GitHubProvider` and `GitLabProvider` both implement `GitProvider`
(`server/providers/types.ts:166`), and `server/providers/types.ts:1-5` says
everything outside that directory speaks only its types, never Octokit or
Gitbeaker. Whatever revert looks like, it has to fit behind one method signature
that both providers can honestly implement.

## [2] Finding

**Both providers expose a public API for revert. They are not symmetric, and the
asymmetry is the whole design problem.**

| | GitHub | GitLab |
|---|---|---|
| Surface | GraphQL mutation `revertPullRequest` | REST `POST /projects/:id/repository/commits/:sha/revert` |
| REST equivalent | **none** | n/a |
| MR/PR-level call | yes — takes `pullRequestId` | **none** — takes a commit SHA |
| What it produces | **a new pull request** | **a commit, written directly to `branch`** |
| Lands on `main` immediately | no | **yes** |
| Conflict pre-check | not documented | `dry_run: true` |
| Conflict behavior | not documented | `400` + `error_code: "conflict"` |

GitHub's mutation is exactly the web UI's Revert button: it opens a PR containing
the inverse diff and merges nothing. GitLab's endpoint is not the MR Revert
button — that button is a Rails web controller action, not part of `api/v4`. The
public endpoint is commit-level and **commits straight to the branch you name**.

So the naive GitLab implementation — resolve the merged MR's merge commit, POST a
revert with `branch: "main"` — pushes an unreviewed commit to the default branch
of a user's repository. For a product whose Ship button is "merge a reviewed PR,"
that is a different and worse risk class arriving through the same UI affordance.
It would also simply fail on most real projects: the endpoint gates on
`authorize_push_to_branch!`, and `main` is typically protected.

## [3] The correction: GitLab must synthesize the MR

GitLab's endpoint is a primitive, not the feature. Compose the feature from three
documented calls, none of which need a checkout:

1. `POST /projects/:id/repository/commits/:sha/revert` with `dry_run: true`,
   `branch: <default>` — conflict pre-check, commits nothing.
2. `POST /projects/:id/repository/branches` — `{ branch: "revert-mr-<iid>",
   ref: <default> }`.
3. `POST /projects/:id/repository/commits/:sha/revert` with
   `branch: "revert-mr-<iid>"` — the revert commit lands on the new branch.
4. `POST /projects/:id/merge_requests` — open the MR.

Now both providers produce the same artifact: **an open PR/MR that a human
merges.** That collapses cleanly onto one interface method, and — importantly —
it means revert reuses the existing Ship gate rather than bypassing it. Reverting
is shipping something; it should go through the same door.

**Which SHA.** `:sha` is the merged MR's `merge_commit_sha`, *except* when the
project squashes on merge, where the merge produces no merge commit and the SHA
lives in `squash_commit_sha` ("If set, the SHA of the squash commit. Empty until
merged."). Read `squash_commit_sha ?? merge_commit_sha`. Getting this backwards
reverts nothing, or the wrong thing, silently.

**The mainline caveat is benign here, but only by luck.** GitLab hardcodes
first-parent as the mainline — Gitaly's `UserRevertRequest` has no mainline field
at all, and the docs state "the branch you merged to (often `main`) is always the
first parent." For undoing a merge *into* `main` that is precisely the desired
`git revert -m 1`. There is no API path to `-m 2`, and the response gives no
indication a choice was made. Fine for our use case; record it so nobody later
assumes a knob exists.

## [4] The Git Data API path is available, cheap, and a trap

The plan called a hand-built revert through the Git Data API "genuinely awkward."
It is worse than awkward — it is *easy*, which is the problem.

All four steps are documented and take existing SHAs: read the merge commit, take
its first parent's `tree` SHA, `POST /git/commits` with that tree and current HEAD
as parent, `POST /git/refs`. Roughly four calls, **zero bytes of content
uploaded** (`tree.sha` and `base_tree` reference existing objects), nowhere near
any rate limit or the 100,000-entry recursive-tree cap.

But this restores a *tree snapshot*; it does not invert a *patch*. `POST
/git/commits` writes whatever tree SHA you hand it and validates nothing. So if
any commit landed after the merge being undone:

- every unrelated change made since is silently discarded;
- files deleted since are resurrected; files added since disappear;
- **no conflict is ever raised** — `git revert` can fail and demand a human;
  this always "succeeds," green checkmark and all;
- the commit is not marked as a revert, so nothing downstream can recognize it.

It is only correct when nothing has landed since the merge — the one case where
it is also unnecessary. GitHub exposes no server-side patch-application
primitive: `POST /repos/{owner}/{repo}/merges` merges content forward and cannot
subtract a commit, and `/compare` is read-only ("equivalent to running the
`git log BASE...HEAD` command"). Reimplementing `git apply` against the Git Data
API is possible and is not something this product should own.

**Rejected.** Not because it cannot be built, but because it produces a revert
that can quietly destroy work and can never say no.

## [5] Consequences

**#9 (T1-8) — the fallback is demoted to a degradation path, not the design.**

Ticket #9's second acceptance criterion is written around the fallback ("if the
fallback, it deep-links..."). The mechanism is now: call the API, and produce a
PR/MR in both providers. Amended accordingly.

Add one method to `GitProvider` (`server/providers/types.ts`), returning the same
shape both sides:

```ts
revertPR(ref: RepoRef, prNumber: number): Promise<{ number: number; url: string }>
```

- **GitHub** — one `octokit.graphql` call. Resolve the PR's node `id`, then
  `revertPullRequest(input: { pullRequestId })`; read `revertPullRequest.url` off
  the payload.
- **GitLab** — the four calls in [3], via `Commits.revert`, `Branches.create`,
  `MergeRequests.create`.

**No new dependencies.** Verified in this repo: `octokit.graphql` is a function
on the `Octokit` instance already constructed at `server/providers/github.ts:95`
(`@octokit/graphql` is already a transitive dependency), and `@gitbeaker/rest`
already exposes `Commits.revert`, `Branches.create`, and `MergeRequests.create`.

**The deep-link survives as the permission-denied path.** `PullRequest.revertUrl`
is a first-class GraphQL field, so the fallback URL is *derived*, not
string-built. Queried against this repo's merged PR #5, it returns
`https://github.com/jwolberg/dispatch/pull/5/revert`. When the mutation is
refused, send the user there rather than showing an error.

**Interaction with ADR-0002, and it is a good one.** Dispatch's server opens the
revert PR with its own credential — an App installation token after #3, never
`GITHUB_TOKEN`. Per ADR-0002 §[2] that means CI on the revert PR **executes
normally** instead of parking in `action_required`, and ADR-0002 §[3.1]'s "Allow
GitHub Actions to create and approve pull requests" toggle does not apply,
because the creator is not Actions. The revert PR gets a real green/red verdict —
which is the entire point of routing revert through the Ship gate.

**#9's linkage note still holds.** The revert PR body references the original PR,
so `providers/linkage.ts` (T0-3) should resolve it without a new regex. Worth an
explicit test: GitHub's generated body text is not contractual.

**Deferred, deliberately.** GitLab has no MR-level revert, so a revert of an MR
merged with a *merge commit* on a project that later disabled merge commits is an
edge case nobody has asked for. Not modeled.

## [6] Evidence: what is confirmed, what is not

Ticket #8 asked for provider documentation cited by URL. Beyond that, the GitHub
mutation was checked against the **live schema**, not only the docs — the docs
site renders that reference client-side and a plain fetch of
`docs.github.com/en/graphql/reference/pulls` does not contain the mutation body.

**Confirmed by introspecting `api.github.com/graphql` on 2026-07-09:**

```
$ gh api graphql -f query='{ __type(name: "Mutation") { fields { name isDeprecated args { ... } } } }'
{"args":[{"name":"input","type":{"kind":"NON_NULL","ofType":{"kind":"INPUT_OBJECT","name":"RevertPullRequestInput"}}}],
 "isDeprecated":false,"name":"revertPullRequest"}
```

`RevertPullRequestInput`: `pullRequestId: ID!` (required, "The ID of the pull
request to revert"), plus optional `title`, `body`, `draft`, `clientMutationId`.
`RevertPullRequestPayload`: `pullRequest` ("The pull request that was reverted")
and `revertPullRequest` ("The new pull request that reverts the input pull
request"). Not deprecated, not preview-gated.

`PullRequest.revertUrl` / `revertResourcePath` confirmed by query against
`jwolberg/dispatch` PR #5.

**Confirmed by official documentation:**

- Creates a PR, mirrors the UI button —
  <https://github.blog/changelog/2023-01-27-api-for-reverting-a-pull-request/>:
  "Like the revert action on the pull request page in the web, calling this API
  creates a new pull request that reverses the changes made by the merged pull
  request."
- No REST revert endpoint — <https://docs.github.com/en/rest/pulls/pulls>
  (list/create/get/update/commits/files/merge/update-branch; no revert).
- GitLab revert endpoint, params, `dry_run`, `400` + `error_code: conflict|empty`
  — <https://docs.gitlab.com/api/commits/>.
- GitLab mainline is always first parent —
  <https://docs.gitlab.com/user/project/merge_requests/revert_changes/>: "When
  you revert a merge commit, the branch you merged to (often `main`) is always
  the first parent. To revert a merge commit to a different parent, you must
  revert the commit from the command line."
- `merge_commit_sha` / `squash_commit_sha` —
  <https://docs.gitlab.com/api/merge_requests/>: "If set, the SHA of the squash
  commit. Empty until merged."
- GitLab branch creation — <https://docs.gitlab.com/api/branches/>: `POST
  /projects/:id/repository/branches`, `branch` + `ref`.
- Git Data primitives take existing SHAs —
  <https://docs.github.com/en/rest/git/trees> ("Use either `tree.sha` or
  `content` to specify the contents of the entry") and
  <https://docs.github.com/en/rest/git/commits>.
- `/compare` is read-only —
  <https://docs.github.com/en/rest/commits/commits#compare-two-commits>.

**Not documented — do not treat as known, and resolve before #9 writes to a user
repository:**

1. **Which permissions `revertPullRequest` requires**, and whether a GitHub App
   installation token can call it. No official page states scopes for this
   mutation. By analogy to `mergePullRequest` it presumably needs
   `pull_requests: write` and `contents: write`, but that is inference. #3
   (per-repo credential resolution) and #9 both depend on the answer.
2. **What the mutation does when the PR is not merged.** The docs describe it
   only for merged PRs; no page states the enforcement behavior. #9 must not
   rely on the API rejecting it — keep the not-shipped guard in the UI *and* on
   the server, which #9 already requires.
3. **The exact GitLab role needed to create a branch.** The docs do not state it;
   push access is the safe assumption.

Nothing here was verified by an observed mutation call. That was a deliberate
choice — the only repository available to test against is this one, and the test
writes a real PR to it. #9 is gated on human approval before touching a user
repository (ticket #9, "Action needed"); resolving gap 1 belongs to that same
approval step, against a throwaway repo.

## [7] Recommendation

1. Implement `revertPR()` on `GitProvider`. GitHub: `revertPullRequest`. GitLab:
   dry-run, branch, revert, open MR.
2. Both produce a PR/MR. Revert flows through the existing Ship gate. Dispatch
   never pushes to a default branch.
3. Do not use the Git Data API.
4. Keep the deep-link (`revertUrl`) as the permission-denied degradation path.
5. Before #9 executes: confirm the App-token permission for the mutation against
   a throwaway repository, and confirm the unmerged-PR behavior.

No production code changed by this ticket.
