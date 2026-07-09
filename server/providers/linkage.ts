// PR ↔ issue linkage (PRD F4.4). Extracted from the adapters so the matching
// rule is one testable function rather than two regexes duplicated next to two
// different network calls. Lives inside providers/ — it is part of the seam's
// normalization, not app logic.

/** A PR/MR reduced to the two fields linkage looks at. */
export interface LinkCandidate {
  /** PR body (GitHub) / MR description (GitLab). */
  body: string | null | undefined;
  /** Head branch (GitHub) / source branch (GitLab). */
  branch: string | null | undefined;
}

/**
 * A PR links to an issue if its body references `#<n>` (Fixes/Closes/refs) or
 * its branch name contains the issue number.
 *
 * Both matches are digit-bounded, so issue #1 does not match a body citing #10
 * nor a branch named `release-v10`. The branch rule is intentionally loose about
 * separators — `claude/issue-7`, `fix-7`, and `7-add-thing` all link to #7.
 */
export function linksToIssue(issueNumber: number, candidate: LinkCandidate): boolean {
  const bodyRef = new RegExp(`#${issueNumber}(?!\\d)`);
  const branchRef = new RegExp(`(?<!\\d)${issueNumber}(?!\\d)`);
  return bodyRef.test(candidate.body ?? "") || branchRef.test(candidate.branch ?? "");
}

/** First candidate that links to the issue, or undefined. */
export function findLinked<T>(
  issueNumber: number,
  items: T[],
  toCandidate: (item: T) => LinkCandidate
): T | undefined {
  return items.find((item) => linksToIssue(issueNumber, toCandidate(item)));
}
