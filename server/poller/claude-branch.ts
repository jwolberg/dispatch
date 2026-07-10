import type { CommitIdentity } from "../providers/types.js";

/**
 * The git-level author name `claude-code-action` writes on the commits it pushes.
 *
 * **Sampled, not inferred** (#4 AC 9). Run 29069518765 on `jwolberg/dispatch`; the
 * raw payloads and the reasoning are in `./__fixtures__/README.md`. Do not change
 * this constant from documentation — re-sample.
 */
export const CLAUDE_GIT_AUTHOR_NAME = "claude[bot]";

/**
 * Did `claude-code-action` push this commit?
 *
 * Both conditions are required, and neither is sufficient:
 *
 * - `authorType === "Bot"` is resolved by GitHub from the commit *email* and cannot
 *   be set by the git client alone — but Dependabot, Renovate, and every other
 *   Actions-authored commit also satisfy it.
 * - `authorName === "claude[bot]"` is the only field that names Claude — but it is
 *   just a git config value, and `authorLogin` reports `github-actions[bot]`, never
 *   `claude[bot]`, because the noreply email carries github-actions' numeric id.
 *
 * GitLab reports neither a resolved account nor a bot/user distinction, so
 * `authorType` is `null` there and this returns `false`. That is the intended
 * behavior: `claude-code-action` is GitHub-only, there is no GitLab identity to
 * sample, and opening a merge request from a human's work-in-progress branch is not
 * a recoverable mistake.
 *
 * A human with push access could forge both fields. That is not a new trust
 * boundary — they could push to `claude/issue-N-…` directly.
 */
export function isClaudeAuthored(identity: CommitIdentity): boolean {
  return identity.authorType === "Bot" && identity.authorName === CLAUDE_GIT_AUTHOR_NAME;
}
