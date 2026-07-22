#!/usr/bin/env bash
# dispatch-pickup — turn a Dispatch ticket into a local TerMinal backlog ticket (#38).
#
# Usage:   dispatch-pickup <owner/repo>#<issue-number>
# Example: dispatch-pickup jwolberg/situation#42
#
# Install once on the machine that runs TerMinal:
#   ln -s "$PWD/scripts/terminal-pickup.sh" ~/.local/bin/dispatch-pickup
#
# Run it from inside the local clone — `repoRoot` is taken from $PWD, because
# Dispatch cannot know where you cloned the repo.
#
# This talks only to the provider and to the local inbox: it never contacts the
# Dispatch server and needs no Dispatch credentials. Issue text is fetched here
# and passed through jq, never interpolated into a shell string, so backticks or
# $(...) in an issue body cannot execute.

set -euo pipefail

TERMINAL_CLI="${TERMINAL_CLI:-$HOME/.config/TerMinal/bin/terminal-cli}"

die() { echo "dispatch-pickup: $*" >&2; exit 1; }

[ $# -eq 1 ] || die "usage: dispatch-pickup <owner/repo>#<issue-number>"

# Split "owner/repo#42" without a subshell-eval of the argument.
target="$1"
repo="${target%%#*}"
issue="${target##*#}"
[ "$repo" != "$target" ] || die "expected <owner/repo>#<issue-number>, got '$target'"
[ -n "$repo" ] || die "missing owner/repo in '$target'"
case "$issue" in ''|*[!0-9]*) die "issue number must be numeric, got '$issue'";; esac

command -v gh >/dev/null 2>&1 || die "gh is not installed"
command -v jq >/dev/null 2>&1 || die "jq is not installed"
[ -x "$TERMINAL_CLI" ] || die "terminal-cli not found at $TERMINAL_CLI"

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) \
  || die "not inside a git repo — cd into your clone of $repo first"

# Warn rather than refuse: a fork or a differently-named remote is legitimate.
origin=$(git remote get-url origin 2>/dev/null || true)
case "$origin" in
  *"$repo"*) ;;
  "") echo "dispatch-pickup: warning: no origin remote; filing into $repo_root anyway" >&2 ;;
  *)  echo "dispatch-pickup: warning: origin ($origin) does not mention $repo; filing into $repo_root anyway" >&2 ;;
esac

issue_json=$(gh issue view "$issue" --repo "$repo" --json number,title,body,url,labels) \
  || die "could not read $repo#$issue (is gh authenticated?)"

# Build the envelope entirely in jq: no issue text is ever a shell word.
#
# Two transforms on the way through:
#
#  - Strip the `@claude` implementation prompt Dispatch appends to every issue it
#    files (server/providers/prompt.ts). It instructs a CI agent to push a branch
#    and let Dispatch open the PR — meaningless locally, and actively misleading
#    in a backlog ticket you are about to work by hand. Split on the separator
#    `issueBody()` uses; an issue without it is unaffected.
#  - Map the issue's labels onto a ticket type, defaulting to `feature`, so a bug
#    does not arrive mislabelled.
envelope=$(jq -n \
  --argjson issue "$issue_json" \
  --arg repo "$repo" \
  --arg repo_root "$repo_root" \
  '
   def spec_only:
     (. // "") | split("\n---\n@claude ")[0] | rtrimstr("\n");

   def ticket_type:
     [.labels[]?.name // empty | ascii_downcase] as $l
     | if   ($l | index("bug"))         then "bug"
       elif ($l | index("security"))    then "security"
       elif ($l | index("docs"))        then "docs"
       elif ($l | index("performance")) then "performance"
       else "feature" end;

   ($issue.body | spec_only) as $spec
   | {
     listenerId: ("dispatch:" + $repo),
     listenerName: "Dispatch handoff",
     source: "dispatch",
     type: "ticket.handoff",
     dedupeKey: ("dispatch:" + $repo + "#" + ($issue.number|tostring)),
     repoRoot: $repo_root,
     title: $issue.title,
     body: $spec,
     requestedAction: {
       kind: "file-ticket",
       title: $issue.title,
       body: ($spec + "\n\n---\n\nHanded off from Dispatch: " + $issue.url),
       type: ($issue | ticket_type),
       priority: "medium"
     }
   }')

"$TERMINAL_CLI" inbox enqueue "$envelope"
echo "dispatch-pickup: queued $repo#$issue → $repo_root"
