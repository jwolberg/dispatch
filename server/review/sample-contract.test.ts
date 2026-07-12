import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReviewArtifact, evaluateShipGate } from "./artifact.js";

// T2-5 / T2-4 bridge (ticket #34) — the review-artifact CONTRACT is the whole
// interface between the CI emitter and Dispatch's gate. The `ci-review` skill
// (scripts/repo-skills/ci-review) must emit an artifact that Dispatch's #15
// parser accepts; if the two ever drift, the gate reads every PR as unreviewed
// and blocks it. This test pins a committed sample of exactly that format and
// runs it through the real parser + gate, so a format change fails here loudly.

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, "__fixtures__", "sample-review");
const read = (name: string) => readFileSync(resolve(DIR, name), "utf8");

describe("the ci-review sample artifact honors the #15 parser contract", () => {
  const md = read("1a2b3c4.md");
  const findings = read("findings.json");

  it("parses into a complete ReviewArtifact", () => {
    const review = parseReviewArtifact(md, findings);
    expect(review).not.toBeNull();
    expect(review?.verdict).toBe("approve");
    expect(review?.testStatus).toBe("pass");
    // Only the one low-severity finding — nothing blocking.
    expect(review?.openFindings).toEqual({ critical: 0, high: 0, medium: 0, low: 1 });
  });

  it("passes the ship gate (approve + pass + no medium-or-above)", () => {
    const gate = evaluateShipGate(parseReviewArtifact(md, findings));
    expect(gate.allowed).toBe(true);
  });

  it("has valid JSON in findings.json and suggestions.json", () => {
    expect(() => JSON.parse(read("findings.json"))).not.toThrow();
    expect(() => JSON.parse(read("suggestions.json"))).not.toThrow();
  });
});
