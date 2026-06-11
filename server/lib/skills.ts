import { autoCloseKeyword, type ProviderId } from "../providers/index.js";

// Skills the web console can drive on a ticket. Each one posts an @claude
// comment that claude-code-action picks up in CI (issue_comment trigger), so the
// build runs wherever the repo's automation runs. The prompt names the Claude
// Code skill so the agent runs it when installed, and degrades to plain prose
// otherwise.

export type SkillId = "plan" | "implement" | "debug";

export const SKILLS: SkillId[] = ["plan", "implement", "debug"];

export function isSkill(x: unknown): x is SkillId {
  return typeof x === "string" && (SKILLS as string[]).includes(x);
}

/** Debug targets the PR when one exists; plan/implement target the issue. */
export function defaultTarget(skill: SkillId, hasPR: boolean): "issue" | "pr" {
  return skill === "debug" && hasPR ? "pr" : "issue";
}

/**
 * Build the @claude comment body for a skill. `issueNumber` feeds the
 * provider-specific auto-close keyword; `note` is the user's optional extra
 * instruction from the console.
 */
export function skillPrompt(
  skill: SkillId,
  provider: ProviderId,
  issueNumber: number,
  note?: string | null
): string {
  const extra = note && note.trim() ? `\n\nAdditional context: ${note.trim()}` : "";
  switch (skill) {
    case "plan":
      return (
        `@claude use the **plan** skill for this issue. Read the relevant files and ` +
        `post a step-by-step implementation plan as a comment — phases, files to ` +
        `touch, and risks. Do not open a PR yet.${extra}`
      );
    case "implement": {
      const keyword = autoCloseKeyword(provider); // "Fixes" (GitHub) / "Closes" (GitLab)
      return (
        `@claude use the **implement** skill to build this. Open a pull request that ` +
        `references this issue (use \`${keyword} #${issueNumber}\` so it auto-closes ` +
        `on merge).${extra}`
      );
    }
    case "debug":
      return (
        `@claude use the **debug** skill: reproduce the failure, find the root cause, ` +
        `then push a minimal fix and explain the cause in a comment.${extra}`
      );
  }
}
