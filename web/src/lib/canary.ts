// #5 — the repo card's setup-canary chip.
//
// "Writing claude.yml is not the same as it running." After onboarding, Dispatch
// files a throwaway @claude issue and watches for the workflow_run it should
// trigger; the verdict lands here. The chip is only meaningful once a workflow
// exists — a repo with none shows the onboarding warning instead — and a fail
// must carry the actionable reason, not just a red dot.

import type { Tone } from "./verdict.js";

export interface CanaryChip {
  tone: Tone;
  label: string;
  /** Color is never the only signal (PRD §4). */
  icon: string;
  /** Hover text — the actionable message on a fail. */
  title: string;
}

export function canaryChip(
  verdict: string | null,
  reason: string | null,
  _checkedAt: string | null,
  automationDetected: number | null
): CanaryChip | null {
  // No workflow → the onboarding warning is the right surface, not this chip.
  if (automationDetected !== 1) return null;

  if (verdict === "pass") {
    return {
      tone: "pass",
      label: "Build verified",
      icon: "✓",
      title: reason || "The setup canary triggered a workflow that completed successfully.",
    };
  }
  if (verdict === "fail") {
    return {
      tone: "fail",
      label: "Build did not trigger",
      icon: "✕",
      title: reason || "The setup canary did not confirm a successful run.",
    };
  }
  // Automation exists but no verdict yet: either the canary is still in flight,
  // or this repo was onboarded before the canary existed. Both say "unverified".
  return {
    tone: "pending",
    label: "Build unverified",
    icon: "◷",
    title: "Run setup to confirm the workflow actually triggers.",
  };
}
