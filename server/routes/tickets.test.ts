import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { resetDb, withServer } from "../test/helpers.js";
import { insertRepo } from "../db/repos.js";
import { createTicket } from "../db/tickets.js";
import { upsertStatus, getStatus } from "../db/status.js";
import { getDb } from "../db/migrate.js";
import { setProviderFactory } from "../providers/index.js";
import type { GitProvider, Issue, MergeResult, PRRef, PRStatus, Run } from "../providers/types.js";
import type { StatusPayload } from "../poller/reconcile.js";
import { ticketsRouter } from "./tickets.js";

// T0-5 — POST /api/tickets/:id/merge is the Ship button (PRD F6). It merges to
// production. The route re-validates the gate server-side rather than trusting
// the client's enabled/disabled state, and each rejection branch below is a
// change that must NOT reach main.

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/tickets", ticketsRouter);
  return a;
}

function prStatus(over: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 7,
    title: "Add a thing",
    state: "open",
    merged: false,
    mergeable: true,
    draft: false,
    headBranch: "claude/issue-1",
    headSha: "0".repeat(40),
    baseBranch: "main",
    url: "https://example.test/pr/7",
    checks: [{ name: "ci", state: "success", url: null }],
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    previewUrl: null,
    ...over,
  };
}

function payload(pr: PRStatus | null): StatusPayload {
  return {
    column: pr?.merged ? "Merged" : pr ? "Ready to test" : "Queued",
    issue: { number: 1, title: "Do it", state: "open", url: "https://example.test/i/1", body: "" },
    progressComment: null,
    pr,
    revertPr: null,
    runs: [],
  };
}

/** Seed a repo + ticket, and cache `pr` as the ticket's current status. */
function seed(pr: PRStatus | null, mergeMethod = "squash"): number {
  const repo = insertRepo({ provider: "github", path: "acme/widgets", merge_method: mergeMethod });
  const ticket = createTicket(repo.id, 1, null, new Date().toISOString());
  upsertStatus(ticket.id, payload(pr), new Date().toISOString());
  return ticket.id;
}

const mergePR = vi.fn<(...a: unknown[]) => Promise<MergeResult>>();
const getRevertUrl = vi.fn<(...a: unknown[]) => Promise<string>>();

