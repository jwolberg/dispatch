---
title: An assumed mechanism is a bug that typechecks — three of them in one day
date: 2026-07-10
tags: [github, sqlite, process, testing, adr]
anchor: LRN-assumed-mechanisms
---

## The finding

In one session, three separate mechanisms behaved differently from what the prose
said. Each was written into an accepted ADR, a ticket, or a shipped file. Each
compiled, typechecked, and passed the suite. Each was wrong.

### 1. "Uses the default `GITHUB_TOKEN`" does not mean "omit the input" (#25)

ADR-0006 [2] said `claude-code-action` *"pushes a branch using the default
`GITHUB_TOKEN`"*. #24 implemented that by **leaving the input out**. Every run then
failed in 27 seconds:

```
App token exchange failed: 401 Unauthorized -
Claude Code is not installed on this repository.
```

The action's own `action.yml` settles it in three lines:

```yaml
github_token:
  required: false
  description: GitHub token with repo and pull request permissions
               (optional if using GitHub App)
```

**No `default:`.** Omitting it opts the workflow into a token exchange against
*Anthropic's* Claude GitHub App — a third App, unrelated to the one the ADR registers.
`jwolberg/situation` never hit this because its older workflow passed
`github_token: ${{ secrets.GH_PAT }}`; deleting `GH_PAT` removed the token *and*
silently enrolled the workflow in an App nobody had installed. The fix was one line:
`github_token: ${{ github.token }}`.

### 2. `NULL` defeats a SQLite `UNIQUE` index (#23)

`repos` declared `UNIQUE (provider, host, path)`. GitHub repos always carry
`host = NULL`, and **SQLite treats every `NULL` as distinct inside a `UNIQUE` index**.
The constraint never fired for them. Every click of *Track* appended another row; the
route returned `201` each time, so nothing signalled a problem.

```sql
CREATE TABLE t(a TEXT, b TEXT, c TEXT, UNIQUE(a,b,c));
INSERT INTO t VALUES('github', NULL, 'x/y');  -- ok
INSERT INTO t VALUES('github', NULL, 'x/y');  -- ok  ← should have failed
INSERT INTO t VALUES('github', '',   'x/y');  -- ok
INSERT INTO t VALUES('github', '',   'x/y');  -- UNIQUE constraint failed
```

Only the empty-string pair collides. GitLab repos, which carry a non-null host, were
always deduped — which is why it hid. Fixed with an expression index on
`COALESCE(host, '')`.

### 3. The obvious identity check would never have fired (#4 AC 9)

To open a pull request for Claude's branch and never for a human's, the poller needs
to identify Claude's commits. The documentation-shaped rule is
`author.login === "claude[bot]"`. Sampled from a real run, it **never matches**:

| | Claude's tip | A human's tip |
|---|---|---|
| `commit.author.name` | `claude[bot]` | `Jay Wolberg` |
| `author.login` | **`github-actions[bot]`** | `jwolberg` |
| `author.type` | `Bot` | `User` |

GitHub resolves a commit's author *by email*, and the noreply address
`41898282+claude[bot]@users.noreply.github.com` carries `github-actions[bot]`'s numeric
id. Meanwhile `author.type === "Bot"` alone also matches Dependabot, and the commit
message carries `Co-authored-by: <the issue author>`, so any "was a human involved"
check says yes. The real rule needs two fields together.

## Why it matters

Opening a pull request from somebody's work-in-progress branch is not recoverable.
Neither is billing the metered API for months because a stale `ANTHROPIC_API_KEY`
outranks an OAuth token. These are not the class of bug a type system or a green suite
catches, because **the code does exactly what it says** — the sentence it was written
from was false.

The tell is always the same: a mechanism described in prose, in a doc written by
someone who did not run it.

## How to apply

- **Read the dependency's own manifest, not its README.** `action.yml`, the OpenAPI
  description, the schema, the type signature. One `gh api` call would have shown
  `github_token` has no `default:`.
- **"The default X" never means "omit the argument."** Name it.
- **`NULL` is not a value.** Any `UNIQUE`, `GROUP BY`, `IN`, or `=` over a nullable
  column needs `COALESCE` or an explicit `IS NULL`, and a test with a real `NULL` in it.
- **Write the acceptance criterion that forbids inference.** #4's AC 9 —
  *"the discriminator is sampled from a real run and cited in a test fixture, never
  inferred from documentation"* — is what surfaced #25. The forced run failed before it
  could push a branch, and the failure *was* the finding. That criterion paid for itself
  before a line of its own ticket was written.
- **Turn the sample into a fixture, and replay it in the adapter's tests.** Not a
  paraphrase of the sample — the raw payload. See `server/poller/__fixtures__/README.md`,
  which records the three rules the sample kills so nobody re-derives them.
- **An unexercised guard is not a guard.** After adding `check:templates`, the check was
  proven by mutating a template and watching it exit 1. After adding the poller's
  discriminator, the pre-existing fixtures turned out to lack `default_branch`, so the
  new code was never reached and a broken integration would have passed green.

## See also

- [[verify-external-formats-before-encoding-them]] — the same lesson for *formats*
  (branch names, body boilerplate, ID shapes). This entry extends it to **mechanisms**:
  defaults, constraints, and resolved identities.
- ADR-0006 [4] and [8] — "sample it, do not infer it", and the arm that was inferred for
  a day before #22 observed it. That one held. These three did not.
