import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isClaudeAuthored } from "./claude-branch.js";
import { openPRForClaudeBranch, CANARY_LABEL } from "./reconcile.js";
import type { BranchRef, CommitIdentity, GitProvider, Issue, RepoRef } from "../providers/types.js";

// #4 stage 3 — the poller opens the PR for Claude's branch, and NEVER for a
// human's. Opening a pull request from somebody's work-in-progress branch is not
// recoverable, so every guard here has a test.

const FIX = resolve(import.meta.dirname, "./__fixtures__");
const claudeTip = JSON.parse(readFileSync(`${FIX}/claude-branch-tip.json`, "utf8"));
const humanTip = JSON.parse(readFileSync(`${FIX}/human-branch-tip.json`, "utf8"));

/** Exactly the shape the adapter produces from those payloads. */
const idOf = (raw: typeof claudeTip): CommitIdentity => ({
  authorName: raw.commit.author.name,
  authorLogin: raw.author?.login ?? null,
  authorType: raw.author?.type ?? null,
});

const CLAUDE = idOf(claudeTip);
const HUMAN = idOf(humanTip);
const DEPENDABOT: CommitIdentity = {
  authorName: "dependabot[bot]",
  authorLogin: "dependabot[bot]",
  authorType: "Bot",
};
// GitLab resolves no account and reports no bot/user distinction.
const GITLAB: CommitIdentity = { authorName: "claude[bot]", authorLogin: null, authorType: null };

const REPO: RepoRef = { provider: "github", path: "o/r", defaultBranch: "main" };
const OPEN_ISSUE: Issue = {
  number: 7,
  title: "Add a widget",
  body: "",
  state: "open",
  labels: ["dispatch"],
  comments: [],
  url: "https://github.com/o/r/issues/7",
};

function provider(branches: BranchRef[], identities: Record<string, CommitIdentity>) {
  const createPullRequest = vi.fn(async () => ({
    number: 31,
    url: "https://github.com/o/r/pull/31",
    headBranch: "x",
    baseBranch: "main",
  }));
  const p = {
    listBranches: vi.fn(async () => branches),
    getCommitIdentity: vi.fn(async (_r: RepoRef, sha: string) => identities[sha]),
    createPullRequest,
  } as unknown as GitProvider;
  return { p, createPullRequest };
}

describe("isClaudeAuthored — against the sampled payloads", () => {
  it("accepts Claude's tip", () => expect(isClaudeAuthored(CLAUDE)).toBe(true));
  it("rejects a human's tip", () => expect(isClaudeAuthored(HUMAN)).toBe(false));
  it("rejects Dependabot — Bot is not enough", () => expect(isClaudeAuthored(DEPENDABOT)).toBe(false));
  it("rejects GitLab, which reports no type", () => expect(isClaudeAuthored(GITLAB)).toBe(false));
  it("rejects a login-based rule that would never have fired", () => {
    // The trap: GitHub resolves the author by email, so the login is
    // github-actions[bot]. A rule keyed on `authorLogin === "claude[bot]"` is dead.
    expect(CLAUDE.authorLogin).toBe("github-actions[bot]");
    expect(CLAUDE.authorLogin).not.toBe("claude[bot]");
  });
});

