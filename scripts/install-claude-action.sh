#!/usr/bin/env bash
# Enable anthropics/claude-code-action on a repo via the GitHub API — no app install.
#
# Does the automatable setup steps (the GitHub App is optional; see caveat):
#   1. Sets the ANTHROPIC_API_KEY + GH_PAT repository secrets (gh handles encryption)
#   2. Commits .github/workflows/claude.yml — triggers builds on @claude mentions and
#      opens a PR (gh pr create post-step) under GH_PAT so the PR triggers CI
#   3. Commits .claude/skills/{plan,implement,debug}/SKILL.md so the web console's
#      Plan/Implement/Debug skill actions run as real skills in CI (claude-code-action
#      only loads skills committed to the repo — never your laptop's ~/.claude).
#   4. Commits .github/workflows/ci.yml — a PR test gate (lint/test/build) that feeds
#      the board's check states. Created only if absent (won't clobber existing CI).
#
# Requirements:
#   - gh CLI installed
#   - GH_SETUP_TOKEN : a GitHub token for the target repo with
#       fine-grained: Contents=write, Workflows=write, Secrets=write
#       (classic PAT equivalent: `repo` + `workflow` scopes)
#     NOTE: your Dispatch token is Contents=read only — make a new PAT for this.
#   - ANTHROPIC_API_KEY : the key to store (defaults to macOS keychain
#       item `dispatch-ANTHROPIC_API_KEY`)
#
# Usage:
#   GH_SETUP_TOKEN=github_pat_xxx ./scripts/install-claude-action.sh jwolberg/situation
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

KEY="${ANTHROPIC_API_KEY:-$(security find-generic-password -s dispatch-ANTHROPIC_API_KEY -w 2>/dev/null || true)}"
: "${KEY:?ANTHROPIC_API_KEY not set and not in keychain (dispatch-ANTHROPIC_API_KEY)}"

export GH_TOKEN="$GH_SETUP_TOKEN"
command -v gh >/dev/null || { echo "gh CLI not found"; exit 1; }

echo "==> Setting ANTHROPIC_API_KEY secret on $REPO"
printf %s "$KEY" | gh secret set ANTHROPIC_API_KEY --repo "$REPO"

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
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
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
CI_DEST=".github/workflows/ci.yml"
if gh api "/repos/$REPO/contents/$CI_DEST" --jq .sha >/dev/null 2>&1; then
  echo "    - $CI_DEST already exists — leaving it unchanged"
else
  CI_SRC="$(cd "$(dirname "$0")" && pwd)/repo-ci/ci.yml"
  CI_CONTENT="$(base64 < "$CI_SRC" | tr -d '\n')"
  echo "    - $CI_DEST"
  gh api --method PUT "/repos/$REPO/contents/$CI_DEST" \
    -f "message=Add Dispatch CI gate (lint/test/build on PRs)" \
    -f "content=$CI_CONTENT" --jq '.commit.html_url'
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
