#!/usr/bin/env bash
# Enable anthropics/claude-code-action on a repo via the GitHub API — no app install.
#
# Does the two automatable steps (the GitHub App is optional; see caveat):
#   1. Sets the ANTHROPIC_API_KEY repository secret (gh handles libsodium encryption)
#   2. Commits .github/workflows/claude.yml (triggers builds on @claude mentions)
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
          prompt: |
            When opening a pull request, include "Fixes #${{ github.event.issue.number }}"
            in the PR body so the issue auto-closes on merge.
YAML

CONTENT="$(base64 < "$TMP" | tr -d '\n')"
SHA="$(gh api "/repos/$REPO/contents/$WF" --jq .sha 2>/dev/null || true)"

args=(--method PUT "/repos/$REPO/contents/$WF"
  -f "message=Add Claude Code workflow (claude-code-action)"
  -f "content=$CONTENT")
[ -n "$SHA" ] && args+=(-f "sha=$SHA")   # update in place if it already exists

gh api "${args[@]}" --jq '.commit.html_url'
rm -f "$TMP"

echo "==> Done. Next: in Dispatch, click 'Refresh context' on $REPO — the"
echo "    automation warning should clear. File a ticket with @claude to test."
