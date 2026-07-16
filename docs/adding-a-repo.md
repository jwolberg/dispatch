# Adding a repo to Dispatch

Two steps: **track** it in Dispatch, then **enable the build loop** on the repo
so `@claude` tickets actually build. The first is enough to file issues and use
spec chat; the second is what turns an `@claude` ticket into a pull request —
Claude commits to a branch, and Dispatch opens the PR from it (ADR-0006 [2]).

---

## 1. Track the repo (in the Dispatch UI)

Open Dispatch → **Repos**.

- **From discovery (no typing):** the list shows every repo your `GITHUB_TOKEN`
  can access (switch the provider dropdown to GitLab if `GITLAB_TOKEN` is set).
  Use the filter box, then click **Track**.
- **Manual:** paste an `owner/name` path or a full repo URL — including
  self-hosted GitLab URLs — into **Add manually** and click Track. The token is
  validated before the repo is saved.

Once tracked, the card shows the description, a top-level structure summary,
whether a `CLAUDE.md` exists, and a context-freshness timestamp. The board then
includes this repo's tickets; spec chat lets you target it.

> **Existing issues are adopted automatically.** On track (and on every idle
> poll thereafter), Dispatch imports the repo's **open issues** as board tickets
> — you don't have to re-file them through spec chat. This is also how the board
> repopulates after a redeploy wipes the local DB (see `DEPLOY.md` §4): just
> re-track the repo and its open issues return on the next poll. Import is
> idempotent, so re-tracking never duplicates tickets.

> A new card may show **⚠ Tracked, but not onboarded** — that's step 2.

---

## 2. Enable the autonomous build loop on the repo

Each repo needs `anthropics/claude-code-action` so an `@claude` mention triggers a
build. The action commits Claude's work to a branch and **stops** — it does not
open the PR; Dispatch's poller does (ADR-0006 [2]). Pick one path:

### Option A — the **Set up automation** button (no shell)

The repo card's ⚠ flag carries a **Set up automation** button, which calls
`POST /api/repos/:id/setup`. Paste your Claude auth token and Dispatch commits the
workflow, a stack-aware `ci.yml`, and the `{plan,implement,debug}` skills, then
writes the one secret below. Re-running it is idempotent, and the token is held for
the duration of one request and never stored.

**GitHub only** — the button is gated on the repo's provider, and the route returns
`501` for GitLab. Use Option B for GitLab repos.

This is also the only path that stamps `allowed_bots` for you (see below), because
it can resolve your registered App's slug from Dispatch's own database.

### Option B — API-only script (no app install)

