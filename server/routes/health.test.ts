import { describe, expect, it, vi } from "vitest";
import express from "express";
import { withServer } from "../test/helpers.js";
import { createHealthRouter } from "./health.js";
import { leastRemaining } from "../lib/ratelimit.js";
import type { AccountProvider } from "../providers/index.js";
import type { GitProvider, RateLimit } from "../providers/types.js";

// #21 — health had no way to say "an App is installed". It gated on
// `process.env[tokenEnv]`, so an App-only deployment reported
// `configured: false` for GitHub while an App was demonstrably registered.

function rl(remaining: number, limit = 5000): RateLimit {
  return { remaining, limit, reset: "2026-07-10T03:00:00.000Z" };
}

function account(label: string, kind: "env" | "app", result: RateLimit | Error): AccountProvider {
  const getRateLimit = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { label, kind, provider: { getRateLimit } as unknown as GitProvider };
}

async function health(byProvider: Record<string, AccountProvider[]>) {
  const a = express();
  a.use("/api/health", createHealthRouter({ accounts: (p) => byProvider[p] ?? [] }));
  return withServer(a, async (base) => {
    const res = await fetch(`${base}/api/health`);
    return (await res.json()) as {
      providers: Array<{
        provider: string;
        configured: boolean;
        valid: boolean;
        remaining: number | null;
        error: string | null;
        accounts: Array<{ label: string; kind: string; valid: boolean; remaining: number | null }>;
      }>;
    };
  });
}

const github = (body: Awaited<ReturnType<typeof health>>) =>
  body.providers.find((p) => p.provider === "github")!;

describe("leastRemaining", () => {
  it("returns the binding constraint — the smallest remaining budget", () => {
    // Two installations have two budgets. The banner shows one number, and the
    // number that matters is the one that will run out first.
    expect(leastRemaining([rl(4000), rl(120), rl(4999)])?.remaining).toBe(120);
  });

  it("carries that account's limit and reset, not another's", () => {
    const picked = leastRemaining([rl(4000, 5000), { remaining: 120, limit: 1000, reset: "R" }]);
    expect(picked).toEqual({ remaining: 120, limit: 1000, reset: "R" });
  });

  it("ignores entries with an unknown remaining rather than treating them as zero", () => {
    expect(leastRemaining([{ remaining: null, limit: null, reset: null }, rl(900)])?.remaining).toBe(900);
  });

  it("returns null for an empty list", () => {
    expect(leastRemaining([])).toBeNull();
  });

  it("returns null when no entry knows its remaining", () => {
    expect(leastRemaining([{ remaining: null, limit: null, reset: null }])).toBeNull();
  });
});

describe("GET /api/health", () => {
  it("reports configured:false when there is no credential at all", async () => {
    const gh = github(await health({}));
    expect(gh.configured).toBe(false);
    expect(gh.valid).toBe(false);
    expect(gh.accounts).toEqual([]);
  });

  it("reports configured:true for an App-only deployment — the silent lie #21 fixes", async () => {
    // Before this ticket: `configured: Boolean(process.env.GITHUB_TOKEN)` → false,
    // while an App was registered and every repo was polling through it.
    const gh = github(await health({ github: [account("acme", "app", rl(4999))] }));
    expect(gh.configured).toBe(true);
    expect(gh.valid).toBe(true);
  });

  it("returns one entry per credential, labelled", async () => {
    const gh = github(
      await health({
        github: [account("acme", "app", rl(4000)), account("GITHUB_TOKEN", "env", rl(4999))],
      })
    );

    expect(gh.accounts.map((a) => [a.label, a.kind])).toEqual([
      ["acme", "app"],
      ["GITHUB_TOKEN", "env"],
    ]);
  });

  it("surfaces the smallest remaining budget at the top level", async () => {
    const gh = github(
      await health({ github: [account("acme", "app", rl(4000)), account("jw", "app", rl(75))] })
    );
    expect(gh.remaining).toBe(75);
  });

  it("stays valid when one account fails and another works", async () => {
    const gh = github(
      await health({
        github: [account("acme", "app", new Error("401 Bad credentials")), account("jw", "app", rl(500))],
      })
    );

    expect(gh.valid).toBe(true);
    expect(gh.remaining).toBe(500);
    expect(gh.accounts.find((a) => a.label === "acme")!.valid).toBe(false);
  });

  it("is invalid, but still configured, when every account fails", async () => {
    const gh = github({ ...(await health({ github: [account("acme", "app", new Error("boom"))] })) });
    expect(gh.configured).toBe(true);
    expect(gh.valid).toBe(false);
    expect(gh.error).toContain("boom");
  });

  it("keeps GitLab independent of GitHub's credentials", async () => {
    const body = await health({ github: [account("acme", "app", rl(10))] });
    const gitlab = body.providers.find((p) => p.provider === "gitlab")!;
    expect(gitlab.configured).toBe(false);
  });

  it("never leaks a credential in an account error", async () => {
    const { __resetRegisteredSecrets, registerSecret } = await import("../lib/redaction.js");
    __resetRegisteredSecrets();
    registerSecret("ghs_healthsecrettoken");
    try {
      const body = await health({ github: [account("acme", "app", new Error("bad ghs_healthsecrettoken"))] });
      expect(JSON.stringify(body)).not.toContain("ghs_healthsecrettoken");
    } finally {
      __resetRegisteredSecrets();
    }
  });
});
