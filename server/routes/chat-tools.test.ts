import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { resetDb, withServer } from "../test/helpers.js";
import { insertRepo, updateRepoContext } from "../db/repos.js";
import { getTranscript } from "../db/chats.js";
import { chatRouter } from "./chat.js";
import { __setClientForTest } from "../anthropic/client.js";
import { setProviderFactory } from "../providers/index.js";
import { registerSecret, __resetRegisteredSecrets } from "../lib/redaction.js";
import type { GitProvider, RepoRef } from "../providers/types.js";

// #27 stage 3 — the spec chat, end to end: the model asks to read a file, the
// route's tool runner fetches it through the (stubbed) provider, and the model
// answers from the contents. The secret assertion is the point of the ticket: a
// value read from the repo must appear in NONE of the tool result, the streamed
// response, or the persisted chats row.

// A fake streaming SDK: each round yields its text deltas, then finalMessage().
function fakeStreamingClient(rounds: { deltas: string[]; final: unknown }[]) {
  let i = 0;
  return {
    messages: {
      stream: () => {
        const r = rounds[Math.min(i++, rounds.length - 1)];
        const iterable = (async function* () {
          for (const text of r.deltas) {
            yield { type: "content_block_delta", delta: { type: "text_delta", text } };
          }
        })();
        return Object.assign(iterable, { finalMessage: async () => r.final });
      },
    },
  } as never;
}

const usage = { input_tokens: 1, output_tokens: 1 };
const toolRound = (path: string) => ({
  deltas: ["Let me check that file. "],
  final: {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path } }],
    usage,
  },
});
const answerRound = (text: string) => ({
  deltas: [text],
  final: { stop_reason: "end_turn", content: [{ type: "text", text }], usage },
});

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/chat", chatRouter);
  return a;
}

function seedRepo(): number {
  const repo = insertRepo({ provider: "github", path: "acme/widgets", default_branch: "main" });
  updateRepoContext(repo.id, { file_tree_cache: JSON.stringify(["configs/"]) });
  return repo.id;
}

function stubProvider(readFile: (path: string) => string | null) {
  const calls: string[] = [];
  const provider = {
    async readFile(_r: RepoRef, path: string) {
      calls.push(path);
      return readFile(path);
    },
    async listFiles() {
      return [];
    },
  } as unknown as GitProvider;
  setProviderFactory(() => provider);
  return calls;
}

async function chat(base: string, repoId: number, message: string): Promise<string> {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo_id: repoId, message }),
  });
  return await res.text(); // the full SSE stream
}

beforeEach(() => resetDb());
afterEach(() => {
  __setClientForTest(null);
  setProviderFactory(null);
  __resetRegisteredSecrets();
});

describe("spec chat reads repo files (#27)", () => {
  it("fetches a file the model asks for and answers from its contents", async () => {
    __setClientForTest(fakeStreamingClient([toolRound("configs/config_maet.py"), answerRound("MAET threshold is 5.")]));
    const calls = stubProvider((p) => (p === "configs/config_maet.py" ? "THRESHOLD = 5" : null));
    const repoId = seedRepo();

    const { sse, transcript } = await withServer(app(), async (base) => {
      const sse = await chat(base, repoId, "How do MAET thresholds work?");
      return { sse, transcript: null as unknown };
    });

    expect(calls).toContain("configs/config_maet.py"); // the tool actually read it
    expect(sse).toContain("MAET threshold is 5."); // answered from contents
    expect(sse).toMatch(/"type":"tool"/); // emitted a progress event for the read
    expect(sse).toContain("config_maet.py");
  });

  it("never lets a secret from a file reach the stream or the persisted transcript", async () => {
    const secret = "sk-live-SUPERSECRET-01234567";
    registerSecret(secret); // a token that happens to sit in a readable config file
    __setClientForTest(
      fakeStreamingClient([toolRound("configs/app.ts"), answerRound("The config wires up the app.")])
    );
    stubProvider((p) => (p === "configs/app.ts" ? `const KEY = "${secret}";` : null));
    const repoId = seedRepo();

    const sse = await withServer(app(), async (base) => chat(base, repoId, "What does app.ts do?"));

    // The secret must appear in NONE of: the streamed response, or the chats row.
    expect(sse).not.toContain(secret);
    const persisted = JSON.stringify(getTranscript(1));
    expect(persisted).not.toContain(secret);
  });

  it("refuses a denylisted file without ever calling the provider for it", async () => {
    __setClientForTest(fakeStreamingClient([toolRound(".env"), answerRound("I can't read that.")]));
    const calls = stubProvider(() => "API_KEY=leak");
    const repoId = seedRepo();

    const sse = await withServer(app(), async (base) => chat(base, repoId, "read the env"));

    expect(calls).not.toContain(".env"); // denylist refused before the provider
    expect(sse).not.toContain("leak");
  });
});
