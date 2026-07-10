import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { deriveColumn, reconcileTicket } from "./reconcile.js";
import { resetDb } from "../test/helpers.js";
import { insertRepo } from "../db/repos.js";
import { createTicket, getTicket } from "../db/tickets.js";
import { getDb } from "../db/migrate.js";
import { setProviderFactory } from "../providers/index.js";
import type {
  Check,
  GitProvider,
  Issue,
  PRRef,
  PRStatus,
  RevertRef,
  Run,
  RunState,
} from "../providers/types.js";

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
    headSha: "0".repeat(40),
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

// ─────────────────────────────────────────────────────────────────────────────
// T1-8 / ADR-0004 — tracking a revert PR Dispatch did not open.
//
// Because the revert happens on the provider's site, reconcile is the only
// place that ever learns the revert PR exists. Two things must hold:
//   1. the revert PR is surfaced (`revertPr`), so the card is not an orphan;
//   2. it does NOT displace the shipping PR, and the column stays Shipped.
// (2) is the regression guard — see ADR-0004 [5].

describe("reconcileTicket — revert PR tracking", () => {
  const merged: PRStatus = pr({ number: 7, merged: true, state: "merged" });
  const theRevert: RevertRef = {
    number: 8,
    url: "https://example.test/pr/8",
    state: "open",
  };

  function provider(over: Partial<GitProvider> = {}): GitProvider {
    return {
      getIssue: async (): Promise<Issue> => ({
        number: 1,
        title: "Do it",
        body: "",
        state: "closed",
        labels: [],
        comments: [],
        url: "https://example.test/i/1",
      }),
      findLinkedPR: async (): Promise<PRRef | null> => ({
        number: 7,
        url: "https://example.test/pr/7",
        headBranch: "claude/issue-1",
        baseBranch: "main",
      }),
      getPRStatus: async (): Promise<PRStatus> => merged,
      findRevertPR: async (): Promise<RevertRef | null> => theRevert,
      getWorkflowRuns: async (): Promise<Run[]> => [],
      ...over,
    } as unknown as GitProvider;
  }

  function seedTicket(): number {
    const repo = insertRepo({ provider: "github", path: "acme/widgets", merge_method: "squash" });
    return createTicket(repo.id, 1, null, new Date().toISOString()).id;
  }

  beforeEach(() => resetDb());
  afterEach(() => setProviderFactory(null));

  it("surfaces the revert PR and keeps the shipping PR in place", async () => {
    setProviderFactory(() => provider());
    const id = seedTicket();

    const payload = await reconcileTicket(getTicket(id)!);

    expect(payload?.pr?.number).toBe(7); // the shipping PR, not the revert
    expect(payload?.revertPr).toEqual(theRevert);
    expect(payload?.column).toBe("Shipped");
  });

  it("does not look for a revert PR when nothing has merged", async () => {
    const findRevertPR = vi.fn<(...a: unknown[]) => Promise<RevertRef | null>>();
    setProviderFactory(() =>
      provider({
        getPRStatus: async () => pr({ number: 7, merged: false, state: "open" }),
        getIssue: async () => ({
          number: 1,
          title: "Do it",
          body: "",
          state: "open",
          labels: [],
          comments: [],
          url: "https://example.test/i/1",
        }),
        findRevertPR,
      })
    );
    const payload = await reconcileTicket(getTicket(seedTicket())!);

    expect(payload?.revertPr).toBeNull();
    expect(findRevertPR).not.toHaveBeenCalled();
  });

  it("writes one activity row the first time the revert PR is seen, and not again", async () => {
    setProviderFactory(() => provider());
    const id = seedTicket();
    const ticket = getTicket(id)!;

    await reconcileTicket(ticket);
    await reconcileTicket(ticket);

    const reverts = (
      getDb().prepare("SELECT type FROM activity").all() as { type: string }[]
    ).filter((r) => r.type === "revert_opened");
    expect(reverts).toHaveLength(1);
  });
});

// #4 stage 3 — the wiring, not just the helper. reconcileTicket must open the PR
// for Claude's branch when nothing links to the issue yet, and the card must then
// carry that PR. Tested here because openPRForClaudeBranch being correct in
// isolation says nothing about whether reconcileTicket calls it.
describe("reconcileTicket — opens the PR for Claude's branch (#4)", () => {
  const CLAUDE_TIP = { authorName: "claude[bot]", authorLogin: "github-actions[bot]", authorType: "Bot" as const };
  const HUMAN_TIP = { authorName: "Jay Wolberg", authorLogin: "jwolberg", authorType: "User" as const };

  const openIssue: Issue = {
    number: 1,
    title: "Do it",
    body: "",
    state: "open",
    labels: ["dispatch"],
    comments: [],
    url: "https://example.test/i/1",
  };

  function seed(): number {
    const repo = insertRepo({
      provider: "github",
      path: "acme/widgets",
      merge_method: "squash",
      default_branch: "main", // load-bearing: no base branch, no PR
    });
    return createTicket(repo.id, 1, null, new Date().toISOString()).id;
  }

  function providerFor(tip: typeof CLAUDE_TIP | typeof HUMAN_TIP, branch: string) {
    const createPullRequest = vi.fn(async () => ({
      number: 31,
      url: "https://example.test/pr/31",
      headBranch: branch,
      baseBranch: "main",
    }));
    const p = {
      getIssue: async () => openIssue,
      findLinkedPR: async () => null, // nothing links yet
      listBranches: async () => [{ name: "main", sha: "m1" }, { name: branch, sha: "b1" }],
      getCommitIdentity: async () => tip,
      createPullRequest,
      getPRStatus: async (): Promise<PRStatus> => pr({ number: 31, state: "open" }),
      findRevertPR: async () => null,
      getWorkflowRuns: async (): Promise<Run[]> => [],
    } as unknown as GitProvider;
    return { p, createPullRequest };
  }

  beforeEach(() => resetDb());
  afterEach(() => setProviderFactory(null));

  it("opens it, and the card then carries the PR", async () => {
    const { p, createPullRequest } = providerFor(CLAUDE_TIP, "claude/issue-1-20260710");
    setProviderFactory(() => p);

    const payload = await reconcileTicket(getTicket(seed())!);

    expect(createPullRequest).toHaveBeenCalledOnce();
    expect(payload?.pr?.number).toBe(31);
  });

  it("leaves a human's branch alone, and the card stays PR-less", async () => {
    const { p, createPullRequest } = providerFor(HUMAN_TIP, "fix-1");
    setProviderFactory(() => p);

    const payload = await reconcileTicket(getTicket(seed())!);

    expect(createPullRequest).not.toHaveBeenCalled();
    expect(payload?.pr).toBeNull();
  });

  it("a failure to open the PR does not fail the reconcile", async () => {
    const { p } = providerFor(CLAUDE_TIP, "claude/issue-1");
    (p as unknown as { listBranches: () => Promise<never> }).listBranches = async () => {
      throw new Error("boom");
    };
    setProviderFactory(() => p);

    const payload = await reconcileTicket(getTicket(seed())!);
    expect(payload?.pr).toBeNull(); // reconciled anyway; the next poll retries
    expect(payload?.column).toBeDefined();
  });
});
