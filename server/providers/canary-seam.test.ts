import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubProvider } from "./github.js";
import { GitLabProvider } from "./gitlab.js";
import { EnvTokenSource } from "./token-source.js";
import type { RepoRef } from "./types.js";

// #5 — the canary orchestrator needs three seam methods PR #26 did not add:
// closeIssue and deleteBranch (cleanup, on both pass and fail paths), and a
// raw-run fetch that preserves `action_required` (the collapsed getWorkflowRuns
// erases it). These tests stub `fetch` and assert the HTTP call each adapter
// makes, mirroring pr-creation.test.ts.

const REPO: RepoRef = { provider: "github", path: "o/r" };
const GL_REPO: RepoRef = { provider: "gitlab", path: "g/p" };

function stubFetch(body: unknown, status = 200) {
  const mock = vi.fn(
    async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

type FetchMock = ReturnType<typeof stubFetch>;

function requests(m: FetchMock): { url: string; method: string; body: string | null }[] {
  return m.mock.calls.map(([first, init]) => {
    if (first instanceof Request) return { url: first.url, method: first.method, body: null };
    return { url: String(first), method: init?.method ?? "GET", body: (init?.body as string) ?? null };
  });
}

const callsTo = (m: FetchMock, needle: string) => requests(m).filter((r) => r.url.includes(needle));

const gh = () => new GitHubProvider(new EnvTokenSource("ghp_x"));
const gl = () => new GitLabProvider("glpat_x");

afterEach(() => vi.unstubAllGlobals());

describe("GitHubProvider.closeIssue", () => {
  it("PATCHes the issue to state closed", async () => {
    const mock = stubFetch({ number: 7, state: "closed" });
    await gh().closeIssue(REPO, 7);

    const call = callsTo(mock, "/repos/o/r/issues/7")[0];
    expect(call.method).toBe("PATCH");
    expect(JSON.parse(String(call.body))).toMatchObject({ state: "closed" });
  });
});

describe("GitHubProvider.deleteBranch", () => {
  it("DELETEs the git ref under heads/", async () => {
    const mock = stubFetch({});
    await gh().deleteBranch(REPO, "claude/issue-9-canary");

    // Octokit percent-encodes the slashes in the ref path param.
    const call = callsTo(mock, "/repos/o/r/git/refs/heads%2Fclaude%2Fissue-9-canary")[0];
    expect(call.method).toBe("DELETE");
  });

  it("tolerates a branch that does not exist (nothing to clean up)", async () => {
    stubFetch({ message: "Reference does not exist" }, 422);
    // A canary that never produced a branch must not turn cleanup into an error.
    await expect(gh().deleteBranch(REPO, "claude/never-created")).resolves.toBeUndefined();
  });
});

describe("GitLabProvider parity", () => {
  it("closeIssue PUTs a close state event", async () => {
    const mock = stubFetch({ iid: 7, state: "closed" });
    await gl().closeIssue(GL_REPO, 7);

    const call = callsTo(mock, "issues/7")[0];
    expect(call.method).toBe("PUT");
  });

  it("deleteBranch DELETEs the branch", async () => {
    const mock = stubFetch({});
    await gl().deleteBranch(GL_REPO, "claude/issue-9-canary");

    const call = callsTo(mock, "branches")[0];
    expect(call.method).toBe("DELETE");
  });

  it("deleteBranch tolerates a missing branch", async () => {
    stubFetch({ message: "404 Branch Not Found" }, 404);
    await expect(gl().deleteBranch(GL_REPO, "claude/never")).resolves.toBeUndefined();
  });
});
