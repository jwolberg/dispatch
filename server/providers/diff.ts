import type { FileChangeStatus, PRFileDiff } from "./types.js";

// T1-5 — the shared normalization behind getPRDiff() in both adapters.
//
// Lives outside github.ts / gitlab.ts for the same reason linkage.ts does: a
// rule that only holds on one provider is not a seam. Both mappers are tested
// against one table in ./diff.test.ts.

/**
 * Files requested per page. Both providers cap a page at 100 and silently
 * return 100 for a larger ask — so a full page is indistinguishable from "there
 * is more", and we report truncation rather than guess.
 */
export const DIFF_MAX_FILES = 100;

export interface RawGitHubFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/** GitHub's file status is an open enum; collapse it onto the shared vocabulary. */
function githubStatus(status: string): FileChangeStatus {
  switch (status) {
    case "added":
    case "copied": // a copy is a file that did not exist before
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    default:
      // modified, changed, unchanged, and anything GitHub ships next.
      return "modified";
  }
}

export function mapGitHubFile(f: RawGitHubFile): PRFileDiff {
  return {
    // A rename is reported at its new path — where the reader will look for it.
    path: f.filename,
    status: githubStatus(f.status),
    additions: f.additions,
    deletions: f.deletions,
    // Absent for binary files and for patches GitHub judges too large.
    patch: f.patch ?? null,
  };
}

export interface RawGitLabDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
}

function gitlabStatus(d: RawGitLabDiff): FileChangeStatus {
  if (d.new_file) return "added";
  if (d.deleted_file) return "removed";
  if (d.renamed_file) return "renamed";
  return "modified";
}

/**
 * Count changed lines in a unified diff.
 *
 * GitLab, unlike GitHub, reports no per-file line counts — only the diff text.
 * `+++`/`---` are file headers, `@@` is a hunk header, `\` is the no-newline
 * marker; none of them is a changed line.
 */
function countLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

export function mapGitLabDiff(d: RawGitLabDiff): PRFileDiff {
  // GitLab represents a binary file as an empty diff body rather than omitting
  // the field. An empty patch is no patch — say so, rather than reporting a
  // zero-line change to a file that may have changed entirely.
  const binary = d.diff === "";
  const { additions, deletions } = binary ? { additions: 0, deletions: 0 } : countLines(d.diff);

  return {
    path: d.new_path,
    status: gitlabStatus(d),
    additions,
    deletions,
    patch: binary ? null : d.diff,
  };
}
