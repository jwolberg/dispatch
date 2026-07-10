import { describe, expect, it } from "vitest";
import { classifyCanaryRun } from "./canary.js";

// #5 — the canary's verdict logic. The whole point (ADR-0002) is that a
// workflow_run *existing* is not success: a PR opened by a token that cannot
// trigger workflows still creates a run, which then parks in `action_required`
// forever. So `success` is the ONLY pass, and the two failure signatures must be
// told apart by message, not collapsed together.
//
// This classifier reads the RAW GitHub (status, conclusion) rather than the
// provider's `RunState`, because `mapRun` folds `action_required` into
// `neutral`/`in_progress` — erasing exactly the distinction this ticket exists to
// surface.

describe("classifyCanaryRun", () => {
  it("passes ONLY on a completed run whose conclusion is success", () => {
    const v = classifyCanaryRun({ status: "completed", conclusion: "success" });
    expect(v.outcome).toBe("pass");
  });

  it("fails a run parked in action_required — the ADR-0002 signature", () => {
    // status: "action_required" is the run awaiting "Approve and run". It never
    // reaches `completed`, so a naive 'still pending?' check would poll it until
    // timeout and a naive 'a run exists?' check would call it green. Neither is
    // correct: this configuration never builds anything.
    const v = classifyCanaryRun({ status: "action_required", conclusion: null });
    expect(v.outcome).toBe("fail");
    expect(v.reason.toLowerCase()).toContain("approval");
  });

  it("also catches action_required arriving as a conclusion, not just a status", () => {
    const v = classifyCanaryRun({ status: "completed", conclusion: "action_required" });
    expect(v.outcome).toBe("fail");
    expect(v.reason.toLowerCase()).toContain("approval");
  });

  it("fails a run that started and died at a conclusion of failure — the #25 signature", () => {
    // #25: the run began and failed 27s later at the App token exchange. A
    // presence check would have called this green.
    const v = classifyCanaryRun({ status: "completed", conclusion: "failure" });
    expect(v.outcome).toBe("fail");
    expect(v.reason).toMatch(/fail/i);
  });

  it("treats the other terminal non-success conclusions as failures", () => {
    for (const conclusion of ["startup_failure", "timed_out", "cancelled"]) {
      expect(classifyCanaryRun({ status: "completed", conclusion }).outcome).toBe("fail");
    }
  });

  it("stays pending while the run is still queued or in progress, so the poll loop keeps waiting", () => {
    expect(classifyCanaryRun({ status: "queued", conclusion: null }).outcome).toBe("pending");
    expect(classifyCanaryRun({ status: "in_progress", conclusion: null }).outcome).toBe("pending");
  });

  it("every non-pass verdict carries a non-empty, human-actionable reason", () => {
    const failing = [
      { status: "action_required", conclusion: null },
      { status: "completed", conclusion: "failure" },
      { status: "completed", conclusion: "startup_failure" },
    ];
    for (const raw of failing) {
      expect(classifyCanaryRun(raw).reason.trim().length).toBeGreaterThan(0);
    }
  });
});
