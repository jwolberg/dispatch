import { describe, it, expect } from "vitest";
import { newLineNumberAt, formatSteerComment, isAnchorOutdated } from "./steerAnchor.js";

// T2-2 (ticket #12) — steering the agent from a diff line. The pure pieces:
// mapping a rendered patch line to its real file line, formatting the @claude
// comment, and the outdated check. The design note's whole point: a comment
// must NEVER silently point at the wrong line after a push — so the comment
// carries the code snippet + the sha it was made against, and the UI marks it
// outdated when the head has moved.

// A patch: hunk starts at new-file line 10.
//   10  context
//   11  +added one
//   12  +added two
//       -removed (no new-file line)
//   13  context after
const PATCH = [
  "@@ -10,3 +10,4 @@ func()",
  " context",
  "+added one",
  "+added two",
  "-removed",
  " context after",
].join("\n");

describe("newLineNumberAt — maps a rendered line to its new-file line number", () => {
  const lineNo = (i: number) => newLineNumberAt(PATCH, i);

  it("returns null for the hunk header itself", () => {
    expect(lineNo(0)).toBeNull();
  });

  it("counts context and added lines against the new file", () => {
    expect(lineNo(1)).toBe(10); // " context"
    expect(lineNo(2)).toBe(11); // "+added one"
    expect(lineNo(3)).toBe(12); // "+added two"
  });

  it("returns null for a deleted line — it has no line in the new file", () => {
    expect(lineNo(4)).toBeNull(); // "-removed"
  });

  it("resumes the count after a deletion", () => {
    expect(lineNo(5)).toBe(13); // " context after"
  });

  it("returns null for an out-of-range or unparseable index", () => {
    expect(lineNo(99)).toBeNull();
    expect(newLineNumberAt("no hunk header here", 0)).toBeNull();
  });
});

describe("formatSteerComment", () => {
  const anchor = { file: "src/auth.ts", line: 11, code: "added one", headSha: "abcdef1234567890" };

  it("mentions @claude, the file:line, the short sha, and includes the code snippet", () => {
    const body = formatSteerComment(anchor, "should this be awaited?");
    expect(body).toContain("@claude");
    expect(body).toContain("src/auth.ts");
    expect(body).toContain("11");
    expect(body).toContain("abcdef1"); // short sha, so the anchor names a commit
    expect(body).toContain("added one"); // the code, so it survives a line shift
    expect(body).toContain("should this be awaited?");
  });

  it("trims the note and never posts an empty instruction", () => {
    expect(formatSteerComment(anchor, "   fix this  ")).toContain("fix this");
    expect(() => formatSteerComment(anchor, "   ")).toThrow();
  });
});

describe("isAnchorOutdated — the case the design note says will be skipped", () => {
  it("is outdated when the head moved past the anchored sha", () => {
    expect(isAnchorOutdated("aaa", "bbb")).toBe(true);
  });

  it("is current when the head still matches the anchored sha", () => {
    expect(isAnchorOutdated("aaa", "aaa")).toBe(false);
  });

  it("is not outdated when the current head is unknown (don't cry wolf)", () => {
    expect(isAnchorOutdated("aaa", null)).toBe(false);
  });
});
