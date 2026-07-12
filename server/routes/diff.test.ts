import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { resetDb, withServer } from "../test/helpers.js";
import { insertRepo } from "../db/repos.js";
import { createTicket } from "../db/tickets.js";
import { upsertStatus } from "../db/status.js";
import { setProviderFactory } from "../providers/index.js";
import type { GitProvider, PRDiff, PRStatus } from "../providers/types.js";
import type { StatusPayload } from "../poller/reconcile.js";
import { DIFF_VIEW_PATCH_BUDGET_BYTES } from "./diff.js";
import type { DiffResponse } from "./diff.js";

// T2-1 (ticket #11) — GET /api/tickets/:id/diff serves the PR's unified diff to
// the card so a reviewer never has to bounce to the provider. Two invariants:
//
//   - No PR, or no head SHA, is "not yet", not "broken" — a clean unavailable
//     state, never a 500 and never a partial card.
//   - The payload is BOUNDED. A pathologically large patch is clipped and the
//     truncation is REPORTED, never silently dropped (AC #3). The route reuses
//     boundDiff, so this holds identically to the summarizer's bound.

const { diffRouter } = await import("./diff.js");

const SHA_A = "a".repeat(40);

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/tickets", diffRouter);
  return a;
}

function prStatus(over: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 7,
    title: "Add Google login",
    state: "open",
    merged: false,
    mergeable: true,
    draft: false,
    headBranch: "claude/issue-1",
    headSha: SHA_A,
    baseBranch: "main",
    url: "https://example.test/pr/7",
    checks: [],
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    previewUrl: null,
    ...over,
  };
}

function seed(pr: PRStatus | null): number {
  const repo = insertRepo({ provider: "github", path: "acme/widgets" });
  const ticket = createTicket(repo.id, 1, null, new Date().toISOString());
  const payload: StatusPayload = {
    column: pr ? "Ready to test" : "Queued",
    issue: { number: 1, title: "Do it", state: "open", url: "https://example.test/i/1", body: "" },
    progressComment: null,
    pr,
    revertPr: null,
    runs: [],
  };
  upsertStatus(ticket.id, payload, new Date().toISOString());
  return ticket.id;
}

const getPRDiff = vi.fn<(...a: unknown[]) => Promise<PRDiff>>();

const SMALL_DIFF: PRDiff = {
  files: [
    { path: "src/auth.ts", status: "modified", additions: 10, deletions: 2, patch: "@@ -1 +1 @@\n-a\n+b" },
  ],
  truncated: false,
};

function fakeProvider(): GitProvider {
  return { getPRDiff } as unknown as GitProvider;
}

const get = (base: string, id: number) => fetch(`${base}/api/tickets/${id}/diff`);

beforeEach(() => {
  resetDb();
  getPRDiff.mockReset().mockResolvedValue(SMALL_DIFF);
  setProviderFactory(() => fakeProvider());
});

afterEach(() => setProviderFactory(null));

describe("GET /api/tickets/:id/diff — the happy path renders the whole diff", () => {
  it("returns the bounded diff for an open PR", async () => {
    const id = seed(prStatus());

    await withServer(app(), async (base) => {
      const res = await get(base, id);
      expect(res.status).toBe(200);

      const body = (await res.json()) as DiffResponse;
      expect(body.unavailable).toBeNull();
      expect(body.diff?.files).toHaveLength(1);
      expect(body.diff?.files[0]).toMatchObject({
        path: "src/auth.ts",
        patch: "@@ -1 +1 @@\n-a\n+b",
        patchTruncated: false,
      });
      expect(body.diff?.truncated).toBe(false);
    });
  });

  it("404s an unknown ticket", async () => {
    await withServer(app(), async (base) => {
      const res = await get(base, 9999);
      expect(res.status).toBe(404);
    });
  });
});

describe("GET /api/tickets/:id/diff — nothing to show is 'not yet', not an error", () => {
  it("reports no-pr when the card has no PR", async () => {
    const id = seed(null);

    await withServer(app(), async (base) => {
      const res = await get(base, id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as DiffResponse;
      expect(body.diff).toBeNull();
      expect(body.unavailable).toBe("no-pr");
    });
    expect(getPRDiff).not.toHaveBeenCalled();
  });

  it("degrades to error, never 500s, when the provider throws", async () => {
    getPRDiff.mockRejectedValueOnce(new Error("boom"));
    const id = seed(prStatus());

    await withServer(app(), async (base) => {
      const res = await get(base, id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as DiffResponse;
      expect(body.diff).toBeNull();
      expect(body.unavailable).toBe("error");
    });
  });
});

describe("GET /api/tickets/:id/diff — the payload is bounded (AC #3)", () => {
  it("clips an oversized patch and reports the truncation, never dropping it silently", async () => {
    const huge = "x".repeat(DIFF_VIEW_PATCH_BUDGET_BYTES + 5_000);
    getPRDiff.mockResolvedValue({
      files: [{ path: "generated.ts", status: "modified", additions: 1, deletions: 0, patch: huge }],
      truncated: false,
    });
    const id = seed(prStatus());

    await withServer(app(), async (base) => {
      const body = (await (await get(base, id)).json()) as DiffResponse;
      expect(body.diff?.truncated).toBe(true);
      const file = body.diff?.files[0];
      expect(file?.patchTruncated).toBe(true);
      // Clipped, not whole — but present, so the reviewer sees what fit.
      expect((file?.patch ?? "").length).toBeLessThan(huge.length);
      expect((file?.patch ?? "").length).toBeGreaterThan(0);
    });
  });

  it("carries the provider's own file-list truncation forward", async () => {
    getPRDiff.mockResolvedValue({ files: SMALL_DIFF.files, truncated: true });
    const id = seed(prStatus());

    await withServer(app(), async (base) => {
      const body = (await (await get(base, id)).json()) as DiffResponse;
      expect(body.diff?.truncated).toBe(true);
    });
  });
});
