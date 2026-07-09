import { describe, it, expect } from "vitest";
import {
  RISK_FLAGS,
  buildSummaryPrompt,
  parseSummary,
  SummaryParseError,
} from "./summary.js";
import { boundDiff } from "./bound-diff.js";
import type { PRDiff } from "../providers/types.js";

// T1-5 (ticket #6) — the two places this feature can lie to the user.
//
//   1. The PROMPT can present a partial diff as a whole one, and the model will
//      then write "low risk" about code it never saw. Truncation must be stated.
//
//   2. The PARSER can accept a risk flag outside the closed set, and #7 will
//      render a chip for a value it has no styling for. Reject, don't coerce.

const diff = (files: PRDiff["files"], truncated = false): PRDiff => ({ files, truncated });

const file = (over: Partial<PRDiff["files"][number]> = {}) => ({
  path: "src/app.ts",
  status: "modified" as const,
  additions: 1,
  deletions: 0,
  patch: "@@ -1 +1 @@\n-a\n+b",
  ...over,
});

describe("buildSummaryPrompt — what the model is told it is looking at", () => {
  it("names every changed file, with its status and line counts", () => {
    const bounded = boundDiff(
      diff([
        file({ path: "src/auth.ts", additions: 12, deletions: 3 }),
        file({ path: "README.md", status: "added", additions: 40, deletions: 0 }),
      ]),
    );
    const { user } = buildSummaryPrompt("Add login", bounded);

    expect(user).toContain("src/auth.ts");
    expect(user).toContain("+12");
    expect(user).toContain("-3");
    expect(user).toContain("README.md");
    expect(user).toContain("added");
  });

  it("includes the PR title — it is the author's own one-line summary", () => {
    const { user } = buildSummaryPrompt("Add rate limiting", boundDiff(diff([file()])));
    expect(user).toContain("Add rate limiting");
  });

  it("includes patch text when it fits", () => {
    const { user } = buildSummaryPrompt("t", boundDiff(diff([file({ patch: "@@ UNIQUE_HUNK @@" })])));
    expect(user).toContain("UNIQUE_HUNK");
  });

  it("says nothing about truncation when the whole diff fits", () => {
    const { user } = buildSummaryPrompt("t", boundDiff(diff([file()])));
    expect(user.toLowerCase()).not.toContain("truncat");
  });

  it("STATES the truncation when patches were cut, so the model knows it is partial", () => {
    const big = file({ patch: "x".repeat(50_000) });
    const bounded = boundDiff(diff([big]), 1_000);
    expect(bounded.truncated).toBe(true);

    const { user } = buildSummaryPrompt("t", bounded);
    expect(user.toLowerCase()).toContain("truncat");
  });

  it("states the truncation when the PROVIDER capped the file list, even if every patch fit", () => {
    // We were given everything we asked for, but not everything there is.
    const bounded = boundDiff(diff([file({ patch: "@@ tiny @@" })], true));
    const { user } = buildSummaryPrompt("t", bounded);
    expect(user.toLowerCase()).toContain("truncat");
  });

  it("marks the individual file whose patch was cut, not just the diff as a whole", () => {
    const bounded = boundDiff(diff([file({ path: "huge.ts", patch: "x".repeat(50_000) })]), 1_000);
    const { user } = buildSummaryPrompt("t", bounded);

    const line = user.split("\n").find((l) => l.includes("huge.ts"));
    expect(line?.toLowerCase()).toContain("truncat");
  });

  it("tells the model to escalate risk when it cannot see the whole change", () => {
    const bounded = boundDiff(diff([file({ patch: "x".repeat(50_000) })]), 1_000);
    const { system, user } = buildSummaryPrompt("t", bounded);
    // Somewhere in the prompt, the partial view must be tied to the risk flag —
    // otherwise "low" means "low, as far as I could see", which reads as "low".
    expect(`${system}\n${user}`).toMatch(/review-this/);
  });

  it("asks for the closed risk vocabulary and nothing else", () => {
    const { system } = buildSummaryPrompt("t", boundDiff(diff([file()])));
    for (const flag of RISK_FLAGS) expect(system).toContain(flag);
  });
});

describe("parseSummary — the risk flag is a closed set", () => {
  const valid = { whatChanged: "Adds login.", howToTest: "Click sign in.", risk: "low" };

  it("parses a clean JSON object", () => {
    expect(parseSummary(JSON.stringify(valid))).toEqual(valid);
  });

  it("tolerates a fenced code block, which models emit despite being asked not to", () => {
    const fenced = "```json\n" + JSON.stringify(valid) + "\n```";
    expect(parseSummary(fenced)).toEqual(valid);
  });

  it("tolerates leading prose before the object", () => {
    expect(parseSummary(`Here you go:\n${JSON.stringify(valid)}`)).toEqual(valid);
  });

  it("accepts every flag in the closed set", () => {
    for (const risk of RISK_FLAGS) {
      expect(parseSummary(JSON.stringify({ ...valid, risk })).risk).toBe(risk);
    }
  });

  it("rejects a risk flag outside the set rather than coercing it to low", () => {
    // "medium" has no chip in #7. Rendering nothing is honest; rendering "low"
    // is a lie the user cannot detect.
    expect(() => parseSummary(JSON.stringify({ ...valid, risk: "medium" }))).toThrow(
      SummaryParseError,
    );
  });

  it("rejects a missing risk flag", () => {
    expect(() => parseSummary(JSON.stringify({ whatChanged: "x", howToTest: "y" }))).toThrow(
      SummaryParseError,
    );
  });

  it("rejects an empty whatChanged — a blank card is worse than no card", () => {
    expect(() => parseSummary(JSON.stringify({ ...valid, whatChanged: "  " }))).toThrow(
      SummaryParseError,
    );
  });

  it("rejects a non-string field", () => {
    expect(() => parseSummary(JSON.stringify({ ...valid, howToTest: 42 }))).toThrow(
      SummaryParseError,
    );
  });

  it("rejects prose that contains no JSON at all", () => {
    expect(() => parseSummary("I'd be happy to help!")).toThrow(SummaryParseError);
  });

  it("rejects an empty response", () => {
    expect(() => parseSummary("")).toThrow(SummaryParseError);
  });

  it("drops fields it was not asked for rather than passing them through to the cache", () => {
    const parsed = parseSummary(JSON.stringify({ ...valid, injected: "<script>" }));
    expect(parsed).toEqual(valid);
  });
});
