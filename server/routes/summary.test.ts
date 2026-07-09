import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { resetDb, withServer } from "../test/helpers.js";
import { insertRepo } from "../db/repos.js";
import { createTicket } from "../db/tickets.js";
import { upsertStatus } from "../db/status.js";
import { setProviderFactory } from "../providers/index.js";
import type { GitProvider, PRDiff, PRStatus } from "../providers/types.js";
import type { StatusPayload } from "../poller/reconcile.js";

// T1-5 (ticket #6) — the route is where the money is spent, so it is where the
// cost invariants have to hold:
//
//   - EXACTLY ONE Anthropic call per (ticket, head SHA). The card polls; React
//     double-mounts. Neither may bill twice.
//   - A new head SHA is a new summary. The old prose describes code that is gone.
//   - Every failure degrades to "no summary". A summary is a nicety; the card is
//     not. Nothing here may 500, and nothing may bill after the budget is spent.

const createMessage = vi.hoisted(() => vi.fn());
vi.mock("../anthropic/client.js", () => ({
  createMessage,
  streamMessage: vi.fn(),
  MODEL: "test-model",
}));

const { summaryRouter } = await import("./summary.js");
const { BudgetExceededError } = await import("../anthropic/budget.js");

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const MODEL_JSON = JSON.stringify({
  whatChanged: "Adds a Sign in with Google button.",
  howToTest: "Open the preview and click Sign in.",
  risk: "low",
});

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/tickets", summaryRouter);
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

const DIFF: PRDiff = {
  files: [
    { path: "src/auth.ts", status: "modified", additions: 10, deletions: 2, patch: "@@ -1 +1 @@\n-a\n+b" },
  ],
  truncated: false,
};

function fakeProvider(): GitProvider {
  return { getPRDiff } as unknown as GitProvider;
}

interface Body {
  summary: { whatChanged: string; howToTest: string; risk: string } | null;
  unavailable: string | null;
}

const get = (base: string, id: number) => fetch(`${base}/api/tickets/${id}/summary`);

beforeEach(() => {
  resetDb();
  createMessage.mockReset();
  getPRDiff.mockReset().mockResolvedValue(DIFF);
  setProviderFactory(() => fakeProvider());
  delete process.env.DISPATCH_DAILY_BUDGET_USD;
});

afterEach(() => setProviderFactory(null));

describe("GET /api/tickets/:id/summary — the happy path bills once", () => {
  it("summarizes on first open and returns the parsed result", async () => {
    createMessage.mockResolvedValue(MODEL_JSON);
    const id = seed(prStatus());

    await withServer(app(), async (base) => {
      const res = await get(base, id);
      expect(res.status).toBe(200);

      const body = (await res.json()) as Body;
      expect(body.unavailable).toBeNull();
      expect(body.summary).toEqual({
        whatChanged: "Adds a Sign in with Google button.",
        howToTest: "Open the preview and click Sign in.",
        risk: "low",
      });
    });

    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it("attributes the spend to the ticket, with kind `summary`", async () => {
    createMessage.mockResolvedValue(MODEL_JSON);
    const id = seed(prStatus());

    await withServer(app(), (base) => get(base, id));

    const [, , , kind, ticketId] = createMessage.mock.calls[0];
    expect(kind).toBe("summary");
    expect(ticketId).toBe(id);
  });

  it("serves the second open from cache — the same SHA never re-bills", async () => {
    createMessage.mockResolvedValue(MODEL_JSON);
    const id = seed(prStatus());

    await withServer(app(), async (base) => {
      await get(base, id);
      const second = (await (await get(base, id)).json()) as Body;
      expect(second.summary?.whatChanged).toContain("Sign in with Google");
    });

    expect(createMessage).toHaveBeenCalledTimes(1);
    // The cache hit must also cost no provider request.
    expect(getPRDiff).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent opens into one Anthropic call", async () => {
    // The card polls every 10s and React strict mode double-mounts. Two requests
    // land before either has written the cache; only one may bill.
    //
    // The gate is held open until BOTH requests have certainly reached the
    // handler. Releasing it earlier would let the first request finish and
    // populate the cache, and the second would hit that cache instead of the
    // coalescing map — the test would pass without ever exercising the race.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    createMessage.mockImplementation(async () => {
      await gate;
      return MODEL_JSON;
    });

    const id = seed(prStatus());

    await withServer(app(), async (base) => {
      const both = Promise.all([get(base, id), get(base, id)]);
      await new Promise((r) => setTimeout(r, 50));
      release();

      const bodies = (await Promise.all((await both).map((r) => r.json()))) as Body[];
      // Both callers get the summary; only one of them paid for it.
      expect(bodies.every((b) => b.summary !== null)).toBe(true);
    });

    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(getPRDiff).toHaveBeenCalledTimes(1);
  });
});

