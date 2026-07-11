import { describe, expect, it } from "vitest";
import { runCanary } from "./canary-run.js";
import { CANARY_LABEL } from "./reconcile.js";
import type { GitProvider, RepoRef, RawWorkflowRun, SpecInput, BranchRef } from "../providers/types.js";

// #5 — the live orchestrator: file a labelled @claude issue, poll for its
// workflow_run, and clean up (close the issue, delete any branch) on BOTH the
// pass and fail paths. Run against a fake provider — no repo is touched here.

const REPO: RepoRef = { provider: "github", path: "o/r", defaultBranch: "main" };
const START = 1_700_000_000_000; // fixed epoch so run timestamps are deterministic
const FAST = { windowMs: 30_000, intervalMs: 5_000 };

function fakeClock(startMs = START) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function run(fields: Partial<RawWorkflowRun>): RawWorkflowRun {
  return {
    id: "1",
    status: "completed",
    conclusion: "success",
    headBranch: "main",
    event: "issues",
    createdAt: new Date(START).toISOString(),
    ...fields,
  };
}

interface FakeOpts {
  runs?: RawWorkflowRun[];
  branches?: BranchRef[];
}

function fakeProvider(opts: FakeOpts = {}) {
  const calls = {
    createIssue: [] as SpecInput[],
    closeIssue: [] as number[],
    deleteBranch: [] as string[],
  };
  const provider = {
    async createIssue(_repo: RepoRef, spec: SpecInput) {
      calls.createIssue.push(spec);
      return { number: 5, url: "https://github.com/o/r/issues/5" };
    },
    async getWorkflowRunsRaw() {
      return opts.runs ?? [];
    },
    async listBranches() {
      return opts.branches ?? [{ name: "main", sha: "m" }];
    },
    async closeIssue(_repo: RepoRef, n: number) {
      calls.closeIssue.push(n);
    },
    async deleteBranch(_repo: RepoRef, b: string) {
      calls.deleteBranch.push(b);
    },
  } as unknown as GitProvider;
  return { provider, calls };
}

const CLAUDE_BRANCH: BranchRef = { name: "claude/issue-5-20260711", sha: "c0ffee" };

describe("runCanary", () => {
  it("files a throwaway issue carrying the dispatch-canary label and a no-op request", async () => {
    const { provider, calls } = fakeProvider({ runs: [run({})] });
    await runCanary({ provider, repo: REPO, clock: fakeClock(), poll: FAST });

    expect(calls.createIssue).toHaveLength(1);
    expect(calls.createIssue[0].labels).toContain(CANARY_LABEL);
    expect(calls.createIssue[0].body_markdown.toLowerCase()).toContain("no-op");
  });

  it("on a passing run, closes the issue and deletes the branch the run created", async () => {
    const { provider, calls } = fakeProvider({
      runs: [run({ conclusion: "success" })],
      branches: [{ name: "main", sha: "m" }, CLAUDE_BRANCH],
    });
    const result = await runCanary({ provider, repo: REPO, clock: fakeClock(), poll: FAST });

    expect(result.verdict.outcome).toBe("pass");
    expect(calls.closeIssue).toEqual([5]);
    expect(calls.deleteBranch).toEqual([CLAUDE_BRANCH.name]);
  });

  it("on an action_required run, FAILS but still cleans up — no artifacts survive", async () => {
    const { provider, calls } = fakeProvider({
      runs: [run({ status: "completed", conclusion: "action_required" })],
      branches: [{ name: "main", sha: "m" }, CLAUDE_BRANCH],
    });
    const result = await runCanary({ provider, repo: REPO, clock: fakeClock(), poll: FAST });

    expect(result.verdict.outcome).toBe("fail");
    expect(calls.closeIssue).toEqual([5]);
    expect(calls.deleteBranch).toEqual([CLAUDE_BRANCH.name]);
  });

  it("on the #25 early-failure signature, fails with a message that names a likely cause", async () => {
    const { provider, calls } = fakeProvider({
      runs: [run({ status: "completed", conclusion: "failure" })],
      branches: [{ name: "main", sha: "m" }, CLAUDE_BRANCH],
    });
    const result = await runCanary({ provider, repo: REPO, clock: fakeClock(), poll: FAST });

    expect(result.verdict.outcome).toBe("fail");
    expect(result.verdict.reason.length).toBeGreaterThan(0);
    expect(result.verdict.reason.toLowerCase()).toMatch(/auth|token|log/);
    expect(calls.closeIssue).toEqual([5]); // cleanup on the fail path
  });

  it("closes the issue but deletes nothing when the run created no branch", async () => {
    const { provider, calls } = fakeProvider({
      runs: [run({ conclusion: "success" })],
      branches: [{ name: "main", sha: "m" }],
    });
    await runCanary({ provider, repo: REPO, clock: fakeClock(), poll: FAST });

    expect(calls.closeIssue).toEqual([5]);
    expect(calls.deleteBranch).toEqual([]);
  });

  it("ignores a stale run from before this canary and times out as a fail, still cleaning up", async () => {
    const stale = run({ createdAt: new Date(START - 10 * 60_000).toISOString() });
    const { provider, calls } = fakeProvider({ runs: [stale], branches: [{ name: "main", sha: "m" }] });
    const result = await runCanary({ provider, repo: REPO, clock: fakeClock(), poll: FAST });

    expect(result.verdict.outcome).toBe("fail");
    expect(result.verdict.reason.toLowerCase()).toMatch(/no workflow run|never|did not trigger/);
    expect(calls.closeIssue).toEqual([5]);
  });
});
