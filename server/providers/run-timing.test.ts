import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubProvider } from "./github.js";
import { GitLabProvider } from "./gitlab.js";
import { EnvTokenSource } from "./token-source.js";
import type { RepoRef } from "./types.js";

// T2-4 (ticket #14) — getRunTiming feeds the per-ticket Actions cost.
//
// The number must be the provider's BILLED duration (billable[os].total_ms),
// not wall-clock, and a run we cannot price must come back as `null` (unknown),
// never a fabricated zero.

const REPO: RepoRef = { provider: "github", host: null, path: "acme/widgets", defaultBranch: "main" };

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("GitHubProvider.getRunTiming", () => {
  it("sums billable total_ms across runner OSes", async () => {
    stubFetch(200, {
      billable: {
        UBUNTU: { total_ms: 120_000, jobs: 1 },
        WINDOWS: { total_ms: 60_000, jobs: 1 },
      },
      run_duration_ms: 999_999, // wall-clock — deliberately NOT what we report
    });
    const gh = new GitHubProvider(new EnvTokenSource("ghp_x"));

    const timing = await gh.getRunTiming(REPO, "42");
    expect(timing).toEqual({ runId: "42", billableMs: 180_000 });
  });

  it("reports a run with no billable data as a real zero, not unknown", async () => {
    stubFetch(200, { billable: {}, run_duration_ms: 0 });
    const gh = new GitHubProvider(new EnvTokenSource("ghp_x"));

    expect(await gh.getRunTiming(REPO, "42")).toEqual({ runId: "42", billableMs: 0 });
  });

  it("returns null (unknown) when the run's usage is not found", async () => {
    stubFetch(404, { message: "Not Found" });
    const gh = new GitHubProvider(new EnvTokenSource("ghp_x"));

    expect(await gh.getRunTiming(REPO, "42")).toBeNull();
  });

  it("returns null when the token lacks the Actions permission (403)", async () => {
    stubFetch(403, { message: "Resource not accessible" });
    const gh = new GitHubProvider(new EnvTokenSource("ghp_x"));

    expect(await gh.getRunTiming(REPO, "42")).toBeNull();
  });

  it("returns null for a non-numeric run id rather than calling the API", async () => {
    const fetchMock = stubFetch(200, {});
    const gh = new GitHubProvider(new EnvTokenSource("ghp_x"));

    expect(await gh.getRunTiming(REPO, "not-a-number")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GitLabProvider.getRunTiming", () => {
  it("degrades to null — GitLab has no GitHub-Actions billable minutes", async () => {
    const gl = new GitLabProvider("glpat_x");
    expect(await gl.getRunTiming()).toBeNull();
  });
});
