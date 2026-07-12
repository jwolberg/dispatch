import { describe, it, expect } from "vitest";
import { verdictFor, COLUMNS, type Column } from "./verdict.js";

// T1-6 (ticket #7) — the card shows ONE verdict, not seven check names.
//
// The whole risk of this ticket is a chip that flattens "still running" into
// green. T0-2's precedence table exists precisely because `Blocked` and
// `Building` are different things; a chip that renders pending as green
// re-introduces that lie one layer up, where the user actually reads it.
//
// The verdict is a function of the derived `column` and NOTHING ELSE. `column`
// is what `deriveColumn()` (server/poller/reconcile.ts) already decided by
// looking at checks and runs. Reading `pr.checks` here would be a second,
// drifting implementation of "are we green".

describe("verdictFor — pending is its own state, never green", () => {
  it("reports a green verdict only for columns where nothing is outstanding", () => {
    expect(verdictFor("Ready to test").tone).toBe("pass");
    expect(verdictFor("Merged").tone).toBe("pass");
    expect(verdictFor("Deployed").tone).toBe("pass");
  });

  it("reports a red verdict when a check or run failed", () => {
    expect(verdictFor("Blocked").tone).toBe("fail");
  });

  it("reports pending — NOT pass — while work is still in flight", () => {
    // The failure this test exists to prevent: `Building` means at least one
    // check is pending. Rendering that as green tells the user to ship.
    expect(verdictFor("Building").tone).toBe("pending");
  });

  it("reports pending for a ticket that has not started", () => {
    expect(verdictFor("Queued").tone).toBe("pending");
    expect(verdictFor("Spec").tone).toBe("pending");
  });

  it("degrades an unrecognized column to pending, never to pass", () => {
    // A column added server-side before the web catches up must fail safe.
    // Guessing "pass" here would ship an unreviewed change on a stale client.
    const unknown = verdictFor("Reticulating" as Column);
    expect(unknown.tone).toBe("pending");
  });

  it("never returns pass for any column that is not explicitly a success state", () => {
    const passing = COLUMNS.filter((c) => verdictFor(c).tone === "pass");
    expect(passing).toEqual(["Ready to test", "Merged", "Deployed"]);
  });
});

describe("verdictFor — every column is renderable", () => {
  it("gives each known column a distinct, non-empty label", () => {
    const labels = COLUMNS.map((c) => verdictFor(c).label);
    expect(labels.every((l) => l.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(COLUMNS.length);
  });

  it("pairs every verdict with an icon, so color is never the only signal", () => {
    // PRD §4 / acceptance #10: status color is always paired with an icon + text.
    for (const c of COLUMNS) expect(verdictFor(c).icon.trim()).not.toBe("");
  });

  it("is a pure function of the column — the same column always yields the same verdict", () => {
    for (const c of COLUMNS) expect(verdictFor(c)).toEqual(verdictFor(c));
  });
});
