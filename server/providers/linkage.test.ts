import { describe, it, expect } from "vitest";
import {
  linksToIssue,
  findLinked,
  isRevertPR,
  revertsPR,
  revertsCommit,
  findRevert,
  findRevertOfCommit,
} from "./linkage.js";

// T0-3 — PR↔issue linkage (PRD F4.4). Both adapters share this rule, so one
// table covers GitHub PR bodies/head branches and GitLab MR
// descriptions/source branches. The digit boundaries are the whole point: a
// regression here silently attaches the wrong PR to a ticket, and the board
// then offers a Ship button for someone else's change.

describe("linksToIssue", () => {
  describe("body references", () => {
    it.each([
      ["Fixes #7", true],
      ["Closes #7", true],
      ["refs #7 and more prose", true],
      ["see #7.", true],
      ["#7", true],
      ["no reference at all", false],
      ["", false],
    ])("body %j → %s", (body, expected) => {
      expect(linksToIssue(7, { body, branch: null })).toBe(expected);
    });

    // The bug this guards: `#1` must not match a body that cites `#10`.
    it("does not match a longer issue number that starts with the same digits", () => {
      expect(linksToIssue(1, { body: "Fixes #10", branch: null })).toBe(false);
      expect(linksToIssue(1, { body: "Fixes #123", branch: null })).toBe(false);
      expect(linksToIssue(7, { body: "Fixes #77", branch: null })).toBe(false);
    });

    it("still matches the exact number when a longer one is also present", () => {
      expect(linksToIssue(1, { body: "Fixes #10 and #1", branch: null })).toBe(true);
    });

    it("does not match a number without the # sigil", () => {
      expect(linksToIssue(7, { body: "bumped to version 7", branch: null })).toBe(false);
    });
  });

  describe("branch references", () => {
    it.each([
      ["claude/issue-7", true],
      ["fix-7", true],
      ["7-add-thing", true],
      ["feature/7", true],
      ["main", false],
      ["", false],
    ])("branch %j → %s", (branch, expected) => {
      expect(linksToIssue(7, { body: null, branch })).toBe(expected);
    });

    // `#1` must not match branch `release-v10` or `issue-100`.
    it("is digit-bounded on both sides", () => {
      expect(linksToIssue(1, { body: null, branch: "release-v10" })).toBe(false);
      expect(linksToIssue(1, { body: null, branch: "issue-100" })).toBe(false);
      expect(linksToIssue(1, { body: null, branch: "issue-21" })).toBe(false);
      expect(linksToIssue(10, { body: null, branch: "issue-10" })).toBe(true);
    });
  });

  it("treats null and undefined body/branch as absent, not as a match", () => {
    expect(linksToIssue(7, { body: null, branch: null })).toBe(false);
    expect(linksToIssue(7, { body: undefined, branch: undefined })).toBe(false);
  });

  it("links when either the body or the branch matches", () => {
    expect(linksToIssue(7, { body: "Fixes #7", branch: "main" })).toBe(true);
    expect(linksToIssue(7, { body: "no ref", branch: "claude/issue-7" })).toBe(true);
  });
});

describe("findLinked", () => {
  const prs = [
    { id: "a", body: "Fixes #10", branch: "claude/issue-10" },
    { id: "b", body: "Fixes #1", branch: "claude/issue-1" },
  ];
  const toCandidate = (p: (typeof prs)[number]) => ({ body: p.body, branch: p.branch });

  it("picks the exactly-matching PR, not the prefix-colliding one", () => {
    expect(findLinked(1, prs, toCandidate)?.id).toBe("b");
    expect(findLinked(10, prs, toCandidate)?.id).toBe("a");
  });

  it("returns undefined when nothing links", () => {
    expect(findLinked(99, prs, toCandidate)).toBeUndefined();
  });

  it("returns the first match, preserving caller ordering", () => {
    const dupes = [
      { id: "first", body: "Fixes #7", branch: "x" },
      { id: "second", body: "Fixes #7", branch: "y" },
    ];
    expect(findLinked(7, dupes, toCandidate)?.id).toBe("first");
  });

  // T1-8 / ADR-0004 [5]. This is the regression the deep-link revert would
  // otherwise introduce, and it is not hypothetical.
  //
  // Adapters list PRs sorted `updated` descending, so the NEWEST match wins.
  // GitHub names a revert branch `revert-<prNumber>-<originalBranch>`, so
  // reverting PR #7 (branch `claude/issue-1`) yields `revert-7-claude/issue-1`
  // — which still contains `1`, so the loose branch rule still links it to
  // issue #1. Without this exclusion the revert PR silently becomes the
  // ticket's PR, and the shipped card starts describing its own undo.
  it("never returns a revert PR as an issue's linked PR", () => {
    const sortedByUpdatedDesc = [
      { id: "the-revert", body: "Reverts acme/widgets#7", branch: "revert-7-claude/issue-1" },
      { id: "the-original", body: "Fixes #1", branch: "claude/issue-1" },
    ];
    expect(findLinked(1, sortedByUpdatedDesc, toCandidate)?.id).toBe("the-original");
  });

  it("returns undefined when the only linking PR is a revert", () => {
    const onlyRevert = [{ id: "r", body: "Reverts acme/widgets#7", branch: "revert-7-issue-1" }];
    expect(findLinked(1, onlyRevert, toCandidate)).toBeUndefined();
  });
});