The only path for GitLab, and the fallback when you'd rather not use the browser.
Needs a fine-grained PAT **on that repo** with **Contents: write, Workflows: write,
Secrets: write** (make one at
<https://github.com/settings/personal-access-tokens/new>). It does *not* need
`Pull requests: write` — the installer only commits files and sets a secret, and the
workflow it installs never opens a PR.

```bash
CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) \
GH_SETUP_TOKEN=github_pat_xxx \
  ./scripts/install-claude-action.sh <owner>/<repo>
```

Sets **one** secret — your Claude auth token — commits
`.github/workflows/claude.yml`, commits `.claude/skills/{plan,implement,debug}/SKILL.md`,
and commits a CI gate at `.github/workflows/ci.yml` (created only if absent). The
Claude token is read from the macOS keychain item `dispatch-CLAUDE_CODE_OAUTH_TOKEN`
(or `dispatch-ANTHROPIC_API_KEY`), or passed in the environment. `GH_SETUP_TOKEN` is
used by the installer and never written into the repo.

### Not this: `/install-github-app`

Claude Code's own `/install-github-app` installs **Anthropic's** Claude GitHub App
and sets an `ANTHROPIC_API_KEY` secret. It used to be this doc's recommended path,
on the rationale that the app makes Claude's PR commits trigger your CI. ADR-0006
[8] settled that differently: Dispatch's own App installation token opens the PR,
and that is what makes `on: pull_request` CI run. The two paths now fight — the
`ANTHROPIC_API_KEY` it writes outranks `CLAUDE_CODE_OAUTH_TOKEN` in Claude's auth
precedence and silently bills the API, which is exactly the secret Options A and B
delete. Prefer A or B.

> **Corrected 2026-07-10 — `GH_PAT` is gone (ADR-0006 [2], #24).** This section used
> to say the workflow opens the PR itself, via a `gh pr create` post-step
> authenticated with a `GH_PAT` repo secret. It no longer does, and the installer
> now *deletes* a leftover `GH_PAT`.
>
> `claude-code-action` pushes a branch under the repo's own default `GITHUB_TOKEN`,
> and **Dispatch's server opens the pull request** with its GitHub App installation
> token. A PR opened that way triggers `on: pull_request` CI without an approval
> gate — observed directly in #22, not inferred. Writing a `GH_PAT` into every
> onboarded repo handed each of them a token that could write to every repo that PAT
> could reach; the App path has no such blast radius.
>
> Two consequences worth knowing:
>
> - The workflow must pass `github_token: ${{ github.token }}` **explicitly**. That
>   input has no default: omit it and the action tries to mint a token from
>   *Anthropic's* Claude GitHub App and 401s (#25).
> - **Dispatch must be running** for a build to get past the branch, since the poller
>   is what opens the pull request. That adds no new availability requirement — it has
>   to be up to render the board anyway — but it turns a missed poll from "the board is
>   stale" into "the build did not continue."

> **The CI gate (`ci.yml`) — stack-aware:** runs on every PR so its checks move
> the board **Building → Ready to test → Blocked**. The installer detects the
> repo's stack and commits the matching template:
> - **Node** (`package.json`): `lint` / `test` / `build` npm scripts, each
>   `--if-present` (no-op when a script is missing).
> - **Python** (`requirements.txt` / `pyproject.toml` / `setup.py`):
>   `pip install` of whatever's declared, then `ruff`/`flake8` and `pytest` only
>   when a linter/tests are present.
> - **Unknown stack:** skipped (a Node gate hard-fails on a non-Node repo at the
>   install step and would block every PR — better to add one manually).
>
> Created only when the repo has no `ci.yml`, so it never clobbers existing CI.
> Triggers on the PRs Dispatch opens, because those come from an App installation
> token, not from the workflow's `GITHUB_TOKEN` (ADR-0006 [2]).

> **The deploy gate (`deploy.yml`) — optional, off by default.** Pass
> `INSTALL_DEPLOY_GATE=1` to also install the verify-before-production gate from
> the architecture diagram. On every **merge to `main`** it runs two jobs:
> **`staging`** (deploy to the persistent **staging** environment, then `test:smoke`
> / `test:e2e`) and **`production`** (`needs: staging`), which deploys only after
> staging's tests pass **and** a manual approval. Every deploy/test step is
> `--if-present`, so it's a safe no-op until you define the `deploy:staging`,
> `test:smoke`/`test:e2e`, and `deploy:production` npm scripts. Created only if
> absent. **One-time GitHub setup:** under **Settings → Environments**, create
> `staging` and `production`, and add **Required reviewers** to `production` to arm
> the 🔒 approval gate (without it, production deploys straight after staging).
>
> ```bash
> INSTALL_DEPLOY_GATE=1 GH_SETUP_TOKEN=github_pat_xxx \
>   ./scripts/install-claude-action.sh <owner>/<repo>
> ```
>
> Board mapping (future): Shipped → **In staging** → **Released**.

> **Why the skills are committed:** the console's **Plan / Implement / Debug**
> buttons (on a ticket) drive Claude by posting an `@claude` comment that runs in
> CI. `claude-code-action` only loads skills committed to the **target repo** —
> never your laptop's `~/.claude`, and never anything that's `.gitignore`d. The
> templates live in `scripts/repo-skills/` and are tuned for CI (plan → posts a
> plan comment; implement → opens a PR with `Fixes #N`; debug → pushes a fix to
> the PR). Without them the buttons still work — Claude follows the prompt text —
> but it won't run them as named skills. (`debug` also ships bundled with Claude
> Code; the committed copy just tunes it to the PR flow.)

> **Note:** check-driven board states work because **Dispatch** opens the pull
> request with its App installation token, and GitHub runs `on: pull_request` CI on
> an App-authored PR without an approval gate (#22 observed this; ADR-0006 [8]).
>
> The anti-recursion rule still applies to the *workflow's* own token: were the
> workflow to open the PR under the default `GITHUB_TOKEN`, CI would not trigger and
> the board would never reach **Ready to test**. That is precisely why the workflow
> no longer opens PRs at all. Its `GITHUB_TOKEN` only pushes the branch, which was
> never the blocked operation.

Option A re-checks and clears the automation warning itself. After Option B, click
**Refresh context** on the repo card to clear it.

---

## 3. (Optional) Add a `CLAUDE.md`

A root `CLAUDE.md` (stack, conventions, test/build commands, layout) is injected
into spec chats and read by Claude on every build run — it sharpens both. Adding
one also clears the "○ no CLAUDE.md" note on the card.

---

## Verify it works

1. File a ticket from spec chat (or open an issue containing `@claude …`).
2. The card moves **Queued → Building** within ~30s as the Action runs.
3. Claude commits to a branch; on its next poll Dispatch opens the PR from that
   branch, referencing the issue (`Fixes #N`). Test via the **Preview** button,
   **Steer** with an `@claude` comment if needed, then **Ship**.

## Untracking

Click **Untrack** on the card (confirmation required). This removes the repo,
its tickets, and chats from Dispatch's local store only — nothing on GitHub/GitLab
changes.
