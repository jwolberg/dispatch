import { describe, it, expect } from "vitest";
import { boundDiff, DEFAULT_PATCH_BUDGET_BYTES, MIN_USEFUL_PATCH_BYTES } from "./bound-diff.js";
import type { PRFileDiff } from "../providers/types.js";

// T1-5 (ticket #6) — what we are willing to send to Anthropic, and what we say
// about what we left out.
//
// Two invariants, both of which cost money or truth if broken:
//
//   - The FILE LIST is never truncated. Paths and line counts are cheap and are
//     most of the signal ("it touched the auth middleware"). Only PATCHES are
//     dropped. Truncating the file list would let the model confidently
//     describe a change while blind to the file that matters.
//
//   - Truncation is always reported. A partial diff presented as whole is worse
//     than no diff: the model writes "this change is low risk" about code it
//     never saw. `truncated` drives a sentence in the prompt.

function file(over: Partial<PRFileDiff> = {}): PRFileDiff {
  return {
    path: "src/index.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: "@@ -1 +1 @@\n-a\n+b",
    ...over,
  };
}

/** A patch of exactly `n` bytes. */
const patchOf = (n: number) => "x".repeat(n);

describe("boundDiff — the file list survives intact", () => {
  it("returns every file, in provider order, even when the budget is zero", () => {
    const files = [
      file({ path: "a.ts" }),
      file({ path: "b.ts" }),
      file({ path: "c.ts" }),
    ];
    const bounded = boundDiff({ files, truncated: false }, 0);

    expect(bounded.files.map((f) => f.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("preserves each file's status and line counts regardless of budget", () => {
    const files = [file({ path: "gone.ts", status: "removed", additions: 0, deletions: 40 })];
    const bounded = boundDiff({ files, truncated: false }, 0);

    expect(bounded.files[0]).toMatchObject({
      path: "gone.ts",
      status: "removed",
      additions: 0,
      deletions: 40,
    });
  });

  it("does not reorder files by size — the biggest change must not hide the first", () => {
    const files = [
      file({ path: "small.ts", patch: patchOf(10) }),
      file({ path: "huge.ts", patch: patchOf(10_000) }),
    ];
    const bounded = boundDiff({ files, truncated: false }, 50);

    expect(bounded.files.map((f) => f.path)).toEqual(["small.ts", "huge.ts"]);
  });
});

describe("boundDiff — patches are spent against the budget in order", () => {
  it("keeps every patch when they all fit", () => {
    const files = [file({ patch: patchOf(10) }), file({ path: "b.ts", patch: patchOf(10) })];
    const bounded = boundDiff({ files, truncated: false }, 100);

    expect(bounded.files.every((f) => f.patch !== null)).toBe(true);
    expect(bounded.truncated).toBe(false);
    expect(bounded.bytesUsed).toBe(20);
  });

  it("drops later patches once the budget is exhausted, keeping earlier ones whole", () => {
    const files = [
      file({ path: "a.ts", patch: patchOf(60) }),
      file({ path: "b.ts", patch: patchOf(60) }),
    ];
    const bounded = boundDiff({ files, truncated: false }, 60);

    expect(bounded.files[0].patch).toBe(patchOf(60));
    expect(bounded.files[1].patch).toBeNull();
    expect(bounded.truncated).toBe(true);
  });

  it("truncates a patch that only partly fits, and marks that file", () => {
    const files = [file({ path: "a.ts", patch: patchOf(1000) })];
    const budget = MIN_USEFUL_PATCH_BYTES + 50;
    const bounded = boundDiff({ files, truncated: false }, budget);

    expect(bounded.files[0].patch).toHaveLength(budget);
    expect(bounded.files[0].patchTruncated).toBe(true);
    expect(bounded.truncated).toBe(true);
  });

  it("omits a patch rather than emitting a uselessly short fragment", () => {
    // A 3-byte slice of a hunk teaches the model nothing and still costs tokens.
    // `a` consumes 100 bytes; `b` cannot fit and the leftover is below the floor.
    const files = [
      file({ path: "a.ts", patch: patchOf(100) }),
      file({ path: "b.ts", patch: patchOf(500) }),
    ];
    const bounded = boundDiff({ files, truncated: false }, 100 + MIN_USEFUL_PATCH_BYTES - 1);

    expect(bounded.files[1].patch).toBeNull();
    expect(bounded.files[1].patchTruncated).toBe(false);
    expect(bounded.truncated).toBe(true);
  });

  it("never exceeds the byte budget", () => {
    const files = Array.from({ length: 20 }, (_, i) =>
      file({ path: `f${i}.ts`, patch: patchOf(500) }),
    );
    const bounded = boundDiff({ files, truncated: false }, 1234);

    expect(bounded.bytesUsed).toBeLessThanOrEqual(1234);
  });
});

describe("boundDiff — binary files cost nothing and are not truncation", () => {
  it("passes a null patch through without spending budget", () => {
    const files = [
      file({ path: "logo.png", status: "added", patch: null }),
      file({ path: "a.ts", patch: patchOf(10) }),
    ];
    const bounded = boundDiff({ files, truncated: false }, 100);

    expect(bounded.files[0].patch).toBeNull();
    expect(bounded.bytesUsed).toBe(10);
    // A binary file has no patch to omit — reporting truncation here would make
    // the prompt claim we hid something we never had.
    expect(bounded.truncated).toBe(false);
  });
});

describe("boundDiff — provider-side truncation is carried forward, never swallowed", () => {
  it("stays truncated when the provider already capped the file list", () => {
    const files = [file({ patch: patchOf(5) })];
    const bounded = boundDiff({ files, truncated: true }, 10_000);

    // Everything we were given fits, but we were not given everything.
    expect(bounded.truncated).toBe(true);
  });
});

describe("boundDiff — the budget is documented and sane", () => {
  it("has a default budget large enough to be useful and small enough to bound cost", () => {
    expect(DEFAULT_PATCH_BUDGET_BYTES).toBeGreaterThan(4_000);
    expect(DEFAULT_PATCH_BUDGET_BYTES).toBeLessThanOrEqual(64_000);
  });

  it("rejects a negative budget rather than silently treating it as zero", () => {
    expect(() => boundDiff({ files: [file()], truncated: false }, -1)).toThrow();
  });
});
