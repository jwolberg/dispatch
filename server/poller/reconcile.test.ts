import { describe, it, expect } from "vitest";
import { deriveColumn } from "./reconcile.js";
import type { Check, PRStatus, Run, RunState } from "../providers/types.js";

// T0-2 — deriveColumn is the board's whole read path (PRD F4.1, ARCH §7).
// Columns are derived every poll and never stored, so this function alone
// decides what the user sees. The precedence it implements is:
//   Shipped > Blocked > (PR open ? Building : Ready to test) > Building > Queued

function check(state: Check["state"], name = "ci"): Check {
  return { name, state, url: null };
}

function run(state: RunState, id = "1"): Run {
  return { id, name: "Claude Code", event: "issues", title: null, state, url: null, createdAt: "" };
}

function pr(over: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 7,
    title: "Add thing",
    state: "open",
    merged: false,
    mergeable: true,
    draft: false,
    headBranch: "claude/issue-7",
    baseBranch: "main",
    url: "https://example.test/pr/7",
    checks: [],
    additions: null,
    deletions: null,
    changedFiles: null,
    previewUrl: null,
    ...over,
  };
}

describe("deriveColumn", () => {
  it("is Queued for an open issue with no PR and no runs", () => {
    expect(deriveColumn("open", null, [])).toBe("Queued");
  });

  it("is Building when a run is queued or in progress and no PR exists yet", () => {
    expect(deriveColumn("open", null, [run("queued")])).toBe("Building");
    expect(deriveColumn("open", null, [run("in_progress")])).toBe("Building");
  });

  it("is Ready to test when the PR is open and nothing is pending or failing", () => {
    expect(deriveColumn("open", pr({ checks: [check("success")] }), [run("success")])).toBe(
      "Ready to test"
    );
  });

  it("is Building when the PR is open but a check is still pending", () => {
    expect(deriveColumn("open", pr({ checks: [check("success"), check("pending")] }), [])).toBe(
      "Building"
    );
  });

  // reconcile.ts:37-42 — fine-grained PATs cannot be granted the Checks
  // permission, so pr.checks may omit Actions CI entirely. An in-progress run on
  // the PR head must still read as Building, or the card claims "Ready to test"
  // while CI is mid-flight.
  it("is Building when checks look clean but a run on the PR head is still going", () => {
    expect(deriveColumn("open", pr({ checks: [] }), [run("in_progress")])).toBe("Building");
    expect(deriveColumn("open", pr({ checks: [check("success")] }), [run("queued")])).toBe(
      "Building"
    );
  });

  describe("Blocked", () => {
    it("is Blocked when a workflow run failed", () => {
      expect(deriveColumn("open", null, [run("failure")])).toBe("Blocked");
    });

    it("is Blocked when any PR check failed", () => {
      expect(deriveColumn("open", pr({ checks: [check("success"), check("failure")] }), [])).toBe(
        "Blocked"
      );
    });

    it("outranks Building — a failure with another run still in flight is Blocked", () => {
      expect(deriveColumn("open", null, [run("failure", "1"), run("in_progress", "2")])).toBe(
        "Blocked"
      );
    });
  });

  describe("Shipped", () => {
    it("is Shipped when the issue is closed", () => {
      expect(deriveColumn("closed", null, [])).toBe("Shipped");
    });

    it("is Shipped when the PR merged, even with the issue still open", () => {
      expect(deriveColumn("open", pr({ state: "merged", merged: true }), [])).toBe("Shipped");
    });

    // Shipped is checked first, so a failing post-merge deploy run does not drag
    // a merged ticket back to Blocked. This is the documented precedence; if it
    // ever needs to change, T2-3 (Merged → Deployed) is the place to do it.
    it("outranks Blocked — a merged PR with a failing run is still Shipped", () => {
      expect(deriveColumn("open", pr({ merged: true }), [run("failure")])).toBe("Shipped");
      expect(deriveColumn("closed", null, [run("failure")])).toBe("Shipped");
    });
  });

  it("ignores neutral checks and runs", () => {
    expect(deriveColumn("open", pr({ checks: [check("neutral")] }), [run("neutral")])).toBe(
      "Ready to test"
    );
  });

  // A closed PR that never merged (abandoned) leaves the issue open with no
  // in-flight work — the ticket is back to Queued, not stuck in Ready to test.
  it("is Queued when the PR was closed without merging and nothing is running", () => {
    expect(deriveColumn("open", pr({ state: "closed", merged: false }), [])).toBe("Queued");
  });
});
