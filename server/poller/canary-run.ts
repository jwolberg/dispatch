// #5 — the live canary orchestrator. `canary.ts` is the pure kernel (classify a
// run, poll a window); this module performs the side effects: file a throwaway
// `@claude` issue, watch for the workflow_run it should trigger, and clean up on
// BOTH the pass and fail paths so nothing is left behind in a user's repo.
//
// It writes to a user's repo and spends a real Claude run, so it is invoked
// deliberately (from setup), never as a poll side effect.

import { linksToIssue } from "../providers/linkage.js";
import { CANARY_LABEL } from "./reconcile.js";
import { pollCanary } from "./canary.js";
import type { CanaryPollConfig, CanaryVerdict, Clock, RawRun } from "./canary.js";
import type { GitProvider, RepoRef } from "../providers/types.js";

/**
 * A cold Actions runner can take a minute-plus to pick up a job, so the window
 * is generous; but it is bounded, and expiry is a fail, never a hang. Well under
 * the workflow's own `timeout-minutes: 30`, since the canary asks for a no-op.
 */
export const DEFAULT_CANARY_POLL: CanaryPollConfig = { windowMs: 5 * 60_000, intervalMs: 10_000 };

/**
 * Runs are matched to this canary by "created at or after we started", with a
 * grace margin absorbing clock skew between this host and GitHub. The run for an
 * `issues` event has no field linking it to the issue number, so a timestamp is
 * the only anchor available.
 */
const RUN_MATCH_GRACE_MS = 30_000;

const CANARY_TITLE = "Dispatch setup canary — safe to ignore";
const CANARY_BODY =
  "This is an automated Dispatch setup check confirming your Claude automation " +
  "actually triggers. Please make the **smallest possible no-op change** (for example " +
  "add a single blank line to a file) and commit it on a branch — do **not** open a " +
  "pull request. Dispatch closes this issue and deletes the branch automatically once " +
  "the check completes.";

export interface CanaryRunResult {
  verdict: CanaryVerdict;
  issueNumber: number;
  issueUrl: string;
  /** ISO timestamp of when the verdict was reached — persisted on the repo card. */
  checkedAt: string;
}

export interface RunCanaryDeps {
  provider: GitProvider;
  /** Must carry `defaultBranch` — the ref an `issues`-triggered run reports. */
  repo: RepoRef;
  clock: Clock;
  poll?: CanaryPollConfig;
}

export async function runCanary({
  provider,
  repo,
  clock,
  poll = DEFAULT_CANARY_POLL,
}: RunCanaryDeps): Promise<CanaryRunResult> {
  const base = repo.defaultBranch ?? null;
  const sinceMs = clock.now() - RUN_MATCH_GRACE_MS;

  // The @claude mention itself is added by the adapter's shared issue body; here
  // we only supply the canary spec and its label.
  const issue = await provider.createIssue(repo, {
    title: CANARY_TITLE,
    body_markdown: CANARY_BODY,
    labels: [CANARY_LABEL],
  });

  const fetchRun = async (): Promise<RawRun | null> => {
    if (!base) return null;
    let runs;
    try {
      runs = await provider.getWorkflowRunsRaw(repo, base);
    } catch {
      // A transient fetch blip should delay the canary, not abort it. A run that
      // never appears still ends as a bounded timeout fail.
      return null;
    }
    const newest = runs
      .filter((r) => Date.parse(r.createdAt) >= sinceMs)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    return newest ? { status: newest.status, conclusion: newest.conclusion } : null;
  };

  let verdict: CanaryVerdict;
  try {
    verdict = await pollCanary(fetchRun, poll, clock);
  } catch (err) {
    // Clean up even if polling itself threw, then surface the error.
    await cleanup(provider, repo, issue.number, base);
    throw err;
  }
  await cleanup(provider, repo, issue.number, base);

  return {
    verdict,
    issueNumber: issue.number,
    issueUrl: issue.url,
    checkedAt: new Date(clock.now()).toISOString(),
  };
}

/**
 * Close the throwaway issue and delete any branch the run created. Branch
 * deletion is idempotent (a missing branch is a no-op), and we only match
 * branches that link to *this* just-created issue number, so nothing a human
 * owns is ever touched. Unlike opening a PR, deletion is not the irreversible
 * action #4 AC 9 guards, so a Claude-authorship check is not required here.
 */
async function cleanup(
  provider: GitProvider,
  repo: RepoRef,
  issueNumber: number,
  base: string | null
): Promise<void> {
  await provider.closeIssue(repo, issueNumber);
  const branches = await provider.listBranches(repo);
  const canaryBranches = branches.filter(
    (b) => b.name !== base && linksToIssue(issueNumber, { branch: b.name, body: null })
  );
  for (const branch of canaryBranches) {
    await provider.deleteBranch(repo, branch.name);
  }
}
