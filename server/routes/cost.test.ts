import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { resetDb, withServer } from "../test/helpers.js";
import { insertRepo } from "../db/repos.js";
import { createTicket } from "../db/tickets.js";
import { upsertStatus } from "../db/status.js";
import { recordSpend } from "../db/spend.js";
import { setProviderFactory } from "../providers/index.js";
import type { GitProvider, PRStatus, Run, RunTiming } from "../providers/types.js";
import type { StatusPayload } from "../poller/reconcile.js";
import { ACTIONS_USD_PER_MINUTE_STANDARD } from "../providers/run-cost.js";
import type { CostResponse } from "./cost.js";

// T2-4 (ticket #14) — GET /api/tickets/:id/cost answers "what did this ticket
// cost to build?": Claude tokens from the spend ledger + GitHub Actions minutes
// from the runs linked to its PR. Two invariants the route must hold:
//
//   - A run whose timing we cannot fetch is `unknown`, never $0 (AC).
//   - GitLab degrades to tokens-only (actions: null), never erroring.

const { costRouter } = await import("./cost.js");

const SONNET = "claude-sonnet-4-6";
const M = 1_000_000;

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/tickets", costRouter);
  return a;
}

function run(id: string): Run {
  return { id, name: "CI", event: "push", title: null, state: "success", url: null, createdAt: "" };
}

function prStatus(): PRStatus {
  return {
    number: 7, title: "t", state: "open", merged: false, mergeable: true, draft: false,
    headBranch: "claude/issue-1", headSha: "a".repeat(40), baseBranch: "main",
    url: "https://example.test/pr/7", checks: [], additions: 1, deletions: 0,
    changedFiles: 1, previewUrl: null,
  };
}

function seed(provider: "github" | "gitlab", runs: Run[]): number {
  const repo = insertRepo({ provider, path: provider === "github" ? "acme/widgets" : "g/p" });
  const ticket = createTicket(repo.id, 1, null, new Date().toISOString());
  const payload: StatusPayload = {
    column: "Ready to test",
    issue: { number: 1, title: "Do it", state: "open", url: "https://example.test/i/1", body: "" },
    progressComment: null,
    pr: prStatus(),
    revertPr: null,
    runs,
  };
  upsertStatus(ticket.id, payload, new Date().toISOString());
  return ticket.id;
}

const getRunTiming = vi.fn<(...a: unknown[]) => Promise<RunTiming | null>>();

function fakeProvider(): GitProvider {
  return { getRunTiming } as unknown as GitProvider;
}

const get = (base: string, id: number) => fetch(`${base}/api/tickets/${id}/cost`);

beforeEach(() => {
  resetDb();
  getRunTiming.mockReset();
  setProviderFactory(() => fakeProvider());
});

afterEach(() => setProviderFactory(null));

describe("GET /api/tickets/:id/cost", () => {
  it("sums attributed token spend for the ticket", async () => {
    const id = seed("github", []);
    recordSpend({
      model: SONNET, kind: "summary", ticketId: id,
      usage: { input_tokens: M, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      at: new Date(),
    });
    getRunTiming.mockResolvedValue(null);

    await withServer(app(), async (base) => {
      const body = (await (await get(base, id)).json()) as CostResponse;
      expect(body.tokens.usd).toBeCloseTo(3, 6);
      expect(body.tokens.inputTokens).toBe(M);
    });
  });

  it("prices Actions minutes from run timing at the standard-runner rate", async () => {
    const id = seed("github", [run("100"), run("101")]);
    getRunTiming.mockImplementation(async (_ref, runId) =>
      ({ runId: String(runId), billableMs: 60_000 }) // 1 min each
    );

    await withServer(app(), async (base) => {
      const body = (await (await get(base, id)).json()) as CostResponse;
      expect(body.actions?.minutes).toBeCloseTo(2, 6);
      expect(body.actions?.usd).toBeCloseTo(2 * ACTIONS_USD_PER_MINUTE_STANDARD, 9);
      expect(body.actions?.unknownRuns).toBe(0);
    });
  });

  it("reports a run with no timing as unknown, never as zero", async () => {
    const id = seed("github", [run("100"), run("101")]);
    getRunTiming.mockImplementation(async (_ref, runId) =>
      runId === "100" ? { runId: "100", billableMs: 120_000 } : null
    );

    await withServer(app(), async (base) => {
      const body = (await (await get(base, id)).json()) as CostResponse;
      expect(body.actions?.minutes).toBeCloseTo(2, 6);
      expect(body.actions?.unknownRuns).toBe(1);
    });
  });

  it("degrades GitLab to tokens-only (actions: null) without calling getRunTiming", async () => {
    const id = seed("gitlab", [run("100")]);

    await withServer(app(), async (base) => {
      const body = (await (await get(base, id)).json()) as CostResponse;
      expect(body.actions).toBeNull();
    });
    expect(getRunTiming).not.toHaveBeenCalled();
  });

  it("treats a run whose timing lookup throws as unknown, never 500ing", async () => {
    const id = seed("github", [run("100")]);
    getRunTiming.mockRejectedValue(new Error("boom"));

    await withServer(app(), async (base) => {
      const res = await get(base, id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as CostResponse;
      expect(body.actions?.unknownRuns).toBe(1);
    });
  });

  it("404s an unknown ticket", async () => {
    await withServer(app(), async (base) => {
      expect((await get(base, 9999)).status).toBe(404);
    });
  });
});
