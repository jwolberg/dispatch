import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { withServer, resetDb } from "../test/helpers.js";
import { setProviderFactory } from "../providers/index.js";
import { reposRouter } from "./repos.js";
import { insertRepo, updateRepoContext } from "../db/repos.js";
import { detectStack, claudeWorkflow, SECRET_NAME } from "../setup/templates.js";
import { SqliteInstallationStore } from "../db/installations.js";
import { getDb } from "../db/migrate.js";
import { loadEncryptionKey, ENCRYPTION_KEY_ENV } from "../lib/crypto.js";
import { randomBytes } from "node:crypto";
import type { GitProvider, PutFileInput } from "../providers/types.js";

// #4 stage 4b — POST /api/repos/:id/setup. One POST commits the workflow, a
// stack-aware ci.yml, and the three skills, and writes exactly one secret.

const TOKEN = "sk-ant-oat-hunter2-do-not-leak";

function harness(opts: { automation?: boolean } = {}) {
  const putFile = vi.fn(async (input: PutFileInput) => ({ committed: true, commitUrl: null }));
  // Setup re-reads context so the card's warning clears; detection now finds the
  // workflow it just committed.
  const getRepoContext = vi.fn(async () => ({
    description: null,
    defaultBranch: "main",
    language: "TypeScript",
    claudeMd: null,
    readmeExcerpt: null,
    fileTree: ["package.json"],
    automationDetected: true,
  }));
  // Declare the parameters: `vi.fn(async () => …)` infers a zero-arg signature and
  // `mock.calls` then types as `[]`, so the assertions stop typechecking.
  const setSecret = vi.fn(async (_name: string, _value: string) => {});
  const deleteSecret = vi.fn(async (_name: string) => true);

  const provider = {
    automationSetup: () => (opts.automation === false ? null : { putFile, setSecret, deleteSecret }),
    getRepoContext,
  } as unknown as GitProvider;

  setProviderFactory(() => provider);
  return { putFile, setSecret, deleteSecret, getRepoContext };
}

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/repos", reposRouter);
  return a;
}

function seedRepo(fileTree: string[] = ["package.json", "src/"]) {
  const row = insertRepo({ provider: "github", path: "acme/widgets", default_branch: "main" });
  updateRepoContext(row.id, { file_tree_cache: JSON.stringify(fileTree) });
  return row.id;
}

