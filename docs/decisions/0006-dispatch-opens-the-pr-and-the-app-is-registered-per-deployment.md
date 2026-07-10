---
id: 0006
title: Dispatch opens the PR, and the App is registered per deployment
anchor: ADR-0006
status: accepted
date: 2026-07-09
supersedes:
superseded-by:
---

Closes the approval gate ADR-0002 [4] left open, and settles the App-ownership
question that ticket #2 deferred to a human.

Two decisions, taken together because the second changes what the first costs.

## [1] Context

ADR-0002 [4] costed three ways to give the build a token that can open a pull
request, and refused to pick one:

> **The tradeoff, flagged for explicit approval before #4 executes:** a
> fine-grained `GH_PAT` is scoped to one repo. An App private key can mint tokens
> for *every installation of that App*. […] #4 must not proceed on the assumption
> that "App = more secure."

Separately, ticket #2 recorded that a human must "decide the App's owning
account/org and name" before registration. That framing assumed one App, owned by
us, that Dispatch's users install. **Dispatch is a public repository intended to
be deployed by anyone, for themselves.** There is no "us" to own an App.

Both were settled on 2026-07-09.

## [2] Decision — Dispatch's server opens the pull request

ADR-0002 [4](a). The workflow no longer opens PRs. `claude-code-action` pushes a
branch using the default `GITHUB_TOKEN`; Dispatch's poller notices the branch and
opens the pull request itself, authenticated with its App installation token.

Rejected: writing `APP_PRIVATE_KEY` into every onboarded repo so the workflow can
mint its own token via `actions/create-github-app-token`. It ships fastest, and it
inverts the blast radius — one compromised repo's secrets compromise every repo
the App is installed on. That is strictly worse than the `GH_PAT` it replaces, on
the one axis anybody would check.

Also rejected: letting the run park in `action_required` and having Dispatch
approve it via the API (ADR-0002 [4](b)). It requires *"Allow GitHub Actions to
create and approve pull requests"* to be **on**, which is off on `jwolberg/situation`
and is governed at enterprise → org → repo, so a repo-level fix can be silently
overridden upstream (ADR-0002 [3.1]). Whether a public approve endpoint even
covers non-fork PRs was never established.

## [3] Why this is cleaner than ADR-0002 [4] realized

The ADR presented (a) as *moving* PR creation out of the workflow. It is closer to
*deleting* it.

`scripts/install-claude-action.sh:41` records the fact:

> PRs: claude-code-action never opens PRs itself — by design it pushes a branch
> and links a "Create PR" page (docs/faq). The workflow below adds a `gh pr create`
> post-step […] authenticated with a fine-grained PAT (GH_PAT) so the PR triggers CI

So the workflow's `gh pr create` post-step (`:136–151`) exists *only* to work around
the anti-recursion rule, and `GH_PAT` exists only to feed it. Delete the post-step
and the secret has no remaining caller. Pushing a branch was never the blocked
operation — `contents: write` covers it — only PR *creation* is.

This kills both of ADR-0002 [3.1]'s failure modes at once:

| Failure mode | Why it stops happening |
|---|---|
| PR opens, `pull_request` run parks in `action_required` | The PR is authored by an App installation token, not `GITHUB_TOKEN` |
| 403 — Actions not permitted to create or approve pull requests | Actions never attempts to create a pull request |

The second is the one that actually bites (`can_approve_pull_request_reviews: false`
on `situation`), and it stops being reachable rather than being detected and
reported. #5's canary still asserts on run *status* — see ADR-0002 [3] — but it now
has one less way to fail.

Net: **no App credential is written into any user repository.** `POST /api/repos/:id/setup`
(#4) shrinks to writing exactly one secret, the Claude auth token, whose blast
radius is the operator's own Anthropic account — which onboarding already accepts
today.

## [4] What it costs

**The poller becomes load-bearing for correctness, not just for display.** A branch
becomes a pull request only when Dispatch is running. If it is down, branches
accumulate unlinked and the poller catches up on its next cycle. This adds no new
*availability* requirement — Dispatch must already be up to render the board — but
it converts a missed poll from "the board is stale" into "the build never
proceeds." Say so in the runbook.

**New provider surface.** `server/providers/github.ts` today exposes `createIssue`,
`postComment`, `mergePR`, `getWorkflowRuns`, and the read path. It has neither
`createPullRequest` nor any branch listing. Both must land behind the seam, with a
GitLab counterpart, before #4 can work.

**Identifying Claude's branch is an open sub-problem.** `linkage.ts`'s
`linksToIssue()` already matches a branch to an issue by digit-bounded number, so
`claude/issue-7-…` → #7 needs no new regex and no branch-name convention. But
"branch that links to an open `dispatch`-labeled issue and has no open PR" also
matches a *human* branch named `fix-7`, and opening a PR from someone's
work-in-progress is not a recoverable mistake.

The likely discriminator is the branch tip's committer identity (the action commits
as `github-actions[bot]`), but **this has not been observed** and must be sampled
from a real `claude-code-action` run before it is encoded. Do not infer the branch
name format from the action's documentation; `steps.claude.outputs.branch_name`
proves the workflow knows the name from the inside, which is not the same as the
poller recognizing it from the outside.

