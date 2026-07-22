import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { resetDb, withServer } from "../test/helpers.js";
import { insertRepo } from "../db/repos.js";
import { createTicket } from "../db/tickets.js";
import { createChat, appendMessage } from "../db/chats.js";
import { setProviderFactory } from "../providers/index.js";
import type { GitProvider, Issue, IssueComment } from "../providers/types.js";
import { TRANSCRIPT_MARKER, buildTranscriptComment } from "../lib/handoff.js";
import { ticketsRouter } from "./tickets.js";

// #38 — POST /api/tickets/:id/handoff. This route writes to a user's issue, so
// the load-bearing behavior is that it writes exactly once no matter how many
// times the button is pressed.

const postComment = vi.fn();
let issueComments: IssueComment[] = [];

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/tickets", ticketsRouter);
  return a;
}

function fakeProvider(): GitProvider {
  return {
    getIssue: async (): Promise<Issue> => ({
      number: 42,
      title: "The board is slow",
      body: "It hangs on load.",
      state: "open",
      labels: [],
      comments: issueComments,
      url: "https://example.test/i/42",
    }),
    postComment,
    getRateLimit: async () => ({ limit: null, remaining: null, reset: null }),
    discoverRepos: async () => [],
    listOpenIssues: async () => [],
  } as unknown as GitProvider;
}

/** A ticket with an optional spec chat behind it. */
function seed(withChat: boolean): number {
  const repo = insertRepo({ provider: "github", path: "jwolberg/situation" });
  let chatId: number | null = null;
  if (withChat) {
    const chat = createChat(repo.id, new Date().toISOString());
    appendMessage(chat.id, { role: "user", content: "the board is slow" });
    appendMessage(chat.id, { role: "assistant", content: "which view?" });
    chatId = chat.id;
  }
  return createTicket(repo.id, 42, chatId, new Date().toISOString()).id;
}

async function handoff(ticketId: number) {
  return withServer(app(), async (base) => {
    const res = await fetch(`${base}/api/tickets/${ticketId}/handoff`, { method: "POST" });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  });
}

describe("POST /api/tickets/:id/handoff", () => {
  beforeEach(() => {
    resetDb();
    postComment.mockReset();
    postComment.mockResolvedValue(undefined);
    issueComments = [];
    setProviderFactory(() => fakeProvider());
  });

  afterEach(() => setProviderFactory(null));

  it("404s for an unknown ticket without writing anything", async () => {
    const { status } = await handoff(9999);
    expect(status).toBe(404);
    expect(postComment).not.toHaveBeenCalled();
  });

  it("returns a pickup command naming the repo and issue", async () => {
    const { status, body } = await handoff(seed(true));
    expect(status).toBe(200);
    expect(body.pickup).toBe("dispatch-pickup jwolberg/situation#42");
  });

  it("posts the transcript once, marked", async () => {
    const { body } = await handoff(seed(true));
    expect(body.transcript).toBe("posted");
    expect(postComment).toHaveBeenCalledTimes(1);
    const posted = postComment.mock.calls[0][1] as string;
    expect(posted).toContain(TRANSCRIPT_MARKER);
    expect(posted).toContain("the board is slow");
    expect(posted).toContain("which view?");
  });

  it("does not post twice when the marker is already on the issue", async () => {
    const id = seed(true);
    issueComments = [
      {
        id: "c1",
        author: "dispatch",
        body: buildTranscriptComment([{ role: "user", content: "the board is slow" }])!,
        createdAt: "2026-07-22T00:00:00Z",
        url: null,
      },
    ];
    const { status, body } = await handoff(id);
    expect(status).toBe(200);
    expect(body.transcript).toBe("already-present");
    expect(postComment).not.toHaveBeenCalled();
    // The command must still come back — a repeat press is a legitimate way to
    // re-copy it after the clipboard is lost.
    expect(body.pickup).toBe("dispatch-pickup jwolberg/situation#42");
  });

  it("hands off a ticket with no chat, reporting nothing to carry", async () => {
    const { status, body } = await handoff(seed(false));
    expect(status).toBe(200);
    expect(body.transcript).toBe("none");
    expect(postComment).not.toHaveBeenCalled();
    expect(body.pickup).toBe("dispatch-pickup jwolberg/situation#42");
  });

  it("surfaces a provider failure instead of claiming the transcript landed", async () => {
    postComment.mockRejectedValue(new Error("upstream is down"));
    const { status, body } = await handoff(seed(true));
    expect(status).toBeGreaterThanOrEqual(500);
    expect(String(body.error)).toMatch(/upstream is down/i);
  });
});
