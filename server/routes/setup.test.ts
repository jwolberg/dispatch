import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { withServer, resetDb } from "../test/helpers.js";
import { setProviderFactory } from "../providers/index.js";
import { reposRouter } from "./repos.js";
import { insertRepo, updateRepoContext } from "../db/repos.js";
import { detectStack, claudeWorkflow, SECRET_NAME } from "../setup/templates.js";
import type { GitProvider, PutFileInput } from "../providers/types.js";

// #4 stage 4b — POST /api/repos/:id/setup. One POST commits the workflow, a
// stack-aware ci.yml, and the three skills, and writes exactly one secret.

const TOKEN = "sk-ant-oat-hunter2-do-not-leak";

function harness(opts: { automation?: boolean } = {}) {
  const putFile = vi.fn(async (input: PutFileInput) => ({ committed: true, commitUrl: null }));
  // Declare the parameters: `vi.fn(async () => …)` infers a zero-arg signature and
  // `mock.calls` then types as `[]`, so the assertions stop typechecking.
  const setSecret = vi.fn(async (_name: string, _value: string) => {});
  const deleteSecret = vi.fn(async (_name: string) => true);

  const provider = {
    automationSetup: () => (opts.automation === false ? null : { putFile, setSecret, deleteSecret }),
  } as unknown as GitProvider;

  setProviderFactory(() => provider);
  return { putFile, setSecret, deleteSecret };
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
});
