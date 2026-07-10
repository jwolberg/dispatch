import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { withServer, resetDb } from "../test/helpers.js";
import { setProviderFactory } from "../providers/index.js";
import { reposRouter } from "./repos.js";
import { listRepos } from "../db/repos.js";
import type { GitProvider, RepoContext } from "../providers/types.js";

// #23 — tracking the same GitHub repo twice used to append a second row, because
// `UNIQUE (provider, host, path)` cannot dedupe a NULL host. POST is now
// idempotent: the second call returns the existing row with 200, not a new one.

const CONTEXT: RepoContext = {
  description: "widgets",
  defaultBranch: "main",
  language: "TypeScript",
  claudeMd: null,
  readmeExcerpt: null,
  fileTree: ["src/", "src/index.ts"],
  automationDetected: false,
};

const getRepoContext = vi.fn(async (): Promise<RepoContext> => CONTEXT);

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/repos", reposRouter);
  return a;
}

async function track(baseUrl: string, path = "acme/widgets") {
  const res = await fetch(`${baseUrl}/api/repos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "github", host: null, path }),
  });
  return { status: res.status, body: (await res.json()) as { repo?: { id: number }; error?: string } };
}

beforeEach(() => {
  resetDb();
  getRepoContext.mockClear();
  // Issue import is best-effort in the route; give it nothing to do.
  setProviderFactory(() => ({ getRepoContext, listIssues: async () => [] }) as unknown as GitProvider);
});
afterEach(() => setProviderFactory(null));

describe("POST /api/repos is idempotent per repo identity", () => {
  it("returns 201 then 200 with the same id, and never a second row", async () => {
    await withServer(app(), async (baseUrl) => {
      const first = await track(baseUrl);
      expect(first.status).toBe(201);
      const id = first.body.repo!.id;

      const second = await track(baseUrl);
      expect(second.status).toBe(200);
      expect(second.body.repo!.id).toBe(id);
    });

    expect(listRepos()).toHaveLength(1);
  });

  it("refreshes the cached context on the idempotent re-track", async () => {
    await withServer(app(), async (baseUrl) => {
      await track(baseUrl);
      getRepoContext.mockResolvedValueOnce({ ...CONTEXT, language: "Rust", automationDetected: true });
      const again = await track(baseUrl);

      expect(again.status).toBe(200);
      const row = listRepos()[0];
      expect(row.language).toBe("Rust");
      expect(row.automation_detected).toBe(1);
    });
  });

  it("still creates separate rows for genuinely different repos", async () => {
    await withServer(app(), async (baseUrl) => {
      expect((await track(baseUrl, "acme/widgets")).status).toBe(201);
      expect((await track(baseUrl, "acme/gadgets")).status).toBe(201);
    });
    expect(listRepos()).toHaveLength(2);
  });

  it("does not persist a row when the provider rejects the repo", async () => {
    getRepoContext.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));
    await withServer(app(), async (baseUrl) => {
      const res = await track(baseUrl);
      expect(res.status).toBe(404);
    });
    expect(listRepos()).toHaveLength(0);
  });
});