/** A fake provider: mergePR is the assertion target; the rest feeds safeReconcile. */
function fakeProvider(mergedAfter = true): GitProvider {
  return {
    mergePR,
    getRevertUrl,
    findRevertPR: async (): Promise<null> => null,
    getIssue: async (): Promise<Issue> => ({
      number: 1,
      title: "Do it",
      body: "",
      state: mergedAfter ? "closed" : "open",
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
    getPRStatus: async (): Promise<PRStatus> => prStatus({ merged: mergedAfter }),
    getWorkflowRuns: async (): Promise<Run[]> => [],
    getRateLimit: async () => ({ limit: null, remaining: null, reset: null }),
    discoverRepos: async () => [],
    getRepoContext: async () => {
      throw new Error("unused");
    },
    createIssue: async () => {
      throw new Error("unused");
    },
    postComment: async () => undefined,
    listOpenIssues: async () => [],
  } as unknown as GitProvider;
}

function activityTypes(): string[] {
  return (getDb().prepare("SELECT type FROM activity").all() as { type: string }[]).map((r) => r.type);
}

async function merge(ticketId: number, body?: unknown) {
  return withServer(app(), async (base) => {
    const res = await fetch(`${base}/api/tickets/${ticketId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  });
}

async function revertUrl(ticketId: number) {
  return withServer(app(), async (base) => {
    const res = await fetch(`${base}/api/tickets/${ticketId}/revert-url`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  });
}

describe("POST /api/tickets/:id/merge — the ship gate", () => {
  beforeEach(() => {
    resetDb();
    mergePR.mockReset();
    mergePR.mockResolvedValue({ merged: true, message: null, sha: "abc123" });
    setProviderFactory(() => fakeProvider());
  });

  afterEach(() => setProviderFactory(null));

  describe("refuses to merge", () => {
    it("404s for an unknown ticket", async () => {
      const { status } = await merge(9999);
      expect(status).toBe(404);
      expect(mergePR).not.toHaveBeenCalled();
    });

    it("409s when the ticket has no linked PR", async () => {
      const { status, body } = await merge(seed(null));
      expect(status).toBe(409);
      expect(body.error).toMatch(/no open pr/i);
      expect(mergePR).not.toHaveBeenCalled();
    });

    it("409s when the PR is closed", async () => {
      const { status } = await merge(seed(prStatus({ state: "closed" })));
      expect(status).toBe(409);
      expect(mergePR).not.toHaveBeenCalled();
    });

    it("409s when the PR is not mergeable (conflicts / branch protection)", async () => {
      const { status, body } = await merge(seed(prStatus({ mergeable: false })));
      expect(status).toBe(409);
      expect(body.error).toMatch(/not mergeable/i);
      expect(mergePR).not.toHaveBeenCalled();
    });

    it("409s when any check failed", async () => {
      const pr = prStatus({ checks: [{ name: "ci", state: "failure", url: null }] });
      const { status, body } = await merge(seed(pr));
      expect(status).toBe(409);
      expect(body.error).toMatch(/not all checks are green/i);
      expect(mergePR).not.toHaveBeenCalled();
    });

    it("409s when any check is still pending", async () => {
      const pr = prStatus({
        checks: [
          { name: "ci", state: "success", url: null },
          { name: "e2e", state: "pending", url: null },
        ],
      });
      const { status } = await merge(seed(pr));
      expect(status).toBe(409);
      expect(mergePR).not.toHaveBeenCalled();
    });

    // mergeable === null means GitHub hasn't computed mergeability yet. The
    // route only blocks on an explicit `false`, so this proceeds by design.
    it("allows mergeable === null (not yet computed)", async () => {
      const { status } = await merge(seed(prStatus({ mergeable: null })));
      expect(status).toBe(200);
      expect(mergePR).toHaveBeenCalledTimes(1);
    });
  });

  describe("merges", () => {
    it("merges once with the repo's default method and reports the sha", async () => {
      const { status, body } = await merge(seed(prStatus()));
      expect(status).toBe(200);
      expect(body).toEqual({ merged: true, sha: "abc123" });
      expect(mergePR).toHaveBeenCalledTimes(1);
      expect(mergePR.mock.calls[0][2]).toBe("squash");
    });

    it("honors a valid method override from the request body", async () => {
      await merge(seed(prStatus()), { method: "rebase" });
      expect(mergePR.mock.calls[0][2]).toBe("rebase");
    });

    it("ignores an invalid method override and uses the repo default", async () => {
      await merge(seed(prStatus(), "merge"), { method: "force-push-to-main" });
      expect(mergePR.mock.calls[0][2]).toBe("merge");
    });

    it("records a merged activity event", async () => {
      await merge(seed(prStatus()));
      expect(activityTypes()).toContain("merged");
    });

    // F6.3: the card must leave the in-flight columns without waiting for the
    // next 20s poll. With no deploy run in this fixture, that terminal state is
    // Merged (T2-3); Deployed follows once a default-branch deploy succeeds.
    it("reconciles immediately so the column flips to Merged", async () => {
      const ticketId = seed(prStatus());
      await merge(ticketId);
      const row = getStatus(ticketId)!;
      expect((JSON.parse(row.payload_json) as StatusPayload).column).toBe("Merged");
    });
  });

  describe("surfaces provider failures", () => {
    it("409s with the PR url when the provider reports merged:false", async () => {
      mergePR.mockResolvedValue({ merged: false, message: "Base branch was modified", sha: null });
      const { status, body } = await merge(seed(prStatus()));
      expect(status).toBe(409);
      expect(body.error).toBe("Base branch was modified");
      expect(body.pr_url).toBe("https://example.test/pr/7");
    });

    it("502s with the PR url when the provider throws", async () => {
      mergePR.mockRejectedValue(new Error("upstream exploded"));
      const { status, body } = await merge(seed(prStatus()));
      expect(status).toBe(502);
      expect(body.pr_url).toBe("https://example.test/pr/7");
    });
  });
});

// T1-8 / ADR-0004 — Dispatch does not perform the revert. It hands the user a
// deep-link to the provider's own revert affordance. The route exists to derive
// that url server-side (the token never reaches the browser) and to re-validate
// the shipped gate, exactly as the ship route re-validates its own.
describe("GET /api/tickets/:id/revert-url — the deep-link", () => {
  beforeEach(() => {
    resetDb();
    getRevertUrl.mockReset();
    getRevertUrl.mockResolvedValue("https://example.test/pr/7/revert");
    setProviderFactory(() => fakeProvider());
  });

  afterEach(() => setProviderFactory(null));

  it("returns the provider-derived revert url for a merged PR", async () => {
    const { status, body } = await revertUrl(seed(prStatus({ merged: true, state: "merged" })));
    expect(status).toBe(200);
    expect(body.url).toBe("https://example.test/pr/7/revert");
    expect(getRevertUrl).toHaveBeenCalledWith(expect.objectContaining({ path: "acme/widgets" }), 7);
  });

  // The guard is load-bearing: ADR-0003 [6] could not establish what the
  // provider does when asked to revert something that never merged, and we
  // never want to find out by asking it.
  it("409s when the PR has not merged, without calling the provider", async () => {
    const { status, body } = await revertUrl(seed(prStatus({ merged: false, state: "open" })));
    expect(status).toBe(409);
    expect(body.error).toMatch(/merged/i);
    expect(getRevertUrl).not.toHaveBeenCalled();
  });

  it("409s when the ticket has no PR at all", async () => {
    const { status } = await revertUrl(seed(null));
    expect(status).toBe(409);
    expect(getRevertUrl).not.toHaveBeenCalled();
  });

  it("404s for an unknown ticket", async () => {
    const { status } = await revertUrl(9999);
    expect(status).toBe(404);
  });

  it("surfaces a provider failure with the PR url, redacted", async () => {
    getRevertUrl.mockRejectedValue(new Error("upstream exploded"));
    const { status, body } = await revertUrl(seed(prStatus({ merged: true, state: "merged" })));
    expect(status).toBe(502);
    expect(body.pr_url).toBe("https://example.test/pr/7");
  });
});
