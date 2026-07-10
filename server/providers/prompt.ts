import { autoCloseKeyword, type ProviderId } from "./types.js";

/**
 * The instruction Dispatch appends to every issue it files. It is a *prompt*, and
 * it is the only place that tells Claude what to do with its work.
 *
 * ADR-0006 [2]: **Dispatch opens the pull request, the workflow does not.** Saying
 * otherwise here is not a cosmetic slip — the issue body and `claude.yml`'s
 * `--append-system-prompt` are two channels giving Claude one instruction, and when
 * they disagree the build stalls. `claude.yml` also drops `pull-requests: write`, so
 * a Claude that obeyed this text could only fail.
 *
 * The auto-close keyword must survive: `Fixes #<n>` (GitHub) / `Closes #<n>`
 * (GitLab) is what closes the issue when Dispatch's pull request merges, and what
 * {@link linksToIssue} reads to bind a branch to its ticket.
 *
 * Kept out of the adapters so the wording is one testable string rather than two
 * that drift. Lives inside `providers/` because the keyword is provider-specific
 * (ARCH §5) — the core never branches on provider for ship semantics.
 */
export function implementationPrompt(provider: ProviderId): string {
  const keyword = autoCloseKeyword(provider);
  const request = provider === "gitlab" ? "merge request" : "pull request";
  return (
    `@claude please implement this. Commit your work on a branch. ` +
    `Do not create a ${request} — Dispatch opens the ${request} from your branch, ` +
    `authenticated so that CI actually runs on it.\n\n` +
    `Reference this issue in your commit message with \`${keyword} #<this issue number>\` ` +
    `so it auto-closes when that ${request} merges.`
  );
}

/** The full issue body: the spec, then the instruction. */
export function issueBody(provider: ProviderId, bodyMarkdown: string): string {
  return `${bodyMarkdown}\n\n---\n${implementationPrompt(provider)}`;
}
