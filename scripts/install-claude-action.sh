#!/usr/bin/env bash
# Enable anthropics/claude-code-action on a repo via the GitHub API — no app install.
#
# Does the automatable setup steps (the GitHub App is optional; see caveat):
#   1. Sets the Claude auth repository secret (gh handles encryption). Prefers a
#      Claude subscription token (CLAUDE_CODE_OAUTH_TOKEN) so builds bill the
#      subscription; falls back to ANTHROPIC_API_KEY (metered API) when absent.
#      It is the ONLY secret written — no GH_PAT, no App credential (ADR-0006 [2]).
#   2. Commits .github/workflows/claude.yml — triggers builds on @claude mentions and
#      pushes a branch under the default GITHUB_TOKEN. Dispatch opens the PR.
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
#   GH_SETUP_TOKEN=github_pat_xxx ./scripts/install-claude-action.sh youruser/yourrepo
#   # add the optional staging+production deploy gate:
#   GH_SETUP_TOKEN=github_pat_xxx INSTALL_DEPLOY_GATE=1 \
#     ./scripts/install-claude-action.sh youruser/yourrepo
#
# PRs: claude-code-action never opens PRs itself — by design it pushes a branch
# and links a "Create PR" page (docs/faq). It used to be this script's job to add a
# `gh pr create` post-step under a fine-grained PAT (GH_PAT).
#
# ADR-0006 [2] deleted that. Dispatch's server opens the PR with its GitHub App
# installation token, which triggers `on: pull_request` CI without an approval gate
# (observed by #22 — ADR-0006 [8]). Writing a GH_PAT into every onboarded repo hands
# each of them a token that can write to every repo that PAT can reach; the App path
# has no such blast radius. Do not restore the post-step.
#
# Until #4 ships the poller's PR-opening half, a branch Claude pushes here has no PR
# yet. That is the accepted intermediate state (#24), not a bug to patch over.
set -euo pipefail

REPO="${1:?usage: install-claude-action.sh <owner/repo>}"
# GH_SETUP_TOKEN runs this script (Contents+Workflows+Secrets write). It is used
# here and never written into the repo. The workflow itself needs no GitHub token
# beyond the default GITHUB_TOKEN it gets for free (ADR-0006 [2]).
: "${GH_SETUP_TOKEN:?set GH_SETUP_TOKEN to a PAT with Contents+Workflows+Secrets write}"

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

# GH_PAT is no longer written (ADR-0006 [2]) — the workflow this script commits does
# not open PRs, so it has no use for one. A leftover GH_PAT from a pre-ADR-0006 run
# is a live credential with a blast radius the App path does not have; remove it
# rather than leaving it behind for nothing.
if gh secret delete GH_PAT --repo "$REPO" 2>/dev/null; then
  echo "==> Removed the now-unused GH_PAT secret from $REPO (ADR-0006 [2])"
fi

echo "==> Committing .github/workflows/claude.yml"
WF=".github/workflows/claude.yml"
TMP="$(mktemp)"
# Single source of truth, shared with server/setup/templates.ts (#4 AC 11).
cp "$(dirname "$0")/repo-ci/claude.yml" "$TMP"

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
# never clobbers a repo's existing CI. Dispatch opens Claude's PRs with its App
# installation token, so this gate triggers on them (observed — ADR-0006 [8]).
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
echo "    Claude pushes a branch; Dispatch opens the PR with its App installation"
echo "    token, and the ci.yml gate runs on it (ADR-0006 [2])."
echo "    NOTE: until #4 ships the poller's PR-opening half, the branch is pushed"
echo "    but no PR is opened. Install the GitHub App and track the repo first."
