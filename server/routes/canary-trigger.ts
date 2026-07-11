// #5 — the fire-and-forget bridge from POST /setup to the canary orchestrator.
// The poll window is minutes, far longer than the setup request, so this runs in
// the background and the verdict lands on the repo card when it resolves. It
// never throws: an error is itself a fail verdict, so the card always ends with
// an answer rather than a blank.

import { runCanary } from "../poller/canary-run.js";
import type { Clock } from "../poller/canary.js";
import { updateCanaryVerdict } from "../db/repos.js";
import type { RepoRow, CanaryVerdictRecord } from "../db/repos.js";
import { safeMessage } from "../lib/redaction.js";
import type { GitProvider, ProviderId, RepoRef } from "../providers/types.js";

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface CanaryTriggerDeps {
  provider: GitProvider;
  clock?: Clock;
  persist?: (id: number, rec: CanaryVerdictRecord) => void;
}

export async function runCanaryForRepo(repo: RepoRow, deps: CanaryTriggerDeps): Promise<void> {
  const clock = deps.clock ?? realClock;
  const persist = deps.persist ?? updateCanaryVerdict;
  const ref: RepoRef = {
    provider: repo.provider as ProviderId,
    host: repo.host,
    path: repo.path,
    defaultBranch: repo.default_branch,
  };

  try {
    const result = await runCanary({ provider: deps.provider, repo: ref, clock });
    persist(repo.id, {
      verdict: result.verdict.outcome === "pass" ? "pass" : "fail",
      reason: result.verdict.reason,
      checkedAt: result.checkedAt,
    });
  } catch (err) {
    persist(repo.id, {
      verdict: "fail",
      reason: safeMessage(err),
      checkedAt: new Date().toISOString(),
    });
  }
}
