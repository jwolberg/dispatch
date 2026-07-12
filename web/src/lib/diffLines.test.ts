import { describe, it, expect } from "vitest";
import { parsePatch, type DiffLine } from "./diffLines.js";

// T2-1 (ticket #11) — the pure logic behind the in-app diff view.
//
// Per the suite's convention (vitest.config.ts): components are verified by
// typecheck and by eye; what gets a test is the pure rule they render. Here that
// rule is "classify each line of a unified patch so the view can colour it".
// Getting an added line wrong (green where it should be red) is the diff lying
// about direction — the same class of bug T1-6's verdict rule guards against.

const kinds = (patch: string): DiffLine["kind"][] => parsePatch(patch).map((l) => l.kind);

describe("parsePatch — classifies unified-diff lines by direction", () => {
  it("marks + as an addition and - as a deletion", () => {
    const lines = parsePatch("@@ -1,2 +1,2 @@\n context\n-old\n+new");
    expect(lines).toEqual([
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "context", text: " context" },
      { kind: "del", text: "-old" },
      { kind: "add", text: "+new" },
    ]);
  });

  it("does not mistake the +++/--- file headers for add/del lines", () => {
    // GitLab patches carry the file headers inline; GitHub's usually start at @@.
    expect(kinds("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b")).toEqual([
      "meta",
      "meta",
      "hunk",
      "del",
      "add",
    ]);
  });

  it("treats the no-newline marker as meta, not a deletion", () => {
    // `\ No newline at end of file` starts with a backslash, not a minus, but a
    // naive first-char check would still need to exclude it.
    expect(kinds("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file")).toEqual([
      "hunk",
      "del",
      "add",
      "meta",
    ]);
  });

  it("keeps a blank context line as context, not an empty nothing", () => {
    // A bare empty string in a patch is an unchanged blank line (one space is
    // stripped by the provider on the zero-width context line).
    expect(kinds("@@ -1 +1 @@\n\n+x")).toEqual(["hunk", "context", "add"]);
  });

  it("is empty for an empty patch", () => {
    expect(parsePatch("")).toEqual([]);
  });
});
