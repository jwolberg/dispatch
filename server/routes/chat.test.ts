import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import { resetDb, withServer } from "../test/helpers.js";
import { insertRepo } from "../db/repos.js";
import { createChat, getChat, setChatStatus } from "../db/chats.js";

// T0-4 (retry contract) — PRD F2.3 / acceptance #3: on a parse failure the route
// retries ONCE with a correction prompt; a second failure must surface a clean
// 502, never a crash and never a half-written ticket.

const createMessage = vi.hoisted(() => vi.fn());
vi.mock("../anthropic/client.js", () => ({
  createMessage,
  MODEL: "test-model",
}));

const { chatRouter } = await import("./chat.js");

interface TicketResponse {
  ticket?: { title: string; body_markdown: string; labels: string[] };
  error?: string;
}

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/chat", chatRouter);
  return a;
}

const VALID = JSON.stringify({ title: "T", body_markdown: "B", labels: ["bug"] });

function seedChat(): number {
  const repo = insertRepo({ provider: "github", path: "acme/widgets" });
  return createChat(repo.id, new Date().toISOString()).id;
}

describe("POST /api/chat/:id/generate-ticket", () => {
  beforeEach(() => {
    resetDb();
    createMessage.mockReset();
  });

  it("returns the ticket on a first-try parse, without retrying", async () => {
    createMessage.mockResolvedValueOnce(VALID);
    const chatId = seedChat();

    const body = await withServer(app(), async (base) => {
      const res = await fetch(`${base}/api/chat/${chatId}/generate-ticket`, { method: "POST" });
      expect(res.status).toBe(200);
      return (await res.json()) as TicketResponse;
    });

    expect(body.ticket).toEqual({ title: "T", body_markdown: "B", labels: ["bug"] });
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it("retries once with a correction prompt when the first response is unparseable", async () => {
    createMessage.mockResolvedValueOnce("I'm not sure what you want.").mockResolvedValueOnce(VALID);
    const chatId = seedChat();

    const body = await withServer(app(), async (base) => {
      const res = await fetch(`${base}/api/chat/${chatId}/generate-ticket`, { method: "POST" });
      expect(res.status).toBe(200);
      return (await res.json()) as TicketResponse;
    });

    expect(body.ticket!.title).toBe("T");
    expect(createMessage).toHaveBeenCalledTimes(2);

    // The retry must carry the bad response back as an assistant turn plus a
    // correction instruction — otherwise the model has no idea what went wrong.
    const retryMessages = createMessage.mock.calls[1][1] as { role: string; content: string }[];
    expect(retryMessages.at(-2)).toMatchObject({
      role: "assistant",
      content: "I'm not sure what you want.",
    });
    expect(retryMessages.at(-1)?.role).toBe("user");
  });

  it("returns 502 — not a crash — when both attempts are unparseable", async () => {
    createMessage.mockResolvedValue("still prose, still not json");
    const chatId = seedChat();

    const body = await withServer(app(), async (base) => {
      const res = await fetch(`${base}/api/chat/${chatId}/generate-ticket`, { method: "POST" });
      expect(res.status).toBe(502);
      return (await res.json()) as TicketResponse;
    });

    expect(body.error).toMatch(/parseable ticket JSON/i);
    expect(createMessage).toHaveBeenCalledTimes(2);
  });

  it("returns 502 when the model call itself throws", async () => {
    createMessage.mockRejectedValue(new Error("anthropic overloaded"));
    const chatId = seedChat();

    await withServer(app(), async (base) => {
      const res = await fetch(`${base}/api/chat/${chatId}/generate-ticket`, { method: "POST" });
      expect(res.status).toBe(502);
    });
  });

  it("404s for an unknown chat without calling the model", async () => {
    resetDb();
    await withServer(app(), async (base) => {
      const res = await fetch(`${base}/api/chat/9999/generate-ticket`, { method: "POST" });
      expect(res.status).toBe(404);
    });
    expect(createMessage).not.toHaveBeenCalled();
  });
});

// Board "×" delete button — draft chats a user abandons must not be stuck as
// ghost cards forever, but a filed chat is the record of what shipped and must
// not be deletable (#63).
describe("DELETE /api/chat/:id", () => {
  beforeEach(() => resetDb());

  it("204s and hard-deletes a draft chat", async () => {
    const chatId = seedChat();

    await withServer(app(), async (base) => {
      const res = await fetch(`${base}/api/chat/${chatId}`, { method: "DELETE" });
      expect(res.status).toBe(204);
    });

    expect(getChat(chatId)).toBeUndefined();
  });

  it("404s for an unknown chat", async () => {
    await withServer(app(), async (base) => {
      const res = await fetch(`${base}/api/chat/9999`, { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  it("409s and keeps the row when the chat is already filed", async () => {
    const chatId = seedChat();
    setChatStatus(chatId, "filed");

    await withServer(app(), async (base) => {
      const res = await fetch(`${base}/api/chat/${chatId}`, { method: "DELETE" });
      expect(res.status).toBe(409);
    });

    expect(getChat(chatId)).toBeDefined();
  });
});
