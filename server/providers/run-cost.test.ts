import { describe, it, expect } from "vitest";
import { computeActionsCost, ACTIONS_USD_PER_MINUTE_STANDARD } from "./run-cost.js";

// T2-4 (ticket #14) — aggregate provider run-timing into an Actions cost.
//
// The load-bearing distinction: a run whose timing we could NOT fetch is
// `unknown`, never $0. A silent zero makes the ticket look cheaper than it was,
// exactly where the number is actually absent — the same failure shape as #10's
// unpriceable-model case. A run that legitimately billed zero ms (skipped,
// cached) is a real zero and IS counted.

describe("computeActionsCost", () => {
  it("is empty for no runs", () => {
    expect(computeActionsCost([])).toEqual({ minutes: 0, usd: 0, unknownRuns: 0 });
  });

  it("sums billable minutes and prices them at the standard-runner rate", () => {
    const cost = computeActionsCost([
      { runId: "1", billableMs: 120_000 }, // 2 min
      { runId: "2", billableMs: 30_000 }, //  0.5 min
    ]);
    expect(cost.minutes).toBeCloseTo(2.5, 6);
    expect(cost.usd).toBeCloseTo(2.5 * ACTIONS_USD_PER_MINUTE_STANDARD, 9);
    expect(cost.unknownRuns).toBe(0);
  });

  it("counts a run with no timing as unknown, never as zero minutes", () => {
    const cost = computeActionsCost([{ runId: "1", billableMs: 60_000 }, null]);
    expect(cost.minutes).toBeCloseTo(1, 6);
    expect(cost.unknownRuns).toBe(1);
  });

  it("treats a genuine zero-ms run as a real zero, not unknown", () => {
    // A skipped or fully-cached run bills 0 ms — that is a known zero, and the
    // provider DID give it to us, so it is not an unknown.
    const cost = computeActionsCost([{ runId: "1", billableMs: 0 }]);
    expect(cost).toEqual({ minutes: 0, usd: 0, unknownRuns: 0 });
  });
});
