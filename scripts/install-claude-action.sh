#!/usr/bin/env bash
# Enable anthropics/claude-code-action on a repo via the GitHub API — no app install.
#
# Does the automatable setup steps (the GitHub App is optional; see caveat):
#   1. Sets the ANTHROPIC_API_KEY repository secret (gh handles libsodium encryption)
#   2. Commits .github/workflows/claude.yml (triggers builds on @claude mentions)
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
# Caveat: without the Claude GitHub App, Claude's PR commits run as
# github-actions[bot], and GitHub does NOT trigger your CI on bot commits — so
# Dispatch's check-driven Building->Ready-to-test transitions and the
# "all checks green" ship gate won't populate from those commits. Install the
# app (github.com/apps/claude or `/install-github-app`) if you need that.
set -euo pipefail

REPO="${1:?usage: install-claude-action.sh <owner/repo>}"
: "${GH_SETUP_TOKEN:?set GH_SETUP_TOKEN to a PAT with Contents+Workflows+Secrets write}"

KEY="${ANTHROPIC_API_KEY:-$(security find-generic-password -s dispatch-ANTHROPIC_API_KEY -w 2>/dev/null || true)}"
: "${KEY:?ANTHROPIC_API_KEY not set and not in keychain (dispatch-ANTHROPIC_API_KEY)}"

export GH_TOKEN="$GH_SETUP_TOKEN"
command -v gh >/dev/null || { echo "gh CLI not found"; exit 1; }

echo "==> Setting ANTHROPIC_API_KEY secret on $REPO"
printf %s "$KEY" | gh secret set ANTHROPIC_API_KEY --repo "$REPO"

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
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          # Do NOT set `prompt:` here. A static prompt forces the action into
          # automation mode, which IGNORES the triggering @claude comment — so the
          # console's "use the <skill> skill ..." instruction is never seen and the
          # run does nothing. Omitting `prompt:` enables interactive (mention) mode:
          # Claude reads the @claude comment, runs it (incl. project skills checked
          # out at .claude/skills/), posts a tracking comment, and opens a PR.
          # The standing PR convention goes in append-system-prompt, which augments
          # rather than overrides the trigger.
          claude_args: |
            --append-system-prompt "When you open a pull request, include a closing reference to the issue (e.g. 'Fixes #123') in the PR description so it auto-closes on merge."
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
# never clobbers a repo's existing CI. Note: bot-authored PRs (API-key-only setup)
# don't trigger workflows — install the Claude GitHub App for CI to run on them.
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
echo "    For the CI gate to run on Claude's PRs, install the Claude GitHub App"
echo "    (/install-github-app) — bot-authored PRs don't trigger workflows."
