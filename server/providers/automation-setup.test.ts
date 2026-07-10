import { afterEach, describe, expect, it, vi } from "vitest";
import _sodium from "libsodium-wrappers";
import { GitHubProvider } from "./github.js";
import { GitLabProvider } from "./gitlab.js";
import { EnvTokenSource } from "./token-source.js";
import type { RepoRef } from "./types.js";

// #4 stage 4a — writing a repo's automation: workflow files, skills, and exactly
// one secret (the Claude auth token), sealed with the repo's public key.

const REPO: RepoRef = { provider: "github", path: "o/r", defaultBranch: "main" };
const gh = () => new GitHubProvider(new EnvTokenSource("ghp_x"));

type Call = { url: string; method: string; body: any };

/** Route each request to a handler by URL fragment; record every call. */
function stubRoutes(routes: { match: string; status?: number; body?: unknown }[]) {
  const calls: Call[] = [];
  const mock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: any = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      /* not json */
    }
    calls.push({ url, method, body });

    const route = routes.find((r) => url.includes(r.match));
    const status = route?.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(route?.body ?? {}), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const find = (calls: Call[], frag: string, method?: string) =>
  calls.filter((c) => c.url.includes(frag) && (!method || c.method === method));

afterEach(() => vi.unstubAllGlobals());

describe("GitHubProvider.automationSetup().putFile", () => {
  it("commits a new file", async () => {
    const calls = stubRoutes([
      { match: "/contents/.github/workflows/claude.yml", status: 404 },
      { match: "/contents/", body: { commit: { html_url: "https://github.com/o/r/commit/abc" } } },
    ]);
    const setup = gh().automationSetup(REPO)!;
    const res = await setup.putFile({
      path: ".github/workflows/claude.yml",
      content: "name: Claude Code\n",
      message: "ci: add claude workflow",
    });

    expect(res.committed).toBe(true);
    expect(find(calls, "/contents/", "PUT")).toHaveLength(1);
  });

  it("commits NOTHING when the file already has that exact content (AC 10)", async () => {
    // The whole point of idempotency: re-running setup must not append a commit
    // to the operator's history every time they click the button.
    const content = "name: Claude Code\n";
    const calls = stubRoutes([
      { match: "/contents/", body: { type: "file", sha: "s1", content: b64(content), encoding: "base64" } },
    ]);
    const setup = gh().automationSetup(REPO)!;
    const res = await setup.putFile({ path: "a.yml", content, message: "m" });

    expect(res.committed).toBe(false);
    expect(find(calls, "/contents/", "PUT")).toHaveLength(0);
  });

  it("updates when the content differs, passing the blob sha", async () => {
    const calls = stubRoutes([
      { match: "/contents/", body: { type: "file", sha: "s1", content: b64("old\n"), encoding: "base64" } },
    ]);
    const setup = gh().automationSetup(REPO)!;
    const res = await setup.putFile({ path: "a.yml", content: "new\n", message: "m" });

    expect(res.committed).toBe(true);
    const put = find(calls, "/contents/", "PUT")[0];
    expect(put.body.sha).toBe("s1"); // omit it and GitHub 409s
    expect(Buffer.from(put.body.content, "base64").toString("utf8")).toBe("new\n");
  });
});

describe("GitHubProvider.automationSetup().setSecret", () => {
  it("seals the value with the repo public key and never sends the plaintext", async () => {
    await _sodium.ready;
    const kp = _sodium.crypto_box_keypair();
    const pkB64 = _sodium.to_base64(kp.publicKey, _sodium.base64_variants.ORIGINAL);

    const calls = stubRoutes([
      { match: "/actions/secrets/public-key", body: { key_id: "kid-1", key: pkB64 } },
      { match: "/actions/secrets/", status: 204 },
    ]);

    const setup = gh().automationSetup(REPO)!;
    await setup.setSecret("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-hunter2");

    const put = find(calls, "/actions/secrets/CLAUDE_CODE_OAUTH_TOKEN", "PUT")[0];
    expect(put.body.key_id).toBe("kid-1");

    // The decisive assertions: the plaintext never appears on the wire, and what
    // did go out is openable by the private key.
    expect(JSON.stringify(put.body)).not.toContain("sk-ant-oat-hunter2");
    const opened = _sodium.crypto_box_seal_open(
      _sodium.from_base64(put.body.encrypted_value, _sodium.base64_variants.ORIGINAL),
      kp.publicKey,
      kp.privateKey
    );
    expect(_sodium.to_string(opened)).toBe("sk-ant-oat-hunter2");
  });
});

describe("GitHubProvider.automationSetup().deleteSecret", () => {
  it("returns true when a secret was removed", async () => {
    stubRoutes([{ match: "/actions/secrets/ANTHROPIC_API_KEY", status: 204 }]);
    expect(await gh().automationSetup(REPO)!.deleteSecret("ANTHROPIC_API_KEY")).toBe(true);
  });

  it("returns false when it was not there, rather than throwing", async () => {
    stubRoutes([{ match: "/actions/secrets/ANTHROPIC_API_KEY", status: 404 }]);
    expect(await gh().automationSetup(REPO)!.deleteSecret("ANTHROPIC_API_KEY")).toBe(false);
  });
});

describe("GitLabProvider.automationSetup", () => {
  it("is null — there is no claude-code-action to install", async () => {
    // Encoded in the type, not thrown from the bottom of a call stack. The route
    // renders "not supported" for GitLab instead of catching an exception.
    expect(new GitLabProvider("glpat_x").automationSetup({ provider: "gitlab", path: "g/p" })).toBeNull();
  });
});
