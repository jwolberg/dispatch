import { afterEach, describe, expect, it } from "vitest";
import { makeToolRunner, SPEC_CHAT_TOOLS, MAX_FILE_READS } from "./tools.js";
import { registerSecret, __resetRegisteredSecrets } from "../lib/redaction.js";
import type { GitProvider, RepoRef } from "../providers/types.js";

// #27 — the tool executor is the security choke point. It is written and tested
// BEFORE the client loop or route exist, because a chat transcript persists to
// `chats`, which triggers a GCS snapshot upload — so one bad read_file writes a
// credential into a durable, versioned bucket. The guards here are the floor.

const REPO: RepoRef = { provider: "github", path: "o/r", defaultBranch: "main" };

/** A provider whose readFile returns whatever it's told; records the calls. */
function fakeProvider(files: Record<string, string> = {}): { provider: GitProvider; reads: string[] } {
  const reads: string[] = [];
  const provider = {
    async readFile(_repo: RepoRef, path: string) {
      reads.push(path);
      return files[path] ?? null;
    },
    async listFiles(_repo: RepoRef, _path: string) {
      return ["a.ts", "b.ts"];
    },
  } as unknown as GitProvider;
  return { provider, reads };
}

afterEach(() => __resetRegisteredSecrets());

describe("read_file guardrails (#27)", () => {
  it("refuses a denylisted path and NEVER returns its contents", async () => {
    const secret = "sk-live-abcdef123456";
    const { provider, reads } = fakeProvider({ ".env": `API_KEY=${secret}` });
    const { runTool } = makeToolRunner(provider, REPO);

    for (const path of [".env", ".env.local", "deploy.pem", "id_rsa", "credentials.json", "app.key"]) {
      const out = await runTool("read_file", { path });
      expect(out.toLowerCase()).toMatch(/refus|not allowed|denied|cannot/);
      expect(out).not.toContain(secret);
    }
    // The provider is never even asked for a denylisted file.
    expect(reads).toEqual([]);
  });

  it("rejects absolute paths and any '..' segment without calling the provider", async () => {
    const { provider, reads } = fakeProvider({ "src/x.ts": "ok" });
    const { runTool } = makeToolRunner(provider, REPO);

    for (const path of ["/etc/passwd", "../secrets.txt", "src/../../x", "a/../../b"]) {
      const out = await runTool("read_file", { path });
      expect(out.toLowerCase()).toMatch(/refus|invalid|not allowed|outside/);
    }
    expect(reads).toEqual([]);
  });

  it("redacts a registered secret from the tool result", async () => {
    const secret = "ghp_registeredTokenValue1234";
    registerSecret(secret);
    const { provider } = fakeProvider({ "config.ts": `const token = "${secret}";` });
    const { runTool } = makeToolRunner(provider, REPO);

    const out = await runTool("read_file", { path: "config.ts" });
    expect(out).not.toContain(secret);
    expect(out).toContain("«redacted»");
  });

  it("truncates a file over the size cap with an explicit marker", async () => {
    const big = "x".repeat(200_000);
    const { provider } = fakeProvider({ "big.txt": big });
    const { runTool } = makeToolRunner(provider, REPO);

    const out = await runTool("read_file", { path: "big.txt" });
    expect(out.length).toBeLessThan(big.length);
    expect(out.toLowerCase()).toMatch(/truncat/);
  });

  it("caps total reads per turn and refuses further reads with a model-visible message", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_FILE_READS + 5; i++) files[`f${i}.ts`] = `file ${i}`;
    const { provider } = fakeProvider(files);
    const { runTool } = makeToolRunner(provider, REPO);

    const results: string[] = [];
    for (let i = 0; i < MAX_FILE_READS + 3; i++) {
      results.push(await runTool("read_file", { path: `f${i}.ts` }));
    }
    // The first MAX_FILE_READS succeed; the rest are refused, not served.
    const refused = results.filter((r) => /read limit|too many|cap/i.test(r));
    expect(refused.length).toBeGreaterThanOrEqual(3);
  });

  it("returns a not-found message rather than throwing when the file is absent", async () => {
    const { provider } = fakeProvider({});
    const { runTool } = makeToolRunner(provider, REPO);
    const out = await runTool("read_file", { path: "nope.ts" });
    expect(out.toLowerCase()).toMatch(/not found|does not exist|no such/);
  });
});

describe("list_files + tool schemas (#27)", () => {
  it("list_files returns directory entries through the provider", async () => {
    const { provider } = fakeProvider();
    const { runTool } = makeToolRunner(provider, REPO);
    const out = await runTool("list_files", { path: "src" });
    expect(out).toContain("a.ts");
    expect(out).toContain("b.ts");
  });

  it("exposes read_file and list_files as Anthropic tool schemas", () => {
    const names = SPEC_CHAT_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(["list_files", "read_file"]);
  });
});