// T1-8 — Dispatch does not open the revert PR (ADR-0004), so it has to
// recognize one the user opened on the provider's site. Detection keys off the
// ORIGINAL PR number, not the issue number.
describe("isRevertPR", () => {
  it.each([
    ["revert-7-claude/issue-1", true],
    ["revert-90948-hl/revert-ppr-removal", true], // observed: vercel/next.js
    ["main", false],
    ["claude/issue-7", false],
    ["reverted-metrics", false], // `reverted`, not the `revert-` prefix
  ])("branch %j → %s", (branch, expected) => {
    expect(isRevertPR({ body: null, branch })).toBe(expected);
  });

  // The false positive that a bare /^revert-/ rule produces. `revert-antialiasing`
  // is a real vercel/next.js PR that *argues for* antialiasing and reverts
  // nothing. Misclassifying it would erase a legitimate PR from its ticket,
  // because findLinked skips reverts.
  it("does not treat a human branch merely named `revert-…` as a revert", () => {
    expect(
      isRevertPR({ body: "This PR presents the argument that…", branch: "revert-antialiasing" })
    ).toBe(false);
  });

  it.each([
    ["Reverts acme/widgets#7", true],
    ["Reverts vercel/next.js#90948", true], // observed
    ["This reverts commit 7cb95fccbe6d4382ad26787d78febd9255bb8c49", true], // observed: hand-made revert
    ["Fixes #7", false],
    ["We should revert this someday", false], // prose, not a revert PR
    ["", false],
  ])("body %j → %s", (body, expected) => {
    expect(isRevertPR({ body, branch: null })).toBe(expected);
  });

  // Observed on vercel/next.js#84628: the generated body was rewritten in
  // Spanish, losing the `Reverts` prefix entirely. The branch is what survived.
  // This is exactly why ADR-0003 [5] says the body is not contractual.
  it("detects a revert whose generated body was edited away", () => {
    expect(
      isRevertPR({ body: "No definido, requiere revisión vercel/next.js#84628", branch: "revert-84628-canary" })
    ).toBe(true);
  });

  // A hand-made revert pushed from a normally-named branch is only knowable
  // from git's boilerplate.
  it("detects a hand-made revert by its commit boilerplate alone", () => {
    expect(
      isRevertPR({ body: "This reverts commit d69f796522cb.", branch: "sokra/cell-not-found" })
    ).toBe(true);
  });

  it("treats null and undefined as not-a-revert", () => {
    expect(isRevertPR({ body: null, branch: null })).toBe(false);
    expect(isRevertPR({ body: undefined, branch: undefined })).toBe(false);
  });
});

describe("revertsPR", () => {
  it("matches GitHub's generated branch name", () => {
    expect(revertsPR(7, { body: null, branch: "revert-7-claude/issue-1" })).toBe(true);
  });

  it("matches GitHub's generated body", () => {
    expect(revertsPR(7, { body: "Reverts acme/widgets#7", branch: "somebranch" })).toBe(true);
  });

  // Body rewritten (observed), branch intact: the branch still identifies it.
  it("matches on the branch when the body no longer says `Reverts`", () => {
    expect(
      revertsPR(84628, {
        body: "No definido, requiere revisión vercel/next.js#84628",
        branch: "revert-84628-canary",
      })
    ).toBe(true);
  });

  // A hand-made revert names no PR number anywhere, so it cannot be attributed
  // to one. It is still excluded from issue linkage by isRevertPR.
  it("does not attribute a hand-made revert to any PR number", () => {
    const handMade = { body: "This reverts commit d69f796522cb.", branch: "sokra/cell-not-found" };
    expect(revertsPR(7, handMade)).toBe(false);
    expect(isRevertPR(handMade)).toBe(true);
  });

  // The body text is not contractual (ADR-0003 [5]); the branch is the primary
  // signal. But a digit-boundary bug here attaches a revert to the wrong PR.
  it("is digit-bounded on the branch", () => {
    expect(revertsPR(7, { body: null, branch: "revert-77-x" })).toBe(false);
    expect(revertsPR(7, { body: null, branch: "revert-70-x" })).toBe(false);
    expect(revertsPR(77, { body: null, branch: "revert-77-x" })).toBe(true);
  });

  it("is digit-bounded on the body", () => {
    expect(revertsPR(7, { body: "Reverts acme/widgets#70", branch: null })).toBe(false);
    expect(revertsPR(1, { body: "Reverts acme/widgets#10", branch: null })).toBe(false);
  });

  it("does not match a revert of a different PR", () => {
    expect(revertsPR(7, { body: "Reverts acme/widgets#9", branch: "revert-9-x" })).toBe(false);
  });

  it("does not match the original PR itself", () => {
    expect(revertsPR(7, { body: "Fixes #1", branch: "claude/issue-1" })).toBe(false);
  });
});

