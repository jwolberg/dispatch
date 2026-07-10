import { describe, expect, it } from "vitest";
import { pollCanary } from "./canary.js";
import type { RawRun } from "./canary.js";

// #5 — the bounded poll loop around classifyCanaryRun. A cold Actions runner can
// take a minute to pick up a job, so the window must be generous; but it must be
// bounded, and a window that expires is a FAIL, never a hang. Two distinct
// timeouts: no run ever appeared, vs a run appeared and never left pending
// (the action_required-as-status case, which stalls rather than completing).

// A fake clock: sleep() just advances virtual time, so tests run instantly.
function fakeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const CFG = { windowMs: 60_000, intervalMs: 5_000 };

describe("pollCanary", () => {
  it("returns pass as soon as the run completes with success, without polling to the deadline", async () => {
    const clock = fakeClock();
    // pending twice, then success.
    const seq: (RawRun | null)[] = [
      { status: "in_progress", conclusion: null },
      { status: "in_progress", conclusion: null },
      { status: "completed", conclusion: "success" },
    ];
    let i = 0;
    const verdict = await pollCanary(async () => seq[Math.min(i++, seq.length - 1)], CFG, clock);

    expect(verdict.outcome).toBe("pass");
    // It stopped early — nowhere near the 60s deadline.
    expect(clock.now()).toBeLessThan(CFG.windowMs);
  });

  it("returns fail immediately when the run parks in action_required", async () => {
    const clock = fakeClock();
    const verdict = await pollCanary(
      async () => ({ status: "action_required", conclusion: null }),
      CFG,
      clock
    );
    expect(verdict.outcome).toBe("fail");
    expect(verdict.reason.toLowerCase()).toContain("approval");
  });

  it("fails on timeout when no run ever appears, naming that nothing triggered", async () => {
    const clock = fakeClock();
    const verdict = await pollCanary(async () => null, CFG, clock);

    expect(verdict.outcome).toBe("fail");
    expect(verdict.reason.toLowerCase()).toMatch(/no workflow run|never|did not trigger/);
    // It actually waited out the window rather than giving up on tick one.
    expect(clock.now()).toBeGreaterThanOrEqual(CFG.windowMs);
  });

  it("fails on timeout when a run appears but never leaves pending, distinctly from 'no run'", async () => {
    const clock = fakeClock();
    const verdict = await pollCanary(
      async () => ({ status: "in_progress", conclusion: null }),
      CFG,
      clock
    );

    expect(verdict.outcome).toBe("fail");
    // A run WAS seen — the message must not claim nothing triggered.
    expect(verdict.reason.toLowerCase()).not.toContain("no workflow run");
    expect(verdict.reason.toLowerCase()).toMatch(/did not complete|still running|never finished/);
  });

  it("never polls past the window", async () => {
    const clock = fakeClock();
    let calls = 0;
    await pollCanary(
      async () => {
        calls++;
        return null;
      },
      CFG,
      clock
    );
    // windowMs / intervalMs = 12 intervals; one initial check + up to 12 more.
    expect(calls).toBeLessThanOrEqual(CFG.windowMs / CFG.intervalMs + 2);
  });
});
