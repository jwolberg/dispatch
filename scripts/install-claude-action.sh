#!/usr/bin/env bash
# Enable anthropics/claude-code-action on a repo via the GitHub API — no app install.
#
# Does the automatable setup steps (the GitHub App is optional; see caveat):
#   1. Sets the Claude auth + GH_PAT repository secrets (gh handles encryption).
#      Prefers a Claude subscription token (CLAUDE_CODE_OAUTH_TOKEN) so builds bill
#      the subscription; falls back to ANTHROPIC_API_KEY (metered API) when absent.
#   2. Commits .github/workflows/claude.yml — triggers builds on @claude mentions and
#      opens a PR (gh pr create post-step) under GH_PAT so the PR triggers CI
#   3. Commits .claude/skills/{plan,implement,debug}/SKILL.md so the web console's
#      Plan/Implement/Debug skill actions run as real skills in CI (claude-code-action
#      only loads skills committed to the repo — never your laptop's ~/.claude).
#   4. Commits .github/workflows/ci.yml — a PR test gate that feeds the board's
#      check states. Stack-aware: detects node (package.json) vs python
#      (requirements.txt/pyproject/setup.py) and installs the matching template;
#      unknown stack → skipped. Created only if absent (won't clobber existing CI).
#   5. (Opt-in, INSTALL_DEPLOY_GATE=1) Commits .github/workflows/deploy.yml — a
#      verify-before-prod gate: merge → deploy staging + smoke/e2e tests → gated
#      production deploy. Created only if absent. Needs the staging/production
#      GitHub Environments (see the echoed note). Off by default.
#
# Requirements:
#   - gh CLI installed
#   - GH_SETUP_TOKEN : a GitHub token for the target repo with
#       fine-grained: Contents=write, Workflows=write, Secrets=write
#       (classic PAT equivalent: `repo` + `workflow` scopes)
#     NOTE: your Dispatch token is Contents=read only — make a new PAT for this.
#   - Claude auth (one of; OAuth preferred):
#       CLAUDE_CODE_OAUTH_TOKEN : Claude subscription token from `claude setup-token`
#         (defaults to macOS keychain item `dispatch-CLAUDE_CODE_OAUTH_TOKEN`).
#         Bills your Claude subscription instead of the metered API. PREFERRED.
#       ANTHROPIC_API_KEY : metered API key, used only when no OAuth token is found
#         (defaults to macOS keychain item `dispatch-ANTHROPIC_API_KEY`).
#
# Usage:
#   GH_SETUP_TOKEN=github_pat_xxx ./scripts/install-claude-action.sh jwolberg/situation
#   # add the optional staging+production deploy gate:
#   GH_SETUP_TOKEN=github_pat_xxx INSTALL_DEPLOY_GATE=1 \
#     ./scripts/install-claude-action.sh jwolberg/situation
#
# PRs: claude-code-action never opens PRs itself — by design it pushes a branch
# and links a "Create PR" page (docs/faq). The workflow below adds a `gh pr create`
# post-step that opens the PR, authenticated with a fine-grained PAT (GH_PAT) so the
# opened PR TRIGGERS your `on: pull_request` CI — a PR opened by the default
# GITHUB_TOKEN would not (GitHub's anti-recursion rule).
set -euo pipefail

REPO="${1:?usage: install-claude-action.sh <owner/repo>}"
# GH_SETUP_TOKEN runs this script (Contents+Workflows+Secrets write). GH_PAT is the
# token the workflow uses at runtime to push branches, comment, and OPEN PRs — it
# needs Contents RW + Pull requests RW + Issues RW. One fine-grained PAT with all of
# Contents/Pull requests/Issues/Workflows/Secrets (RW) can serve as both.
: "${GH_SETUP_TOKEN:?set GH_SETUP_TOKEN to a PAT with Contents+Workflows+Secrets write}"
PAT_FOR_ACTION="${GH_PAT:-$GH_SETUP_TOKEN}"

# Claude auth — prefer a subscription OAuth token (bills the Claude subscription,
# not the metered API); fall back to ANTHROPIC_API_KEY when none is available.
OAUTH="${CLAUDE_CODE_OAUTH_TOKEN:-$(security find-generic-password -s dispatch-CLAUDE_CODE_OAUTH_TOKEN -w 2>/dev/null || true)}"
KEY="${ANTHROPIC_API_KEY:-$(security find-generic-password -s dispatch-ANTHROPIC_API_KEY -w 2>/dev/null || true)}"
if [ -n "$OAUTH" ]; then
  AUTH_MODE="oauth"
elif [ -n "$KEY" ]; then
  AUTH_MODE="apikey"
else
  echo "error: no Claude auth found. Set CLAUDE_CODE_OAUTH_TOKEN (preferred — run" >&2
  echo "  'claude setup-token', then export it or store in keychain dispatch-CLAUDE_CODE_OAUTH_TOKEN)" >&2
  echo "  or set ANTHROPIC_API_KEY (metered API)." >&2
  exit 1
fi

