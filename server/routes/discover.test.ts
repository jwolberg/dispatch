import { describe, expect, it, vi } from "vitest";
import express from "express";
import { withServer } from "../test/helpers.js";
import { __resetRegisteredSecrets, registerSecret } from "../lib/redaction.js";
import { createDiscoverRouter } from "./discover.js";
import type { AccountProvider } from "../providers/index.js";
import type { GitProvider, RepoSummary } from "../providers/types.js";

// #21 — Discover has no repo, so under a GitHub App it has no single credential.
// It asks every credential and merges. A PAT enumerates a user's repos; each
// installation token enumerates only its own.

function summary(path: string, lastActivity = "2026-07-01T00:00:00Z"): RepoSummary {
  return {
    provider: "github",
    host: null,
    path,
    description: null,
    defaultBranch: "main",
    language: null,
    visibility: "public",
    lastActivity,
    webUrl: `https://github.com/${path}`,
  };
}

/** An account whose adapter yields `repos`, or rejects. */
function account(
  label: string,
  kind: "env" | "app",
  result: RepoSummary[] | Error
): AccountProvider {
  const discoverRepos = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { label, kind, provider: { discoverRepos } as unknown as GitProvider };
}

function app(accounts: AccountProvider[]) {
  const a = express();
  a.use(express.json());
  a.use("/api/discover", createDiscoverRouter({ accounts: () => accounts }));
  return a;
}

async function get(accounts: AccountProvider[], query = "?provider=github") {
  return withServer(app(accounts), async (base) => {
    const res = await fetch(`${base}/api/discover${query}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  });
}

describe("GET /api/discover", () => {
  it("returns the env token's repos when that is the only credential", async () => {
    const { status, body } = await get([account("GITHUB_TOKEN", "env", [summary("jw/dispatch")])]);
    expect(status).toBe(200);
    expect((body.repos as RepoSummary[]).map((r) => r.path)).toEqual(["jw/dispatch"]);
  });

  it("merges repos across two installations", async () => {
    const { status, body } = await get([
      account("acme", "app", [summary("acme/widgets"), summary("acme/gadgets")]),
      account("jwolberg", "app", [summary("jwolberg/dispatch")]),
    ]);

    expect(status).toBe(200);
    expect((body.repos as RepoSummary[]).map((r) => r.path).sort()).toEqual([
      "acme/gadgets",
      "acme/widgets",
      "jwolberg/dispatch",
    ]);
  });

  it("does not 502 when GITHUB_TOKEN is unset — the whole point of #21", async () => {
    const { status, body } = await get([account("acme", "app", [summary("acme/widgets")])]);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  it("returns an empty list, not an error, when there is no credential at all", async () => {
    const { status, body } = await get([]);
    expect(status).toBe(200);
    expect(body.repos).toEqual([]);
  });

  it("keeps one account's repos when another fails", async () => {
    // A revoked installation must not blank the Repos page for every other account.
    const { status, body } = await get([
      account("acme", "app", new Error("401 Bad credentials")),
      account("jwolberg", "app", [summary("jwolberg/dispatch")]),
    ]);

    expect(status).toBe(200);
    expect((body.repos as RepoSummary[]).map((r) => r.path)).toEqual(["jwolberg/dispatch"]);
  });

  it("reports which account failed, so the failure is visible rather than silent", async () => {
    const { body } = await get([
      account("acme", "app", new Error("401 Bad credentials")),
      account("jwolberg", "app", [summary("jwolberg/dispatch")]),
    ]);

    expect(body.errors).toEqual([{ label: "acme", error: expect.stringContaining("401") }]);
  });

  it("502s only when every credential fails", async () => {
    const { status } = await get([
      account("acme", "app", new Error("boom")),
      account("GITHUB_TOKEN", "env", new Error("boom")),
    ]);
    expect(status).toBe(502);
  });

  it("deduplicates a repo visible through two credentials, preferring the App", async () => {
    // An org repo can be reachable via both a PAT and an installation. Showing it
    // twice would render two Track buttons for one repo.
    const viaApp = { ...summary("acme/widgets"), description: "from the app" };
    const viaPat = { ...summary("acme/widgets"), description: "from the pat" };

    const { body } = await get([
      account("acme", "app", [viaApp]),
      account("GITHUB_TOKEN", "env", [viaPat]),
    ]);

    const repos = body.repos as RepoSummary[];
    expect(repos).toHaveLength(1);
    expect(repos[0].description).toBe("from the app");
  });

  it("sorts by most recent activity across accounts", async () => {
    const { body } = await get([
      account("acme", "app", [summary("acme/old", "2020-01-01T00:00:00Z")]),
      account("jwolberg", "app", [summary("jwolberg/new", "2026-07-09T00:00:00Z")]),
    ]);

    expect((body.repos as RepoSummary[]).map((r) => r.path)).toEqual([
      "jwolberg/new",
      "acme/old",
    ]);
  });

  it("rejects an unknown provider before asking for a credential", async () => {
    const accounts = vi.fn(() => []);
    const a = express();
    a.use("/api/discover", createDiscoverRouter({ accounts }));

    const { status } = await withServer(a, async (base) => {
      const res = await fetch(`${base}/api/discover?provider=bitbucket`);
      return { status: res.status };
    });

    expect(status).toBe(400);
    expect(accounts).not.toHaveBeenCalled();
  });

  it("runs a failed account's error through safeMessage, so a minted token cannot leak", async () => {
    // AppTokenSource registers every token it mints. An Octokit error that echoes
    // the Authorization header would otherwise be returned to the browser verbatim.
    __resetRegisteredSecrets();
    registerSecret("ghs_supersecrettoken");
    try {
      const { body } = await get([account("acme", "app", new Error("bad token ghs_supersecrettoken"))]);
      expect(JSON.stringify(body)).not.toContain("ghs_supersecrettoken");
      expect(JSON.stringify(body)).toContain("redacted");
    } finally {
      __resetRegisteredSecrets();
    }
  });
});
