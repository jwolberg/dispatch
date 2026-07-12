import { describe, it, expect } from "vitest";
import { parseReviewArtifact, evaluateShipGate } from "./artifact.js";

// T2-5 (ticket #15) — the review gate is a security control: Dispatch holds a
// token that merges to production. Fail-closed is the ENTIRE property. Every
// test here that asserts `allowed: false` is guarding a way the gate could open
// when it must not — a missing artifact, a non-approve verdict, a red test run,
// or an open medium+ finding. The merge bar (CLAUDE.md [6]):
//   verdict: approve  +  test_status: pass  +  zero open findings >= medium.

const FM = (over: Record<string, string> = {}) => {
  const fields = { verdict: "approve", test_status: "pass", ...over };
  const body = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\npr: acme/widgets#7\ncommit: ${"a".repeat(40)}\n${body}\n---\n\n## Summary\nlgtm\n`;
};

const findings = (list: { severity: string; status: string }[]) =>
  JSON.stringify({ pr: "acme/widgets#7", updated_at: "", findings: list });

describe("parseReviewArtifact", () => {
  it("reads verdict, test_status, and open findings by severity", () => {
    const review = parseReviewArtifact(
      FM(),
      findings([
        { severity: "high", status: "open" },
        { severity: "low", status: "open" },
        { severity: "critical", status: "resolved" },
      ])
    );
    expect(review).not.toBeNull();
    expect(review?.verdict).toBe("approve");
    expect(review?.testStatus).toBe("pass");
    expect(review?.openFindings).toEqual({ critical: 0, high: 1, medium: 0, low: 1 });
  });

  it("is null when the markdown is missing — nothing to trust", () => {
    expect(parseReviewArtifact(null, findings([]))).toBeNull();
    expect(parseReviewArtifact("", findings([]))).toBeNull();
  });

  it("is null when the frontmatter lacks verdict or test_status (unparseable)", () => {
    expect(parseReviewArtifact("---\npr: x\n---\n", findings([]))).toBeNull();
    expect(parseReviewArtifact(FM({ verdict: "" }), findings([]))).toBeNull();
  });

  it("is null when findings.json is missing or unparseable — an incomplete artifact", () => {
    expect(parseReviewArtifact(FM(), null)).toBeNull();
    expect(parseReviewArtifact(FM(), "{not json")).toBeNull();
  });

  it("strips quotes and inline comments from frontmatter values", () => {
    const md = `---\nverdict: approve\ntest_status: "pass"\n---\n`;
    expect(parseReviewArtifact(md, findings([]))?.testStatus).toBe("pass");
  });
});

describe("evaluateShipGate — fail-closed", () => {
  const ok = parseReviewArtifact(FM(), findings([]));

  it("allows the full bar: approve + pass + zero medium-or-above", () => {
    expect(evaluateShipGate(ok).allowed).toBe(true);
  });

  it("BLOCKS a missing artifact — the normal state right after onboarding", () => {
    const gate = evaluateShipGate(null);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/review/i);
  });

  it("BLOCKS when the verdict is not approve", () => {
    expect(evaluateShipGate(parseReviewArtifact(FM({ verdict: "request-changes" }), findings([]))).allowed).toBe(false);
    expect(evaluateShipGate(parseReviewArtifact(FM({ verdict: "blocked" }), findings([]))).allowed).toBe(false);
  });

  it("BLOCKS when tests did not pass", () => {
    for (const s of ["fail", "partial", "error", "missing"]) {
      expect(evaluateShipGate(parseReviewArtifact(FM({ test_status: s }), findings([]))).allowed).toBe(false);
    }
  });

  it("BLOCKS on an open finding at medium or above; ignores low and resolved", () => {
    const blocks = (sev: string, status = "open") =>
      evaluateShipGate(parseReviewArtifact(FM(), findings([{ severity: sev, status }]))).allowed;
    expect(blocks("critical")).toBe(false);
    expect(blocks("high")).toBe(false);
    expect(blocks("medium")).toBe(false);
    expect(blocks("low")).toBe(true); // low does not block
    expect(blocks("high", "resolved")).toBe(true); // resolved does not block
  });
});
