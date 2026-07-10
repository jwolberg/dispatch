import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubProvider } from "./github.js";
import { EnvTokenSource } from "./token-source.js";

// #21 — a PAT and an installation token answer *different questions*.
//
//   GET /user/repos                 "every repo this user can reach"
//   GET /installation/repositories  "every repo this installation was granted"
//
// The second does not exist for a PAT; the first returns 403 for an installation
// token. So the adapter must know which credential it holds — and the caller must
// still not know, which is why the scope is set at construction by the factory.

function repoPayload(fullName: string) {
  return {
    full_name: fullName,
    description: "a repo",
    default_branch: "main",
    language: "TypeScript",
    private: false,
    pushed_at: "2026-07-01T00:00:00Z",
    html_url: `https://github.com/${fullName}`,
  };
}

/** Capture the URLs Octokit actually requests. */
function stubFetch(body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const urlsOf = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map(([url]) => String(url));

afterEach(() => vi.unstubAllGlobals());

describe("GitHubProvider.discoverRepos", () => {
  describe("user scope (a PAT)", () => {
    it("asks GET /user/repos", async () => {
      const fetchMock = stubFetch([repoPayload("jwolberg/dispatch")]);
      await new GitHubProvider(new EnvTokenSource("ghp_pat"), null, undefined, "user").discoverRepos();

      expect(urlsOf(fetchMock)[0]).toContain("/user/repos");
      expect(urlsOf(fetchMock)[0]).not.toContain("/installation/repositories");
    });

    it("is the default scope, so the PAT path cannot regress by omission", async () => {
      const fetchMock = stubFetch([repoPayload("jwolberg/dispatch")]);
      await new GitHubProvider(new EnvTokenSource("ghp_pat")).discoverRepos();
      expect(urlsOf(fetchMock)[0]).toContain("/user/repos");
    });

    it("normalizes to RepoSummary", async () => {
      stubFetch([repoPayload("jwolberg/dispatch")]);
      const repos = await new GitHubProvider(new EnvTokenSource("ghp_pat")).discoverRepos();

      expect(repos).toEqual([
        {
          provider: "github",
          host: null,
          path: "jwolberg/dispatch",
          description: "a repo",
          defaultBranch: "main",
          language: "TypeScript",
          visibility: "public",
          lastActivity: "2026-07-01T00:00:00Z",
          webUrl: "https://github.com/jwolberg/dispatch",
        },
      ]);
    });
  });

  describe("installation scope (a GitHub App)", () => {
    it("asks GET /installation/repositories, never /user/repos", async () => {
      // /user/repos with an installation token is a 403. This is the whole reason
      // the scope exists.
      const fetchMock = stubFetch({ total_count: 1, repositories: [repoPayload("acme/widgets")] });
      await new GitHubProvider(new EnvTokenSource("ghs_inst"), null, undefined, "installation").discoverRepos();

      const urls = urlsOf(fetchMock);
      expect(urls[0]).toContain("/installation/repositories");
      expect(urls.some((u) => u.includes("/user/repos"))).toBe(false);
    });

    it("unwraps the `repositories` envelope, which /user/repos does not have", async () => {
      stubFetch({ total_count: 1, repositories: [repoPayload("acme/widgets")] });
      const repos = await new GitHubProvider(
        new EnvTokenSource("ghs_inst"),
        null,
        undefined,
        "installation"
      ).discoverRepos();

      expect(repos.map((r) => r.path)).toEqual(["acme/widgets"]);
    });

    it("normalizes identically to the PAT path", async () => {
      stubFetch({ total_count: 1, repositories: [repoPayload("acme/widgets")] });
      const [repo] = await new GitHubProvider(
        new EnvTokenSource("ghs_inst"),
        null,
        undefined,
        "installation"
      ).discoverRepos();

      expect(repo).toEqual({
        provider: "github",
        host: null,
        path: "acme/widgets",
        description: "a repo",
        defaultBranch: "main",
        language: "TypeScript",
        visibility: "public",
        lastActivity: "2026-07-01T00:00:00Z",
        webUrl: "https://github.com/acme/widgets",
      });
    });

    it("returns an empty list for an installation granted nothing", async () => {
      stubFetch({ total_count: 0, repositories: [] });
      const repos = await new GitHubProvider(
        new EnvTokenSource("ghs_inst"),
        null,
        undefined,
        "installation"
      ).discoverRepos();

      expect(repos).toEqual([]);
    });
  });
});
