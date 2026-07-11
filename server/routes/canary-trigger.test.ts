import { describe, expect, it } from "vitest";
import { runCanaryForRepo } from "./canary-trigger.js";
import type { RepoRow } from "../db/repos.js";
import type { CanaryVerdictRecord } from "../db/repos.js";
import type { GitProvider, RepoRef, RawWorkflowRun, SpecInput } from "../providers/types.js";

// #5 — the fire-and-forget bridge POST /setup uses. It must ALWAYS end by
// persisting a verdict (never leave the card blank), even when the run fails or
// the provider throws mid-flight.

const REPO_ROW = {
  id: 42,
  provider: "github",
  host: null,
  path: "acme/widgets",
  default_branch: "main",
} as unknown as RepoRow;

const START = 1_700_000_000_000;
function fakeClock() {
  let t = START;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function successRun(): RawWorkflowRun {
  return {
    id: "1",
    status: "completed",
    conclusion: "success",
    headBranch: "main",
    event: "issues",
    createdAt: new Date(START).toISOString(),
  };
}

function provider(overrides: Partial<GitProvider>): GitProvider {
  return {
    async createIssue(_r: RepoRef, _s: SpecInput) {
      return { number: 9, url: "https://github.com/acme/widgets/issues/9" };
    },
    async getWorkflowRunsRaw() {
      return [successRun()];
    },
    async listBranches() {
      return [{ name: "main", sha: "m" }];
    },
    async closeIssue() {},
    async deleteBranch() {},
    ...overrides,
  } as unknown as GitProvider;
}

describe("runCanaryForRepo", () => {
  it("persists a pass verdict when the run succeeds", async () => {
    const saved: [number, CanaryVerdictRecord][] = [];
    await runCanaryForRepo(REPO_ROW, {
      provider: provider({}),
      clock: fakeClock(),
      persist: (id, rec) => saved.push([id, rec]),
    });

    expect(saved).toHaveLength(1);
    expect(saved[0][0]).toBe(42);
    expect(saved[0][1].verdict).toBe("pass");
    expect(saved[0][1].checkedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("persists a fail verdict (never blanks the card) when the provider throws", async () => {
    const saved: [number, CanaryVerdictRecord][] = [];
    await runCanaryForRepo(REPO_ROW, {
      provider: provider({
        async createIssue(): Promise<never> {
          throw new Error("boom: could not file the canary issue");
        },
      }),
      clock: fakeClock(),
      persist: (id, rec) => saved.push([id, rec]),
    });

    expect(saved).toHaveLength(1);
    expect(saved[0][1].verdict).toBe("fail");
    expect(saved[0][1].reason).toContain("boom");
  });
});
