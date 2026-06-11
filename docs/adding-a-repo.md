# Adding a repo to Dispatch

Two steps: **track** it in Dispatch, then **enable the build loop** on the repo
so `@claude` tickets actually build. The first is enough to file issues and use
spec chat; the second is what makes Claude autonomously open PRs.

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

> A new card may show **⚠ No Claude automation detected** — that's step 2.

---

## 2. Enable the autonomous build loop on the repo

Each repo needs `anthropics/claude-code-action` so an `@claude` mention triggers
a build that opens a PR. Pick one path:

### Option A — `/install-github-app` (most complete)

In a clone of the repo:

```bash
cd /path/to/repo
claude
/install-github-app
```

Installs the Claude GitHub App, adds the `ANTHROPIC_API_KEY` secret, and commits
the workflow. **Recommended** because the app makes Claude's PR commits trigger
your CI (so the board's check-driven **Ready to test** state and the green-checks
ship gate work).

### Option B — API-only script (no app install)

Needs a fine-grained PAT **on that repo**. Because the workflow now also **opens
PRs** that must trigger CI, the PAT needs **Contents: write, Pull requests: write,
Issues: write, Workflows: write, Secrets: write** (make one at
<https://github.com/settings/personal-access-tokens/new>).

```bash
GH_SETUP_TOKEN=github_pat_xxx \
  ./scripts/install-claude-action.sh <owner>/<repo>
# Optional: a separate, narrower runtime token (Contents/PRs/Issues RW) for the
# workflow's GH_PAT secret; defaults to GH_SETUP_TOKEN if unset:
#   GH_PAT=github_pat_yyy GH_SETUP_TOKEN=github_pat_xxx ./scripts/install-claude-action.sh <owner>/<repo>
```

Sets the `ANTHROPIC_API_KEY` and `GH_PAT` secrets, commits
`.github/workflows/claude.yml`, commits `.claude/skills/{plan,implement,debug}/SKILL.md`,
and commits a CI gate at `.github/workflows/ci.yml` (created only if absent). The
Anthropic key is read from the macOS keychain item `dispatch-ANTHROPIC_API_KEY`
(or pass `ANTHROPIC_API_KEY=...`).

> **PRs open automatically.** `claude-code-action` never opens PRs itself — by
> design it pushes a branch and links a "Create PR" page. The workflow adds a
> `gh pr create` post-step (using `steps.claude.outputs.branch_name`) that opens
> the PR under **`GH_PAT`**. The PAT identity is the key: a PR opened by the
> default `GITHUB_TOKEN` would **not** trigger `on: pull_request` CI (GitHub's
> anti-recursion rule), so the gate below would never run.

> **The CI gate (`ci.yml`):** runs the repo's `lint` / `test` / `build` npm
> scripts on every PR (each step is `--if-present`, so it's a no-op when a script
> is missing). Its checks are what move the board **Building → Ready to test →
> Blocked**. It's created only when the repo has no `ci.yml`, so it never clobbers
> existing CI; adapt it for non-Node stacks. It triggers on the auto-opened PRs
> because those come from `GH_PAT`, not the bot.

> **Why the skills are committed:** the console's **Plan / Implement / Debug**
> buttons (on a ticket) drive Claude by posting an `@claude` comment that runs in
> CI. `claude-code-action` only loads skills committed to the **target repo** —
> never your laptop's `~/.claude`, and never anything that's `.gitignore`d. The
> templates live in `scripts/repo-skills/` and are tuned for CI (plan → posts a
> plan comment; implement → opens a PR with `Fixes #N`; debug → pushes a fix to
> the PR). Without them the buttons still work — Claude follows the prompt text —
> but it won't run them as named skills. (`debug` also ships bundled with Claude
> Code; the committed copy just tunes it to the PR flow.)

> **Note (Option B):** check-driven board states work here because the workflow
> opens PRs under `GH_PAT` (a real identity), so CI triggers on them. If you
> instead point the workflow's token back at the default `GITHUB_TOKEN`, PRs and
> their commits become bot-authored and GitHub won't run CI on them — the board
> would then never reach **Ready to test** on check status. Option A (the GitHub
> App) is an alternative identity that also avoids that.

After either path, click **Refresh context** on the repo card — the automation
warning clears.

---

## 3. (Optional) Add a `CLAUDE.md`

A root `CLAUDE.md` (stack, conventions, test/build commands, layout) is injected
into spec chats and read by Claude on every build run — it sharpens both. Adding
one also clears the "○ no CLAUDE.md" note on the card.

---

## Verify it works

1. File a ticket from spec chat (or open an issue containing `@claude …`).
2. The card moves **Queued → Building** within ~30s as the Action runs.
3. Claude opens a PR referencing the issue (`Fixes #N`); test via the **Preview**
   button, **Steer** with an `@claude` comment if needed, then **Ship**.

## Untracking

Click **Untrack** on the card (confirmation required). This removes the repo,
its tickets, and chats from Dispatch's local store only — nothing on GitHub/GitLab
changes.