describe("a new head SHA is a new summary", () => {
  it("re-summarizes after a force-push rather than describing code that is gone", async () => {
    createMessage.mockResolvedValue(MODEL_JSON);
    const id = seed(prStatus({ headSha: SHA_A }));

    await withServer(app(), async (base) => {
      await get(base, id);

      // The PR was force-pushed; the poller wrote a new head SHA.
      upsertStatus(
        id,
        {
          column: "Ready to test",
          issue: { number: 1, title: "Do it", state: "open", url: "u", body: "" },
          progressComment: null,
          pr: prStatus({ headSha: SHA_B }),
          revertPr: null,
          runs: [],
        } satisfies StatusPayload,
        new Date().toISOString(),
      );

      const after = (await (await get(base, id)).json()) as Body;
      expect(after.summary).not.toBeNull();
    });

    expect(createMessage).toHaveBeenCalledTimes(2);
  });
});

describe("every failure degrades to no summary, never to a broken card", () => {
  it("returns no-pr, and bills nothing, when no PR is linked yet", async () => {
    const id = seed(null);

    await withServer(app(), async (base) => {
      const body = (await (await get(base, id)).json()) as Body;
      expect(body).toEqual({ summary: null, unavailable: "no-pr" });
    });

    expect(createMessage).not.toHaveBeenCalled();
    expect(getPRDiff).not.toHaveBeenCalled();
  });

  it("returns no-pr when the provider gave us no head SHA to key the cache by", async () => {
    const id = seed(prStatus({ headSha: "" }));

    await withServer(app(), async (base) => {
      const body = (await (await get(base, id)).json()) as Body;
      expect(body.unavailable).toBe("no-pr");
    });

    expect(createMessage).not.toHaveBeenCalled();
  });

  it("returns 200 with unavailable=error when Anthropic fails", async () => {
    createMessage.mockRejectedValue(new Error("anthropic overloaded"));
    const id = seed(prStatus());

    await withServer(app(), async (base) => {
      const res = await get(base, id);
      expect(res.status).toBe(200); // never a 500 — the card still renders

      const body = (await res.json()) as Body;
      expect(body).toEqual({ summary: null, unavailable: "error" });
    });
  });

  it("returns 200 with unavailable=error when the model's reply cannot be parsed", async () => {
    createMessage.mockResolvedValue("I'd be happy to summarize that for you!");
    const id = seed(prStatus());

    await withServer(app(), async (base) => {
      const body = (await (await get(base, id)).json()) as Body;
      expect(body).toEqual({ summary: null, unavailable: "error" });
    });
  });

  it("returns 200 with unavailable=error when the diff cannot be fetched", async () => {
    getPRDiff.mockRejectedValue(new Error("403 from provider"));
    const id = seed(prStatus());

    await withServer(app(), async (base) => {
      const body = (await (await get(base, id)).json()) as Body;
      expect(body.unavailable).toBe("error");
    });

    expect(createMessage).not.toHaveBeenCalled();
  });

  it("does not cache a failure — a transient error must not suppress the summary forever", async () => {
    createMessage.mockRejectedValueOnce(new Error("overloaded")).mockResolvedValue(MODEL_JSON);
    const id = seed(prStatus());

    await withServer(app(), async (base) => {
      expect(((await (await get(base, id)).json()) as Body).unavailable).toBe("error");
      expect(((await (await get(base, id)).json()) as Body).summary).not.toBeNull();
    });
  });
});

describe("the daily budget cap (#10) gates the summary before it costs anything", () => {
  it("returns unavailable=budget without calling Anthropic or the provider", async () => {
    // $0 cap: spentToday (0) >= budget (0), so the gate trips on the first call.
    process.env.DISPATCH_DAILY_BUDGET_USD = "0";
    const id = seed(prStatus());

    await withServer(app(), async (base) => {
      const res = await get(base, id);
      expect(res.status).toBe(200);

      const body = (await res.json()) as Body;
      expect(body).toEqual({ summary: null, unavailable: "budget" });
    });

    expect(createMessage).not.toHaveBeenCalled();
    // Being over budget must not even cost a provider request to discover.
    expect(getPRDiff).not.toHaveBeenCalled();
  });

  it("distinguishes a budget block from a generic error, so the card can explain itself", () => {
    const err = new BudgetExceededError(3, 3);
    expect(err.status).toBe(429);
  });
});

describe("unknown ids", () => {
  it("404s on a ticket that does not exist", async () => {
    await withServer(app(), async (base) => {
      expect((await get(base, 9999)).status).toBe(404);
    });
  });
});
