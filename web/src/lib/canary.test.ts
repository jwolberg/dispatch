import { describe, expect, it } from "vitest";
import { canaryChip } from "./canary.js";

// #5 — the repo card's canary chip. It only means anything once a workflow
// exists (a repo with none shows the onboarding warning instead), and it must
// carry the actionable reason on a fail, not just a red dot.

describe("canaryChip", () => {
  it("is hidden until automation is detected", () => {
    expect(canaryChip("pass", null, "2026-07-11T00:00:00Z", 0)).toBeNull();
    expect(canaryChip(null, null, null, null)).toBeNull();
  });

  it("shows a pass chip when the build was verified", () => {
    const chip = canaryChip("pass", "", "2026-07-11T00:00:00Z", 1);
    expect(chip?.tone).toBe("pass");
    expect(chip?.label.toLowerCase()).toContain("verified");
  });

  it("shows a fail chip carrying the actionable reason", () => {
    const chip = canaryChip("fail", "The token that opened this event cannot trigger runs.", "t", 1);
    expect(chip?.tone).toBe("fail");
    expect(chip?.title).toContain("cannot trigger");
  });

  it("shows a pending chip when automation exists but no verdict has landed yet", () => {
    const chip = canaryChip(null, null, null, 1);
    expect(chip?.tone).toBe("pending");
  });
});
