import { describe, it, expect } from "vitest";
import { linksToIssue, findLinked } from "./linkage.js";

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
});