const post = async (baseUrl: string, id: number, body: unknown) => {
  const res = await fetch(`${baseUrl}/api/repos/${id}/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

beforeEach(() => resetDb());
afterEach(() => setProviderFactory(null));

describe("POST /api/repos/:id/setup", () => {
  it("commits the workflow, a node ci.yml, and the three skills", async () => {
    const { putFile } = harness();
    const id = seedRepo(["package.json"]);

    await withServer(app(), async (url) => {
      const res = await post(url, id, { token: TOKEN, mode: "oauth" });
      expect(res.status).toBe(200);
    });

    const paths = putFile.mock.calls.map(([f]) => f.path);
    expect(paths).toContain(".github/workflows/claude.yml");
    expect(paths).toContain(".github/workflows/ci.yml");
    expect(paths).toContain(".claude/skills/plan/SKILL.md");
    expect(paths).toContain(".claude/skills/implement/SKILL.md");
    expect(paths).toContain(".claude/skills/debug/SKILL.md");
  });

  it("never clobbers an existing ci.yml", async () => {
    const { putFile } = harness();
    const id = seedRepo(["package.json"]);
    await withServer(app(), async (url) => post(url, id, { token: TOKEN, mode: "oauth" }));

    const ci = putFile.mock.calls.map(([f]) => f).find((f) => f.path.endsWith("ci.yml"))!;
    expect(ci.createOnly).toBe(true);
    const claude = putFile.mock.calls.map(([f]) => f).find((f) => f.path.endsWith("claude.yml"))!;
    expect(claude.createOnly).toBeFalsy(); // ours; keep it current
  });

  it("skips ci.yml on an unknown stack rather than shipping a gate that always fails", async () => {
    const { putFile } = harness();
    const id = seedRepo(["main.rs", "Cargo.toml"]);
    await withServer(app(), async (url) => post(url, id, { token: TOKEN, mode: "oauth" }));

    expect(putFile.mock.calls.map(([f]) => f.path)).not.toContain(".github/workflows/ci.yml");
  });

  it("in OAuth mode writes ONE secret and deletes ANTHROPIC_API_KEY (AC 5)", async () => {
    // The API key outranks the OAuth token in Claude's auth precedence: leaving it
    // behind would silently keep billing the metered API.
    const { setSecret, deleteSecret } = harness();
    const id = seedRepo();
    await withServer(app(), async (url) => post(url, id, { token: TOKEN, mode: "oauth" }));

    expect(setSecret).toHaveBeenCalledOnce();
    expect(setSecret).toHaveBeenCalledWith(SECRET_NAME.oauth, TOKEN);
    expect(deleteSecret).toHaveBeenCalledWith("ANTHROPIC_API_KEY");
  });

  it("in apikey mode writes ANTHROPIC_API_KEY and deletes nothing", async () => {
    const { setSecret, deleteSecret } = harness();
    const id = seedRepo();
    await withServer(app(), async (url) => post(url, id, { token: TOKEN, mode: "apikey" }));

    expect(setSecret).toHaveBeenCalledWith(SECRET_NAME.apikey, TOKEN);
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  it("writes no GitHub credential into the repo (AC 3)", async () => {
    const { setSecret } = harness();
    const id = seedRepo();
    await withServer(app(), async (url) => post(url, id, { token: TOKEN, mode: "oauth" }));

    const names = setSecret.mock.calls.map(([n]) => n);
    expect(names).not.toContain("GH_PAT");
    expect(names).not.toContain("APP_PRIVATE_KEY");
    expect(names).not.toContain("APP_CLIENT_ID");
    expect(names).toHaveLength(1);
  });

  it("never echoes the token back in the response (AC 13)", async () => {
    harness();
    const id = seedRepo();
    await withServer(app(), async (url) => {
      const res = await post(url, id, { token: TOKEN, mode: "oauth" });
      expect(JSON.stringify(res.body)).not.toContain(TOKEN);
      expect(JSON.stringify(res.body)).not.toContain("sk-ant");
    });
  });

  it("rejects a missing token with 400, before touching the provider", async () => {
    const { putFile } = harness();
    const id = seedRepo();
    await withServer(app(), async (url) => {
      const res = await post(url, id, { mode: "oauth" });
      expect(res.status).toBe(400);
    });
    expect(putFile).not.toHaveBeenCalled();
  });

  it("404s an unknown repo", async () => {
    harness();
    await withServer(app(), async (url) => {
      expect((await post(url, 999, { token: TOKEN, mode: "oauth" })).status).toBe(404);
    });
  });

  it("501s a provider with no automation to install (GitLab)", async () => {
    harness({ automation: false });
    const id = seedRepo();
    await withServer(app(), async (url) => {
      const res = await post(url, id, { token: TOKEN, mode: "oauth" });
      expect(res.status).toBe(501);
      expect(String(res.body.error)).toMatch(/gitlab|not supported|claude-code-action/i);
    });
  });

  it("provisions claude.yml with allowed_bots when an App is registered (#29)", async () => {
    const { putFile } = harness();
    const id = seedRepo(["package.json"]);

    // Register an App so the setup route stamps its bot login into claude.yml.
    const key = loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: randomBytes(32).toString("base64") });
    new SqliteInstallationStore(getDb(), key, () => {}).saveApp({
      appId: 987654,
      slug: "dispatch-acme",
      name: "Dispatch (acme)",
      clientId: "Iv1.abc",
      clientSecret: "cs_secret",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----",
      webhookSecret: null,
      htmlUrl: null,
    });

    await withServer(app(), async (url) => post(url, id, { token: TOKEN, mode: "oauth" }));

    const claude = putFile.mock.calls.map(([f]) => f).find((f) => f.path.endsWith("claude.yml"))!;
    expect(claude.content).toContain('allowed_bots: "dispatch-acme[bot]"');
  });

  it("clears the card warning: re-reads context so automation_detected flips to 1", async () => {
    // Without this the operator clicks "Set up automation", it succeeds, and the
    // "not onboarded" warning stays on screen because the row is still cached.
    const { getRepoContext } = harness();
    const id = seedRepo();
    await withServer(app(), async (url) => {
      const res = await post(url, id, { token: TOKEN, mode: "oauth" });
      expect(res.body.repo.automation_detected).toBe(1);
    });
    expect(getRepoContext).toHaveBeenCalledOnce();
  });

  it("reports which files changed, so a re-run reads as a no-op (AC 10)", async () => {
    const { putFile } = harness();
    putFile.mockResolvedValue({ committed: false, commitUrl: null });
    const id = seedRepo();

    await withServer(app(), async (url) => {
      const res = await post(url, id, { token: TOKEN, mode: "oauth" });
      expect(res.body.files.every((f: { committed: boolean }) => f.committed === false)).toBe(true);
    });
  });
});

describe("templates", () => {
  it("detectStack reads the cached tree", () => {
    expect(detectStack(["package.json"])).toBe("node");
    expect(detectStack(["pyproject.toml"])).toBe("python");
    expect(detectStack(["requirements.txt"])).toBe("python");
    expect(detectStack(["Cargo.toml"])).toBe("unknown");
    expect(detectStack(["src/", "src/package.json"])).toBe("unknown"); // nested, not root
  });

  it("claudeWorkflow substitutes the auth line and keeps the explicit github_token", () => {
    const oauth = claudeWorkflow("oauth");
    expect(oauth).toContain("claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(oauth).not.toContain("__CLAUDE_AUTH_INPUT__");
    // #25: omitting this input makes the action demand Anthropic's Claude GitHub App.
    expect(oauth).toContain("github_token: ${{ github.token }}");
    expect(oauth).not.toContain("secrets.GH_PAT");

    expect(claudeWorkflow("apikey")).toContain("anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}");
  });

  it("stamps allowed_bots with the App bot login for an App-backed deployment (#29)", () => {
    const wf = claudeWorkflow("oauth", "dispatch-acme[bot]");
    expect(wf).toContain('allowed_bots: "dispatch-acme[bot]"');
    expect(wf).not.toContain("__ALLOWED_BOTS_INPUT__");
  });

  it("omits allowed_bots on the PAT-only path — no placeholder, no empty input (#29)", () => {
    const wf = claudeWorkflow("oauth");
    expect(wf).not.toContain("allowed_bots");
    expect(wf).not.toContain("__ALLOWED_BOTS_INPUT__");
  });
});