describe("openPRForClaudeBranch", () => {
  it("opens a PR from Claude's branch, with the auto-close keyword", async () => {
    const { p, createPullRequest } = provider(
      [
        { name: "main", sha: "m1" },
        { name: "claude/issue-7-20260710-0438", sha: "c1" },
      ],
      { m1: HUMAN, c1: CLAUDE }
    );

    const pr = await openPRForClaudeBranch(p, REPO, OPEN_ISSUE);

    expect(createPullRequest).toHaveBeenCalledOnce();
    const [, input] = createPullRequest.mock.calls[0] as unknown as [RepoRef, { head: string; base: string; body: string }];
    expect(input.head).toBe("claude/issue-7-20260710-0438");
    expect(input.base).toBe("main");
    expect(input.body).toContain("Fixes #7");
    expect(pr?.number).toBe(31);
  });

  it("never opens a PR from a human's branch, even though it links to the issue", async () => {
    // `linksToIssue(7, {branch: "fix-7"})` is TRUE. Only the identity saves us.
    const { p, createPullRequest } = provider([{ name: "fix-7", sha: "h1" }], { h1: HUMAN });

    expect(await openPRForClaudeBranch(p, REPO, OPEN_ISSUE)).toBeNull();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("never opens a PR from Dependabot's branch", async () => {
    const { p, createPullRequest } = provider([{ name: "dependabot/npm/lodash-7", sha: "d1" }], { d1: DEPENDABOT });

    expect(await openPRForClaudeBranch(p, REPO, OPEN_ISSUE)).toBeNull();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("never opens a PR on GitLab, where identity cannot be established", async () => {
    const { p, createPullRequest } = provider([{ name: "claude/issue-7", sha: "g1" }], { g1: GITLAB });

    const glRepo: RepoRef = { provider: "gitlab", path: "g/p", defaultBranch: "main" };
    expect(await openPRForClaudeBranch(p, glRepo, OPEN_ISSUE)).toBeNull();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("ignores branches that do not link to the issue", async () => {
    const { p, createPullRequest } = provider([{ name: "claude/issue-9", sha: "c9" }], { c9: CLAUDE });

    expect(await openPRForClaudeBranch(p, REPO, OPEN_ISSUE)).toBeNull();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("never opens a PR from the default branch, even if its number matches", async () => {
    // A repo whose default branch is `release-7` would otherwise link to issue #7
    // and get a PR opened from main onto main.
    const repo: RepoRef = { ...REPO, defaultBranch: "release-7" };
    const { p, createPullRequest } = provider([{ name: "release-7", sha: "c1" }], { c1: CLAUDE });

    expect(await openPRForClaudeBranch(p, repo, OPEN_ISSUE)).toBeNull();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("does not reconsider a closed issue", async () => {
    const { p, createPullRequest } = provider([{ name: "claude/issue-7", sha: "c1" }], { c1: CLAUDE });

    const closed: Issue = { ...OPEN_ISSUE, state: "closed" };
    expect(await openPRForClaudeBranch(p, REPO, closed)).toBeNull();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("swallows a race where the PR already exists, rather than failing the poll", async () => {
    const { p, createPullRequest } = provider([{ name: "claude/issue-7", sha: "c1" }], { c1: CLAUDE });
    createPullRequest.mockRejectedValueOnce(
      Object.assign(new Error("A pull request already exists for o:claude/issue-7."), { status: 422 })
    );

    await expect(openPRForClaudeBranch(p, REPO, OPEN_ISSUE)).resolves.toBeNull();
  });

  it("never opens a PR for a canary issue, even when its branch IS Claude-authored (#5)", async () => {
    // Same shape as the happy path above — a Claude-authored branch that links to
    // the issue — so the CANARY_LABEL is the ONLY thing preventing the PR. A canary
    // must exercise `@claude` end to end without leaving a pull request behind in a
    // user's repo (#5, amended after #4 shipped the auto-open poller).
    const { p, createPullRequest } = provider(
      [
        { name: "main", sha: "m1" },
        { name: "claude/issue-7-20260710-0438", sha: "c1" },
      ],
      { m1: HUMAN, c1: CLAUDE }
    );
    const canary: Issue = { ...OPEN_ISSUE, labels: [...OPEN_ISSUE.labels, CANARY_LABEL] };

    expect(await openPRForClaudeBranch(p, REPO, canary)).toBeNull();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("costs one identity lookup per linking branch, not per branch", async () => {
    const { p } = provider(
      [
        { name: "main", sha: "m1" },
        { name: "chore/cleanup", sha: "x1" },
        { name: "claude/issue-7", sha: "c1" },
      ],
      { m1: HUMAN, x1: HUMAN, c1: CLAUDE }
    );

    await openPRForClaudeBranch(p, REPO, OPEN_ISSUE);
    // `main` is excluded as the base; `chore/cleanup` does not link to #7.
    expect((p.getCommitIdentity as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});
