import { describe, expect, it } from "vitest";
import { createFailureLimiter } from "./auth-limiter.js";

// #32 — the only control on a public, credential-holding service must not hand
// out unlimited anonymous password guesses. A per-IP failure limiter blocks an
// IP after N failures in a window; a correct password resets it; the window
// expiring frees it. Deterministic via an injected clock.

function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const WINDOW = 15 * 60_000;

describe("createFailureLimiter", () => {
  it("blocks an IP only after it reaches the failure cap within the window", () => {
    const clock = fixedClock();
    const lim = createFailureLimiter({ max: 5, windowMs: WINDOW, now: clock.now });

    for (let i = 0; i < 4; i++) lim.recordFailure("1.2.3.4");
    expect(lim.isBlocked("1.2.3.4")).toBe(false); // 4 < cap

    lim.recordFailure("1.2.3.4"); // 5th
    expect(lim.isBlocked("1.2.3.4")).toBe(true);
  });

  it("tracks IPs independently", () => {
    const clock = fixedClock();
    const lim = createFailureLimiter({ max: 3, windowMs: WINDOW, now: clock.now });
    for (let i = 0; i < 3; i++) lim.recordFailure("attacker");
    expect(lim.isBlocked("attacker")).toBe(true);
    expect(lim.isBlocked("innocent")).toBe(false);
  });

  it("a reset (a correct password) clears the IP's failures", () => {
    const clock = fixedClock();
    const lim = createFailureLimiter({ max: 3, windowMs: WINDOW, now: clock.now });
    lim.recordFailure("ip");
    lim.recordFailure("ip");
    lim.reset("ip");
    lim.recordFailure("ip");
    expect(lim.isBlocked("ip")).toBe(false); // only 1 failure since reset
  });

  it("frees the IP once the window has passed", () => {
    const clock = fixedClock();
    const lim = createFailureLimiter({ max: 3, windowMs: WINDOW, now: clock.now });
    for (let i = 0; i < 3; i++) lim.recordFailure("ip");
    expect(lim.isBlocked("ip")).toBe(true);

    clock.advance(WINDOW + 1);
    expect(lim.isBlocked("ip")).toBe(false); // stale failures pruned
  });
});