export GH_TOKEN="$GH_SETUP_TOKEN"
command -v gh >/dev/null || { echo "gh CLI not found"; exit 1; }

if [ "$AUTH_MODE" = "oauth" ]; then
  echo "==> Setting CLAUDE_CODE_OAUTH_TOKEN secret on $REPO (Claude subscription auth)"
  printf %s "$OAUTH" | gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo "$REPO"
  # ANTHROPIC_API_KEY outranks the OAuth token in Claude's auth precedence, so a
  # leftover one would keep billing the metered API. Remove it if present.
  if gh secret delete ANTHROPIC_API_KEY --repo "$REPO" 2>/dev/null; then
    echo "    (removed existing ANTHROPIC_API_KEY — it would override the OAuth token)"
  fi
  AUTH_LINE='          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}'
else
  echo "==> Setting ANTHROPIC_API_KEY secret on $REPO (no OAuth token — metered API)"
  printf %s "$KEY" | gh secret set ANTHROPIC_API_KEY --repo "$REPO"
  AUTH_LINE='          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}'
fi

echo "==> Setting GH_PAT secret on $REPO (workflow uses it to open PRs that trigger CI)"
printf %s "$PAT_FOR_ACTION" | gh secret set GH_PAT --repo "$REPO"
[ "$PAT_FOR_ACTION" = "$GH_SETUP_TOKEN" ] && \
  echo "    (reusing GH_SETUP_TOKEN as GH_PAT — set a separate GH_PAT with only Contents/PRs/Issues RW to limit blast radius)"

echo "==> Committing .github/workflows/claude.yml"
WF=".github/workflows/claude.yml"
TMP="$(mktemp)"
cat > "$TMP" <<'YAML'
name: Claude Code
on:
  issues:
    types: [opened]
  issue_comment:
    types: [created]
jobs:
  claude:
    if: |
      (github.event_name == 'issues' && contains(github.event.issue.body, '@claude')) ||
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude'))
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
      actions: read
    steps:
      - uses: actions/checkout@v4
      - uses: anthropics/claude-code-action@v1
        id: claude
        with:
          __CLAUDE_AUTH_INPUT__
          # Use the PAT (not the default GITHUB_TOKEN) so the branch push and the PR
          # opened below come from a real identity — a PR opened by GITHUB_TOKEN would
          # not trigger on: pull_request CI (GitHub anti-recursion).
          github_token: ${{ secrets.GH_PAT }}
          # Do NOT set `prompt:` here. A static prompt forces automation mode, which
          # IGNORES the @claude comment. Omitting it enables interactive (mention)
          # mode: Claude reads the comment, runs it (incl. project skills under
          # .claude/skills/), posts a tracking comment, and pushes a branch.
          claude_args: |
            --append-system-prompt "Implement the change on a branch and commit it; a pull request will be opened automatically from your branch. Reference the issue with 'Fixes #<n>'."
      # claude-code-action pushes a branch + links a PR by design but never opens it.
      # Open it so the on: pull_request CI gate runs. Skipped for plan / no-change runs
      # (empty branch_name) and when a PR for the branch already exists.
      - name: Open PR for Claude's branch
        if: steps.claude.outputs.branch_name != ''
        env:
          GH_TOKEN: ${{ secrets.GH_PAT }}
        run: |
          branch="${{ steps.claude.outputs.branch_name }}"
          if [ -n "$(gh pr list --repo "$GITHUB_REPOSITORY" --head "$branch" --json number --jq '.[].number' 2>/dev/null)" ]; then
            echo "PR already exists for $branch"; exit 0
          fi
          issue="${{ github.event.issue.number }}"
          gh pr create --repo "$GITHUB_REPOSITORY" \
            --head "$branch" \
            --base "${{ github.event.repository.default_branch }}" \
            --title "Claude: implement #${issue}" \
            --body "Fixes #${issue} — automated implementation by @claude; review before merging." \
            || echo "gh pr create skipped (no diff, or PR already open)"
YAML

# Swap the chosen auth input into the workflow. Literal replacement (awk, not sed)
# so AUTH_LINE's ${{ ... }} is emitted verbatim; AUTH_LINE carries its own indent.
awk -v repl="$AUTH_LINE" 'index($0,"__CLAUDE_AUTH_INPUT__"){print repl; next} {print}' "$TMP" > "$TMP.auth" && mv "$TMP.auth" "$TMP"

CONTENT="$(base64 < "$TMP" | tr -d '\n')"
SHA="$(gh api "/repos/$REPO/contents/$WF" --jq .sha 2>/dev/null || true)"

args=(--method PUT "/repos/$REPO/contents/$WF"
  -f "message=Add Claude Code workflow (claude-code-action)"
  -f "content=$CONTENT")
[ -n "$SHA" ] && args+=(-f "sha=$SHA")   # update in place if it already exists

gh api "${args[@]}" --jq '.commit.html_url'
rm -f "$TMP"

