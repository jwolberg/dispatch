import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GitHubProvider } from "./github.js";
import { GitLabProvider } from "./gitlab.js";
import { EnvTokenSource } from "./token-source.js";
import type { RepoRef } from "./types.js";

// #4 stage 2 — the seam gains what the poller needs to open a PR for Claude's
// branch: list branches, read a tip commit's identity, create the pull request.
//
// The identity payloads below are NOT invented. They are the raw responses
// sampled in stage 1 (`server/poller/__fixtures__/`, run 29069518765), replayed
// through the adapter. If GitHub ever changes how it resolves a bot commit's
// author, these tests fail here rather than in production.

const FIXTURES = resolve(import.meta.dirname, "../poller/__fixtures__");
const claudeTip = JSON.parse(readFileSync(`${FIXTURES}/claude-branch-tip.json`, "utf8"));
const humanTip = JSON.parse(readFileSync(`${FIXTURES}/human-branch-tip.json`, "utf8"));

const REPO: RepoRef = { provider: "github", path: "o/r" };
const GL_REPO: RepoRef = { provider: "gitlab", path: "g/p" };

/**
 * Answer every request with `body`; capture the calls.
 *
 * The parameters are declared even though they are unused: `vi.fn(async () => …)`
 * infers a zero-argument signature, and `mock.calls` then types as `[]` — the
 * assertions below still pass at runtime but stop typechecking.
 */
function stubFetch(body: unknown, status = 200) {
  const mock = vi.fn(
    // `RequestInfo` is a DOM lib type the server tsconfig does not load; derive
    // the signature from the global `fetch` instead.
    async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

const gh = () => new GitHubProvider(new EnvTokenSource("ghp_x"));
const gl = () => new GitLabProvider("glpat_x");

/**
 * The two SDKs call `fetch` differently: Octokit passes `(urlString, init)`,
 * gitbeaker passes a single `Request`. Normalize before asserting, or a URL
 * match silently reads "[object Request]" and every assertion passes vacuously.
 */
type FetchMock = ReturnType<typeof stubFetch>;

function requests(m: FetchMock): { url: string; method: string }[] {
  return m.mock.calls.map(([first, init]) => {
    if (first instanceof Request) return { url: first.url, method: first.method };
    return { url: String(first), method: init?.method ?? "GET" };
  });
}

const callsTo = (m: FetchMock, needle: string) => requests(m).filter((r) => r.url.includes(needle));

afterEach(() => vi.unstubAllGlobals());

describe("GitHubProvider.listBranches", () => {
  it("returns each branch with the sha it points at", async () => {
    const mock = stubFetch([
      { name: "main", commit: { sha: "aaa1111" } },
      { name: "claude/issue-20-20260710-0438", commit: { sha: "b68bc04" } },
    ]);
    const branches = await gh().listBranches(REPO);

    expect(callsTo(mock, "/repos/o/r/branches").length).toBe(1);
    expect(branches).toEqual([
      { name: "main", sha: "aaa1111" },
      { name: "claude/issue-20-20260710-0438", sha: "b68bc04" },
    ]);
  });
});

describe("GitHubProvider.getCommitIdentity — replayed from the stage-1 sample", () => {
  it("reads Claude's tip: git name claude[bot], resolved login github-actions[bot], type Bot", async () => {
    stubFetch(claudeTip);
    const id = await gh().getCommitIdentity(REPO, claudeTip.sha);

    expect(id).toEqual({
      authorName: "claude[bot]",
      authorLogin: "github-actions[bot]", // NOT claude[bot] — resolved from the email
      authorType: "Bot",
    });
  });

  it("reads a human's tip", async () => {
    stubFetch(humanTip);
    const id = await gh().getCommitIdentity(REPO, humanTip.sha);

    expect(id).toEqual({ authorName: "Jay Wolberg", authorLogin: "jwolberg", authorType: "User" });
  });

  it("tolerates an unresolvable author — a commit whose email matches no account", async () => {
    stubFetch({ sha: "c0ffee1", commit: { author: { name: "Nobody" } }, author: null });
    const id = await gh().getCommitIdentity(REPO, "c0ffee1");

    expect(id).toEqual({ authorName: "Nobody", authorLogin: null, authorType: null });
  });
});

describe("GitHubProvider.createPullRequest", () => {
  it("POSTs to /pulls and normalizes the response to a PRRef", async () => {
    const mock = stubFetch({
      number: 31,
      html_url: "https://github.com/o/r/pull/31",
      head: { ref: "claude/issue-20" },
      base: { ref: "main" },
    });
    const pr = await gh().createPullRequest(REPO, {
      head: "claude/issue-20",
      base: "main",
      title: "Claude: implement #20",
      body: "Fixes #20",
    });

    expect(callsTo(mock, "/repos/o/r/pulls")[0].method).toBe("POST");
    // Octokit passes `(url, init)`, so the JSON body is on `init`.
    const call = mock.mock.calls.find(([u]) => String(u).includes("/pulls"));
    expect(call).toBeDefined();
    expect(JSON.parse(String(call![1]?.body))).toMatchObject({
      head: "claude/issue-20",
      base: "main",
      title: "Claude: implement #20",
      body: "Fixes #20",
    });
    expect(pr).toEqual({
      number: 31,
      url: "https://github.com/o/r/pull/31",
      headBranch: "claude/issue-20",
      baseBranch: "main",
    });
  });
});

describe("GitLabProvider parity", () => {
  it("listBranches maps name + commit id", async () => {
    stubFetch([{ name: "main", commit: { id: "aaa1111" } }]);
    expect(await gl().listBranches(GL_REPO)).toEqual([{ name: "main", sha: "aaa1111" }]);
  });

  it("getCommitIdentity has no bot/user distinction to report", async () => {
    // GitLab's commit payload carries author_name but no resolved account type.
    // Reporting null is honest; inventing "User" would let a GitLab poller open a
    // PR from a human branch (#4 AC 9).
    stubFetch({ id: "aaa1111", author_name: "Jay Wolberg" });
    expect(await gl().getCommitIdentity(GL_REPO, "aaa1111")).toEqual({
      authorName: "Jay Wolberg",
      authorLogin: null,
      authorType: null,
    });
  });

  it("createPullRequest opens a merge request and normalizes it", async () => {
    const mock = stubFetch({
      iid: 9,
      web_url: "https://gitlab.com/g/p/-/merge_requests/9",
      source_branch: "claude/issue-3",
      target_branch: "main",
    });
    const pr = await gl().createPullRequest(GL_REPO, {
      head: "claude/issue-3",
      base: "main",
      title: "t",
      body: "b",
    });

    expect(callsTo(mock, "merge_requests")[0].method).toBe("POST");
    expect(pr).toEqual({
      number: 9,
      url: "https://gitlab.com/g/p/-/merge_requests/9",
      headBranch: "claude/issue-3",
      baseBranch: "main",
    });
  });
});
