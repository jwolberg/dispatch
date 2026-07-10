import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts");

/** Which Claude credential the workflow reads. */
export type AuthMode = "oauth" | "apikey";

/** A file to commit into the target repo. */
export interface Template {
  path: string;
  content: string;
  message: string;
  /** ci.yml only: never clobber a repo's existing CI. */
  createOnly?: boolean;
}

const AUTH_PLACEHOLDER = "__CLAUDE_AUTH_INPUT__";
const AUTH_LINE: Record<AuthMode, string> = {
  oauth: "          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
  apikey: "          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}",
};

/** The secret name each mode writes into the target repo. */
export const SECRET_NAME: Record<AuthMode, string> = {
  oauth: "CLAUDE_CODE_OAUTH_TOKEN",
  apikey: "ANTHROPIC_API_KEY",
};

const read = (rel: string) => readFileSync(resolve(SCRIPTS, rel), "utf8");

/**
 * `scripts/repo-ci/claude.yml` is the single source, shared with
 * `install-claude-action.sh` (#4 AC 11). Duplicating it in TypeScript is how the
 * two copies drift — the same mistake stage 1a fixed for the issue prompt.
 */
export function claudeWorkflow(mode: AuthMode): string {
  const template = read("repo-ci/claude.yml");
  if (!template.includes(AUTH_PLACEHOLDER)) {
    throw new Error(`repo-ci/claude.yml no longer contains ${AUTH_PLACEHOLDER}`);
  }
  return template.replace(new RegExp(`^.*${AUTH_PLACEHOLDER}.*$`, "m"), AUTH_LINE[mode]);
}

export type Stack = "node" | "python" | "unknown";

/**
 * Which CI template fits, read from the cached depth-2 file tree so setup costs no
 * extra provider calls.
 *
 * An unknown stack gets **no** `ci.yml`: a Node gate hard-fails at `npm ci` on a
 * non-Node repo and would block every PR, which is worse than having no gate.
 */
export function detectStack(fileTree: string[]): Stack {
  const root = new Set(fileTree.map((p) => p.replace(/\/$/, "")));
  if (root.has("package.json")) return "node";
  if (root.has("requirements.txt") || root.has("pyproject.toml") || root.has("setup.py")) {
    return "python";
  }
  return "unknown";
}

const SKILLS = ["plan", "implement", "debug"] as const;

/**
 * Everything setup commits. `claude.yml` and the skills are ours and are kept at
 * our content; `ci.yml` is created only if absent.
 */
export function templatesFor(mode: AuthMode, stack: Stack): Template[] {
  const files: Template[] = [
    {
      path: ".github/workflows/claude.yml",
      content: claudeWorkflow(mode),
      message: "ci: install claude-code-action (Dispatch)",
    },
  ];

  if (stack !== "unknown") {
    files.push({
      path: ".github/workflows/ci.yml",
      content: read(`repo-ci/ci-${stack}.yml`),
      message: "ci: add PR test gate (Dispatch)",
      createOnly: true,
    });
  }

  for (const skill of SKILLS) {
    files.push({
      path: `.claude/skills/${skill}/SKILL.md`,
      // claude-code-action only loads skills committed to the repo — never the
      // operator's ~/.claude — so the console's skill buttons need these here.
      content: read(`repo-skills/${skill}/SKILL.md`),
      message: `chore: add ${skill} skill (Dispatch)`,
    });
  }
  return files;
}