// GitLab never names the original MR in a revert. Its revert MR carries git's
// boilerplate citing the *commit* it reverted — which is the original MR's
// merge_commit_sha (or squash_commit_sha, when the project squashes; ADR-0003
// [3]). So GitLab attribution goes through the sha, not the iid.
describe("revertsCommit", () => {
  const SHA = "7cb95fccbe6d4382ad26787d78febd9255bb8c49";

  it("matches git's boilerplate with the full sha", () => {
    expect(revertsCommit(SHA, { body: `This reverts commit ${SHA}.`, branch: "x" })).toBe(true);
  });

  it("matches when the body abbreviates the sha", () => {
    expect(revertsCommit(SHA, { body: "This reverts commit 7cb95fc.", branch: "x" })).toBe(true);
  });

  it("matches GitLab's generated branch, which uses a short sha", () => {
    expect(revertsCommit(SHA, { body: null, branch: "revert-7cb95fcc" })).toBe(true);
  });

  it("does not match a revert of a different commit", () => {
    expect(
      revertsCommit(SHA, { body: "This reverts commit d69f796522cb843b.", branch: "revert-d69f7965" })
    ).toBe(false);
  });

  it("does not match an unrelated body or branch", () => {
    expect(revertsCommit(SHA, { body: "Fixes #7", branch: "claude/issue-7" })).toBe(false);
    expect(revertsCommit(SHA, { body: null, branch: null })).toBe(false);
  });

  // A 7-char prefix is git's default abbreviation; anything shorter is too
  // collision-prone to attribute a production revert to.
  it("ignores an implausibly short sha fragment", () => {
    expect(revertsCommit(SHA, { body: "This reverts commit 7cb9.", branch: "x" })).toBe(false);
  });
});

describe("findRevert", () => {
  const prs = [
    { id: "unrelated", body: "Fixes #2", branch: "claude/issue-2" },
    { id: "revert-of-9", body: "Reverts acme/widgets#9", branch: "revert-9-claude/issue-2" },
    { id: "revert-of-7", body: "Reverts acme/widgets#7", branch: "revert-7-claude/issue-1" },
  ];
  const toCandidate = (p: (typeof prs)[number]) => ({ body: p.body, branch: p.branch });

  it("finds the revert of the given PR number", () => {
    expect(findRevert(7, prs, toCandidate)?.id).toBe("revert-of-7");
    expect(findRevert(9, prs, toCandidate)?.id).toBe("revert-of-9");
  });

  it("returns undefined when no revert exists for that PR", () => {
    expect(findRevert(2, prs, toCandidate)).toBeUndefined();
  });
});

describe("findRevertOfCommit", () => {
  const SHA = "7cb95fccbe6d4382ad26787d78febd9255bb8c49";
  const mrs = [
    { id: "unrelated", body: "Fixes #2", branch: "claude/issue-2" },
    { id: "other-revert", body: "This reverts commit d69f796522cb.", branch: "revert-d69f7965" },
    { id: "the-revert", body: `This reverts commit ${SHA}.`, branch: "revert-7cb95fcc" },
  ];
  const toCandidate = (m: (typeof mrs)[number]) => ({ body: m.body, branch: m.branch });

  it("finds the revert of the given commit", () => {
    expect(findRevertOfCommit(SHA, mrs, toCandidate)?.id).toBe("the-revert");
  });

  it("returns undefined when nothing reverts that commit", () => {
    expect(findRevertOfCommit("a".repeat(40), mrs, toCandidate)).toBeUndefined();
  });
});
