// Setup-time canary verdict logic (#5).
//
// Writing `claude.yml` is not the same as it running. After onboarding, the
// canary files a throwaway `@claude` issue and watches for the workflow_run it
// should trigger. The subtlety this module exists for (ADR-0002): a run
// *existing* is not success. A pull request opened by a token that cannot trigger
// workflows still creates a run, which then parks in `action_required` and never
// executes. So `success` is the only pass, and the failure modes are told apart
// by message rather than collapsed.
//
// It reads the RAW GitHub (status, conclusion) on purpose. The provider's
// `RunState` (`mapRun`) folds `action_required` into `neutral`/`in_progress`,
// erasing the very distinction the canary needs.

export type CanaryOutcome = "pass" | "fail" | "pending";

export interface CanaryVerdict {
  outcome: CanaryOutcome;
  /** Human-actionable on a fail; empty on pass/pending. */
  reason: string;
}

export interface RawRun {
  /** queued | in_progress | completed | action_required | waiting | … */
  status: string | null;
  /** success | failure | action_required | startup_failure | timed_out | cancelled | null */
  conclusion: string | null;
}

const APPROVAL_PARKED =
  "The workflow was created but is parked awaiting approval (action_required). " +
  "The token that opened this event cannot trigger workflow runs without a human " +
  'clicking "Approve and run". Enable "Allow GitHub Actions to create and approve ' +
  'pull requests", or let Dispatch open the PR with its App installation token.';

/** Terminal conclusions that are not success — all failures for the canary. */
const FAILED_CONCLUSIONS = new Set([
  "failure",
  "startup_failure",
  "timed_out",
  "cancelled",
]);

export function classifyCanaryRun(run: RawRun): CanaryVerdict {
  const { status, conclusion } = run;

  // Awaiting approval is terminal-for-our-purposes and must be caught before the
  // "not completed → pending" branch, or a parked run polls until timeout. It can
  // surface as either a status or a conclusion depending on the GitHub surface.
  if (status === "action_required" || conclusion === "action_required") {
    return { outcome: "fail", reason: APPROVAL_PARKED };
  }

  // Still running (or queued). The poll loop keeps waiting; a run that never
  // completes within the window is failed by the loop, not here.
  if (status !== "completed") {
    return { outcome: "pending", reason: "" };
  }

  if (conclusion === "success") {
    return { outcome: "pass", reason: "" };
  }

  if (conclusion && FAILED_CONCLUSIONS.has(conclusion)) {
    return {
      outcome: "fail",
      reason:
        `The workflow ran and finished with "${conclusion}" rather than success. ` +
        "The build triggered but did not pass — check the run's logs (a run that " +
        "dies within seconds is usually an auth failure, e.g. the Claude token).",
    };
  }

  // Completed with an unexpected/neutral/null conclusion. Not a pass; surface it
  // rather than silently treating it as success.
  return {
    outcome: "fail",
    reason:
      `The workflow completed with an unexpected conclusion (${conclusion ?? "none"}). ` +
      "It did not report success — inspect the run before trusting the setup.",
  };
}
