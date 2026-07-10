import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubProvider } from "./github.js";
import { EnvTokenSource } from "./token-source.js";
import { implementationPrompt, issueBody } from "./prompt.js";
import type { SpecInput } from "./types.js";

// #4 / ADR-0006 [2] — Dispatch opens the pull request, not the workflow.
//
// The issue body Dispatch files is a *prompt*. It used to end "Open a PR
// referencing this issue", which is now wrong three times over:
//
//   1. `claude.yml` drops `pull-requests: write`, so Claude cannot open one.
//   2. The workflow's own --append-system-prompt says Dispatch opens it. Giving
//      Claude one instruction through two channels that disagree stalls the build.
//   3. A PR opened by the workflow's token would not trigger `on: pull_request`
//      CI anyway — the reason ADR-0006 [2] moved the job to Dispatch.
//
// The auto-close keyword must survive: it closes the issue when Dispatch's PR
// merges, and `linksToIssue()` reads it.

const SPEC: SpecInput = { title: "Add a widget", body_markdown: "Make it blue.", labels: [] };

function stubFetch(body: unknown) {
  const mock = vi.fn(
    async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** The JSON body of the POST that created the issue. */
function issueBodySent(mock: ReturnType<typeof vi.fn>): string {
  const call = mock.mock.calls.find(
    ([url, init]) => String(url).includes("/issues") && (init as RequestInit | undefined)?.method === "POST"
  );
  if (!call) throw new Error("no POST to /issues was made");
  return JSON.parse(String((call[1] as RequestInit).body)).body as string;
}

afterEach(() => vi.unstubAllGlobals());

describe("implementationPrompt", () => {
  it("never issues the imperative 'open a pull request'", () => {
    // The old text. Anchored on the imperative so the *negative* instruction
    // ("Do not create a pull request") does not trip the guard.
    expect(implementationPrompt("github")).not.toMatch(/(?:^|[^t] )open an? (pull request|PR|MR)/i);
    expect(implementationPrompt("github")).not.toMatch(/\bOpen a PR referencing\b/i);
  });

  it("tells Claude to commit on a branch and not to create the PR itself", () => {
    const p = implementationPrompt("github");
    expect(p).toMatch(/commit your work on a branch/i);
    expect(p).toMatch(/do not create a pull request/i);
    expect(p).toMatch(/dispatch opens the pull request/i);
  });

  it("keeps @claude and GitHub's auto-close keyword", () => {
    const p = implementationPrompt("github");
    expect(p).toContain("@claude");
    expect(p).toContain("Fixes #");
    expect(p).not.toContain("Closes #");
  });

  it("uses GitLab's vocabulary and keyword", () => {
    const p = implementationPrompt("gitlab");
    expect(p).toMatch(/do not create a merge request/i);
    expect(p).toMatch(/dispatch opens the merge request/i);
    expect(p).toContain("Closes #");
    expect(p).not.toContain("Fixes #");
    expect(p).not.toMatch(/pull request/i);
  });

  it("issueBody keeps the spec above the instruction", () => {
    const body = issueBody("github", "Make it blue.");
    expect(body.startsWith("Make it blue.\n\n---\n")).toBe(true);
    expect(body).toContain("@claude");
  });
});

describe("GitHubProvider.createIssue files that prompt", () => {
  it("sends the shared instruction, not a copy that can drift", async () => {
    const mock = stubFetch({ number: 7, html_url: "https://github.com/o/r/issues/7", title: SPEC.title });
    await new GitHubProvider(new EnvTokenSource("ghp_x")).createIssue({ provider: "github", path: "o/r" }, SPEC);

    expect(issueBodySent(mock)).toBe(issueBody("github", SPEC.body_markdown));
  });
});
