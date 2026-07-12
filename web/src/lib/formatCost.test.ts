import { describe, it, expect } from "vitest";
import { usd, compactTokens } from "./formatCost.js";

// T2-4 (ticket #14) — the pure formatting behind the cost line. Tested because a
// mis-scaled token count ("1.5" for 1.5M) or a rounded-to-zero sub-cent cost
// would misrepresent the number, which is the whole point of the feature.

describe("usd", () => {
  it("shows cents for dollar-scale amounts", () => {
    expect(usd(36)).toBe("$36.00");
    expect(usd(1.5)).toBe("$1.50");
  });

  it("keeps sub-cent Actions costs visible instead of rounding to $0.00", () => {
    expect(usd(0.016)).toBe("$0.0160");
    expect(usd(0)).toBe("$0.0000");
  });
});

describe("compactTokens", () => {
  it("scales millions and thousands with a suffix", () => {
    expect(compactTokens(1_500_000)).toBe("1.5M");
    expect(compactTokens(2_000)).toBe("2.0K");
  });

  it("shows small counts verbatim", () => {
    expect(compactTokens(500)).toBe("500");
    expect(compactTokens(0)).toBe("0");
  });
});