## [5] Decision — the App is registered per deployment, and has no name in this repo

There is no central Dispatch GitHub App. Each operator who deploys Dispatch
registers their own, from their own instance, at first run.

This is what GitHub's [manifest flow] is for. Dispatch serves a form that POSTs a
manifest to `github.com/settings/apps/new` (optionally `?org=<org>`, so the operator
chooses personal or org ownership in GitHub's own UI, not ours); GitHub redirects
back to `/api/github/callback?code=…`; Dispatch exchanges the code **once** for the
App id, client id, client secret, private key, and webhook secret.

> **Corrected 2026-07-09 (SES-0002, while building #2).** The `?org=<org>`
> parameter above **does not exist.** Ownership is chosen by the *path* the form
> POSTs to, not by a query parameter:
>
> | Owner | Form action |
> |---|---|
> | Personal account | `https://github.com/settings/apps/new?state=<state>` |
> | Organization | `https://github.com/organizations/<org>/settings/apps/new?state=<state>` |
>
> `state` is the only query parameter, on either path. The rest of this section
> stands — the operator still chooses ownership in GitHub's own UI, and the org
> name is still a field on our setup screen rather than a constant in this repo.
> Verified against GitHub's manifest-flow documentation, and the seven requested
> permission keys were verified against the `app-permissions` schema in GitHub's
> OpenAPI description (`workflows` accepts only `write`; there is no `read`).
>
> Also corrected: the conversion response types `webhook_secret` as **nullable**
> (`POST /app-manifests/{code}/conversions`, required fields `client_id`,
> `client_secret`, `webhook_secret`, `pem`). Dispatch must tolerate a null rather
> than assume a string. And the code is documented as valid for **one hour**;
> single-use is *not* stated anywhere, so `/api/github/callback` must enforce
> one-shot exchange itself rather than rely on GitHub to reject a replay.

Consequences:

- **No App name, client id, or key is committed to this repository.** The name is an
  input on the setup screen, defaulted but editable. #2's "human must decide the
  owning account/org and name" is not a pre-execution gate on the ticket — it is a
  field in the UI the ticket builds.
- **`GITHUB_TOKEN` remains the local-development path**, unchanged, as does all of
  GitLab. Nothing about self-registration makes the env token go away.
- The registration screen is the honest home for the one genuinely
  escalating-cost click in onboarding, and the operator makes it about their own
  account.

[manifest flow]: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest

## [6] The consequence nobody had costed: the private key is now runtime state

Pre-registration let #2 write this acceptance criterion:

> The App private key is read from env or secret manager, never committed and never
> logged.

Self-registration makes it unsatisfiable. The key does not exist when the process
boots; it arrives in an HTTP callback. Dispatch must **write** it somewhere durable.
Three findings follow, and none of them are in any ticket today.

### [6.1] Secret Manager would couple a portable tool to one cloud

Writing the key to GCP Secret Manager needs `roles/secretmanager.admin` on the
runtime service account — `DEPLOY.md` §4 currently grants only `storage.objectAdmin`
on one bucket — and it makes a repo whose whole premise is "anyone can deploy this"
depend on Google. Rejected on those grounds. The key goes in SQLite, where `repos`,
`chats`, and `spend` already live.

### [6.2] SQLite means the key lands in the GCS snapshot, in plaintext

`server/db/snapshot.ts` does `VACUUM INTO` a temp file and uploads the resulting
bytes. The whole database, verbatim. `schema.sql`'s design comment reasons at
length about which tables are **disposable** and which the provider cannot rebuild;
it never contemplates a table that is **confidential**. Those are orthogonal axes,
and #20 only settled the first.

The bucket is not an exposure by itself — `DEPLOY.md:125` creates it with
`--uniform-bucket-level-access --public-access-prevention`, and only the runtime SA
is bound. But `DEPLOY.md:126` enables **object versioning**, deliberately, so "a
corrupt snapshot then stays recoverable." The same property means **a rotated
private key remains readable in an old object version indefinitely.** Key rotation
does not rotate anything until the old versions are also expired.

Whatever #2 does here — encrypt the column at rest under a key held in env, set a
lifecycle rule that expires noncurrent versions, or both — it must be a decision,
not an accident.

### [6.3] `redactSecrets()` is keyed on the environment and would not catch it

`server/lib/redaction.ts` iterates a hardcoded `SECRET_ENV_KEYS` and reads each
value from `process.env`. A private key stored in SQLite is never in `process.env`,
so `safeMessage()` returns it verbatim — into a log line, or an error response body.

#2's "never logged" criterion therefore fails silently unless redaction is inverted:
secrets **register their values** with the redactor when they are loaded, rather
than the redactor going looking for them in the environment. That is a small change
and it is a prerequisite, not a follow-up.

## [7] Consequences for the tickets

- **#2** — amended. Registration is per-deployment via the manifest flow; the App
  name is a UI field. The private-key criterion is replaced by [6.1]–[6.2]:
  persisted in SQLite, encrypted at rest, with a lifecycle rule expiring
  noncurrent object versions.
- **#3** — the credential seam still lands before the source swaps, and it now
  also carries [6.3]'s redactor inversion. *(Corrected 2026-07-09, after this ADR
  was written: [6.3] assigned `redaction.ts` to #2, but #3 is what first holds a
  secret outside `process.env` — a **minted installation token** lives only in
  memory. #3's own "no token is ever logged" criterion fails without the
  inversion, so the fix lands there. #3 also does not depend on #2; see
  SES-0001 [2.2].)*
- **#4** — amended. It no longer writes `APP_CLIENT_ID` / `APP_PRIVATE_KEY`, and no
  longer needs to detect `can_approve_pull_request_reviews`. It gains: delete the
  `gh pr create` post-step from the `claude.yml` template, and add
  `createPullRequest` + branch listing behind the provider seam. Sealed-box
  encryption survives, for the one remaining secret.
- **#5** — unchanged, and slightly likelier to pass. Still asserts on run status,
  never on run presence.

## [8] Evidence: observed versus inferred

**Observed.** `claude-code-action` does not open PRs; the `gh pr create` post-step
does, under `GH_PAT` (`scripts/install-claude-action.sh:41–43,136–151`).
`can_approve_pull_request_reviews: false` on `jwolberg/situation` (ADR-0002 [3.1]).
`snapshot.ts` uploads the unencrypted DB; `DEPLOY.md:126` enables versioning;
`redaction.ts` reads only `process.env`. `github.ts` exposes no PR-creation method.

**Observed 2026-07-10 (was inferred).** That a pull request opened by an *App
installation token* triggers `pull_request` runs without approval. Closed by #22
via `scripts/verify-app-pr-triggers-run.ts`, against App `dispatch-jay`
(installation 145573719) on `jwolberg/cohort-bot`:

| Field | Value |
|---|---|
| `status` | `completed` (never `action_required`) |
| `conclusion` | `success` |
| `event` | `pull_request` |
| `actor` / `triggering_actor` | `dispatch-jay[bot]` |
| run | [`29065952153`](https://github.com/jwolberg/cohort-bot/actions/runs/29065952153) |

The run queued within ~3s of the PR opening, with no approval gate. `actor` and
`triggering_actor` both resolve to the App's bot identity, which is the field that
distinguishes an installation from a PAT — so this observes the App arm directly
rather than re-observing ADR-0002 [5]'s fine-grained PAT. [2]'s deletion of the
`gh pr create` post-step stands, `GH_PAT` stays deleted, and #4 proceeds as written.

The workflow lived only on the PR head branch (`pull_request` reads the workflow
from the head), so the scratch repo's `main` was never modified; the branch and PR
were removed afterward.

**Observed 2026-07-10.** That a repo under an installation polls with a *minted
installation token*, not `GITHUB_TOKEN` (#22 AC 6, `scripts/verify-app-token.ts`).
With `GITHUB_TOKEN` deliberately corrupted, `jwolberg/situation` fetched 16 workflow
runs at a rate-limit ceiling of **6950** — an installation-scoped limit, not a PAT's
5000 — while `octocat/Hello-World` (outside every installation) and the
`env:GITHUB_TOKEN` account both failed with `Bad credentials`.

**Inferred, not observed.** That the branch tip's committer identity distinguishes
Claude's branch from a human's. See [4] — sample it before encoding it.

## [9] Sources

- <https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest>
- <https://docs.github.com/en/actions/concepts/security/github_token>
- <https://cloud.google.com/storage/docs/object-versioning>
- ADR-0002 [3.1], [4], [5]; ADR-0005 [1]