echo "==> Committing CI gate .github/workflows/ci.yml (create if absent)"
# A PR test gate so the board's check-driven states work. Create-if-absent so it
# never clobbers a repo's existing CI. The claude.yml above opens PRs with GH_PAT
# (a real identity), so this gate triggers on Claude's PRs.
#
# Stack-aware: a Node gate hard-fails on a Python repo (npm install errors) and
# blocks every PR, so detect the stack from marker files and pick the matching
# template. Unknown stack → skip (better no gate than a gate that can't run).
repo_has() { gh api "/repos/$REPO/contents/$1" --jq .sha >/dev/null 2>&1; }
if repo_has package.json; then
  CI_STACK="node"
elif repo_has requirements.txt || repo_has pyproject.toml || repo_has setup.py; then
  CI_STACK="python"
else
  CI_STACK="unknown"
fi

CI_DEST=".github/workflows/ci.yml"
CI_SRC="$(cd "$(dirname "$0")" && pwd)/repo-ci/ci-$CI_STACK.yml"
if [ "$CI_STACK" = "unknown" ] || [ ! -f "$CI_SRC" ]; then
  echo "    - skipped: couldn't detect a supported stack (node/python). Add a"
  echo "      .github/workflows/ci.yml manually for this repo's stack."
elif gh api "/repos/$REPO/contents/$CI_DEST" --jq .sha >/dev/null 2>&1; then
  echo "    - $CI_DEST already exists — leaving it unchanged"
else
  CI_CONTENT="$(base64 < "$CI_SRC" | tr -d '\n')"
  echo "    - $CI_DEST ($CI_STACK)"
  gh api --method PUT "/repos/$REPO/contents/$CI_DEST" \
    -f "message=Add Dispatch CI gate ($CI_STACK, on PRs)" \
    -f "content=$CI_CONTENT" --jq '.commit.html_url'
fi

echo "==> Deploy gate .github/workflows/deploy.yml (optional)"
# Verify-before-prod gate: merge → deploy staging + smoke/e2e tests → gated
# production deploy. OPT-IN (INSTALL_DEPLOY_GATE=1) because it needs a deploy
# target + the staging/production GitHub Environments. Create-if-absent so it
# never clobbers an existing deploy workflow.
if [ "${INSTALL_DEPLOY_GATE:-0}" = "1" ]; then
  DEPLOY_DEST=".github/workflows/deploy.yml"
  if gh api "/repos/$REPO/contents/$DEPLOY_DEST" --jq .sha >/dev/null 2>&1; then
    echo "    - $DEPLOY_DEST already exists — leaving it unchanged"
  else
    DEPLOY_SRC="$(cd "$(dirname "$0")" && pwd)/repo-ci/deploy.yml"
    DEPLOY_CONTENT="$(base64 < "$DEPLOY_SRC" | tr -d '\n')"
    echo "    - $DEPLOY_DEST"
    gh api --method PUT "/repos/$REPO/contents/$DEPLOY_DEST" \
      -f "message=Add Dispatch deploy gate (staging + gated production)" \
      -f "content=$DEPLOY_CONTENT" --jq '.commit.html_url'
    echo "    NOTE: in Settings → Environments, create 'staging' and 'production',"
    echo "    and add Required reviewers to 'production' to arm the manual approval"
    echo "    gate. Define deploy:staging / test:smoke / deploy:production npm scripts."
  fi
else
  echo "    - skipped (set INSTALL_DEPLOY_GATE=1 to install the staging/production gate)"
fi

echo "==> Committing Claude Code skills to .claude/skills/"
# claude-code-action loads project skills from the checked-out repo only, so the
# web console's Plan/Implement/Debug actions need these committed here. Upload
# each template from scripts/repo-skills/ via the contents API (idempotent: update
# in place when the file already exists).
SKILLS_DIR="$(cd "$(dirname "$0")/repo-skills" && pwd)"
for dir in "$SKILLS_DIR"/*/; do
  name="$(basename "$dir")"
  src="${dir}SKILL.md"
  [ -f "$src" ] || continue
  dest=".claude/skills/$name/SKILL.md"
  S_CONTENT="$(base64 < "$src" | tr -d '\n')"
  S_SHA="$(gh api "/repos/$REPO/contents/$dest" --jq .sha 2>/dev/null || true)"
  s_args=(--method PUT "/repos/$REPO/contents/$dest"
    -f "message=Add Claude Code skill: $name"
    -f "content=$S_CONTENT")
  [ -n "$S_SHA" ] && s_args+=(-f "sha=$S_SHA")   # update in place if it already exists
  echo "    - $dest"
  gh api "${s_args[@]}" --jq '.commit.html_url'
done

echo "==> Done. Next: in Dispatch, click 'Refresh context' on $REPO — the"
echo "    automation warning should clear. File a ticket with @claude to test,"
echo "    or use the Plan/Implement/Debug skill buttons on a ticket."
echo "    PRs now open automatically (gh pr create post-step) under GH_PAT, so the"
echo "    ci.yml gate runs on them. Ensure GH_PAT has Pull requests + Issues write."
