import { describe, it, expect } from "vitest";
import { mapGitHubFile, mapGitLabDiff, DIFF_MAX_FILES } from "./diff.js";
import type { PRFileDiff } from "./types.js";

// T1-5 (ticket #6) — both adapters normalize a provider's changed-file payload
// into the SAME PRFileDiff. Tested against one shared table, as linkage.test.ts
// does for issue↔PR linkage: a rule that only holds on GitHub is not a seam.
//
// The asymmetry worth knowing: GitHub hands us `additions`/`deletions` per file.
// GitLab hands us only the unified diff text, so those counts are derived by
// counting hunk lines. The table below asserts both arrive at the same numbers
// for the same change.

/** A unified-diff body: 2 added lines, 1 removed. */
const PATCH = ["@@ -1,2 +1,3 @@", " context", "-old line", "+new line", "+another"].join("\n");

interface Case {
  name: string;
  github: Parameters<typeof mapGitHubFile>[0];
  gitlab: Parameters<typeof mapGitLabDiff>[0];
  expected: PRFileDiff;
}

const cases: Case[] = [
  {
    name: "a modified text file",
    github: { filename: "src/app.ts", status: "modified", additions: 2, deletions: 1, patch: PATCH },
    gitlab: {
      old_path: "src/app.ts",
      new_path: "src/app.ts",
      new_file: false,
      renamed_file: false,
      deleted_file: false,
      diff: PATCH,
    },
    expected: {
      path: "src/app.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: PATCH,
    },
  },
  {
    name: "a newly added file",
    github: { filename: "src/new.ts", status: "added", additions: 2, deletions: 1, patch: PATCH },
    gitlab: {
      old_path: "src/new.ts",
      new_path: "src/new.ts",
      new_file: true,
      renamed_file: false,
      deleted_file: false,
      diff: PATCH,
    },
    expected: { path: "src/new.ts", status: "added", additions: 2, deletions: 1, patch: PATCH },
  },
  {
    name: "a deleted file",
    github: { filename: "src/old.ts", status: "removed", additions: 2, deletions: 1, patch: PATCH },
    gitlab: {
      old_path: "src/old.ts",
      new_path: "src/old.ts",
      new_file: false,
      renamed_file: false,
      deleted_file: true,
      diff: PATCH,
    },
    expected: { path: "src/old.ts", status: "removed", additions: 2, deletions: 1, patch: PATCH },
  },
  {
    name: "a renamed file — reported at its NEW path, where the reader will look for it",
    // GitHub reports the new name in `filename` (and the old one in
    // `previous_filename`, which we drop); GitLab reports both paths.
    github: { filename: "src/after.ts", status: "renamed", additions: 2, deletions: 1, patch: PATCH },
    gitlab: {
      old_path: "src/before.ts",
      new_path: "src/after.ts",
      new_file: false,
      renamed_file: true,
      deleted_file: false,
      diff: PATCH,
    },
    expected: { path: "src/after.ts", status: "renamed", additions: 2, deletions: 1, patch: PATCH },
  },
  {
    name: "a binary file — no patch on either provider",
    github: { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
    gitlab: {
      old_path: "logo.png",
      new_path: "logo.png",
      new_file: true,
      renamed_file: false,
      deleted_file: false,
      // GitLab reports a binary file as an empty diff body rather than omitting it.
      diff: "",
    },
    expected: { path: "logo.png", status: "added", additions: 0, deletions: 0, patch: null },
  },
];

describe("both adapters normalize a changed file the same way", () => {
  for (const c of cases) {
    it(`github: ${c.name}`, () => {
      expect(mapGitHubFile(c.github)).toEqual(c.expected);
    });
    it(`gitlab: ${c.name}`, () => {
      expect(mapGitLabDiff(c.gitlab)).toEqual(c.expected);
    });
  }
});

describe("mapGitHubFile — statuses outside the shared vocabulary", () => {
  // GitHub's file status is an open enum: `copied`, `changed`, `unchanged` all
  // appear. Rather than widen FileChangeStatus for cases the reader cannot act
  // on differently, they collapse onto the nearest shared meaning.
  it("treats a copied file as added", () => {
    expect(mapGitHubFile({ filename: "a.ts", status: "copied", additions: 1, deletions: 0 }).status)
      .toBe("added");
  });

  it("treats `changed` and `unchanged` as modified", () => {
    for (const status of ["changed", "unchanged"]) {
      expect(mapGitHubFile({ filename: "a.ts", status, additions: 0, deletions: 0 }).status)
        .toBe("modified");
    }
  });

  it("falls back to modified on a status GitHub has not shipped yet", () => {
    expect(mapGitHubFile({ filename: "a.ts", status: "teleported", additions: 0, deletions: 0 }).status)
      .toBe("modified");
  });
});

describe("mapGitLabDiff — counting lines is not the same as counting characters", () => {
  const count = (diff: string) => {
    const f = mapGitLabDiff({
      old_path: "a.ts",
      new_path: "a.ts",
      new_file: false,
      renamed_file: false,
      deleted_file: false,
      diff,
    });
    return { additions: f.additions, deletions: f.deletions };
  };

  it("does not count the ---/+++ file headers as changed lines", () => {
    const diff = ["--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-x", "+y"].join("\n");
    expect(count(diff)).toEqual({ additions: 1, deletions: 1 });
  });

  it("does not count hunk headers or context lines", () => {
    const diff = ["@@ -1,3 +1,3 @@", " unchanged", "+added"].join("\n");
    expect(count(diff)).toEqual({ additions: 1, deletions: 0 });
  });

  it("does not count the no-newline marker", () => {
    const diff = ["@@ -1 +1 @@", "-x", "+y", "\\ No newline at end of file"].join("\n");
    expect(count(diff)).toEqual({ additions: 1, deletions: 1 });
  });

  it("reports an empty diff as a binary file rather than a zero-line change", () => {
    const f = mapGitLabDiff({
      old_path: "logo.png",
      new_path: "logo.png",
      new_file: false,
      renamed_file: false,
      deleted_file: false,
      diff: "",
    });
    expect(f.patch).toBeNull();
  });
});

describe("the file-page cap is documented and shared", () => {
  it("is a single constant both adapters page by", () => {
    // Both providers cap a page at 100. Requesting more silently returns 100,
    // which would look like "no truncation" to a caller that trusted the ask.
    expect(DIFF_MAX_FILES).toBe(100);
  });
});
