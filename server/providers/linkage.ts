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

/**
 * GitHub's generated revert branch: `revert-<prNumber>-<originalBranch>`.
 *
 * The `\d+-` is load-bearing. A bare `^revert-` also matches human branches like
 * `revert-antialiasing` (a real PR in vercel/next.js that argues *for* font
 * antialiasing and reverts nothing). Treating that as a revert would hide it
 * from its own ticket.
 */
const REVERT_BRANCH = /^revert-\d+-/;
/** GitHub's generated body opens with `Reverts owner/repo#<n>`. */
const REVERT_BODY = /^Reverts\b/m;
/**
 * git's own boilerplate, which `git revert` writes and GitLab's revert carries.
 * This is how a hand-made revert (pushed from a normally-named branch) is
 * recognized at all.
 */
const REVERT_COMMIT_BODY = /\bthis reverts commit\b/i;

/**
 * Is this PR/MR a revert of something, whatever it reverts?
 *
 * Used to keep reverts out of issue linkage (T1-8, ADR-0004 [5]). GitHub names
 * a revert branch `revert-<prNumber>-<originalBranch>`, so reverting the PR on
 * `claude/issue-1` produces `revert-7-claude/issue-1` — which still contains
 * `1` and therefore still satisfies `linksToIssue(1, …)`. Adapters list PRs
 * newest-first, so without this the revert would outrank the PR it reverts and
 * take over the ticket.
 *
 * Deliberately prefix-anchored: a branch named `reverted-metrics` is not a
 * revert, and prose like "we should revert this someday" in a body is not one
 * either.
 */
export function isRevertPR(candidate: LinkCandidate): boolean {
  const body = candidate.body ?? "";
  return (
    REVERT_BRANCH.test(candidate.branch ?? "") || REVERT_BODY.test(body) || REVERT_COMMIT_BODY.test(body)
  );
}

/**
 * Does this PR/MR revert *the PR numbered `prNumber`*?
 *
 * Note the number is a **PR** number here, not an issue number — the two are
 * different sequences and conflating them attaches a revert to the wrong card.
 * The branch is the primary signal because GitHub's body text is not
 * contractual (ADR-0003 [5]); the body is a fallback for reverts opened by
 * other means. Both are digit-bounded, so #7 never matches a revert of #70.
 */
export function revertsPR(prNumber: number, candidate: LinkCandidate): boolean {
  const branchMatch = /^revert-(\d+)-/.exec(candidate.branch ?? "");
  if (branchMatch && Number(branchMatch[1]) === prNumber) return true;
  return new RegExp(`Reverts[^\\n]*#${prNumber}(?!\\d)`).test(candidate.body ?? "");
}

/**
 * First candidate that links to the issue, or undefined.
 *
 * Skips reverts: a revert of the ticket's PR is not the ticket's PR. Callers
 * that want the revert ask for it explicitly via {@link findRevert}.
 */
export function findLinked<T>(
  issueNumber: number,
  items: T[],
  toCandidate: (item: T) => LinkCandidate
): T | undefined {
  return items.find((item) => {
    const candidate = toCandidate(item);
    return !isRevertPR(candidate) && linksToIssue(issueNumber, candidate);
  });
}

/** First candidate that reverts `prNumber`, or undefined. */
export function findRevert<T>(
  prNumber: number,
  items: T[],
  toCandidate: (item: T) => LinkCandidate
): T | undefined {
  return items.find((item) => revertsPR(prNumber, toCandidate(item)));
}

/** git abbreviates to 7 hex chars; shorter is too collision-prone to trust. */
const MIN_SHA_PREFIX = 7;
const BODY_SHA = /\bthis reverts commit ([0-9a-f]{7,40})/i;
const BRANCH_SHA = /^revert-([0-9a-f]{7,40})$/i;

function shaPrefixMatch(sha: string, found: string): boolean {
  if (found.length < MIN_SHA_PREFIX) return false;
  const a = sha.toLowerCase();
  const b = found.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Does this MR revert the commit `sha`?
 *
 * GitLab's revert never names the original merge request — `api/v4` has no
 * MR-level revert, so the revert is of a *commit* and the description carries
 * git's `This reverts commit <sha>` boilerplate (ADR-0003 [3]). Attribution
 * therefore runs through the original MR's `squash_commit_sha ?? merge_commit_sha`.
 *
 * Both the body and GitLab's generated `revert-<shortSha>` branch may abbreviate,
 * so this compares on a prefix in either direction.
 */
export function revertsCommit(sha: string, candidate: LinkCandidate): boolean {
  const fromBody = BODY_SHA.exec(candidate.body ?? "");
  if (fromBody && shaPrefixMatch(sha, fromBody[1])) return true;
  const fromBranch = BRANCH_SHA.exec(candidate.branch ?? "");
  return Boolean(fromBranch && shaPrefixMatch(sha, fromBranch[1]));
}

/** First candidate that reverts the commit `sha`, or undefined. */
export function findRevertOfCommit<T>(
  sha: string,
  items: T[],
  toCandidate: (item: T) => LinkCandidate
): T | undefined {
  return items.find((item) => revertsCommit(sha, toCandidate(item)));
}
