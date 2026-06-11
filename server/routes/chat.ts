import { Router } from "express";
import { getRepo, type RepoRow } from "../db/repos.js";
import { getChat, createChat, appendMessage, getTranscript } from "../db/chats.js";
import { buildSystemPrompt, type InjectableContext } from "../anthropic/prompts.js";
import { streamMessage } from "../anthropic/client.js";
import { safeMessage } from "../lib/redaction.js";

export const chatRouter = Router();

function toContext(repo: RepoRow): InjectableContext {
  let fileTree: string[] = [];
  try {
    fileTree = repo.file_tree_cache ? (JSON.parse(repo.file_tree_cache) as string[]) : [];
  } catch {
    fileTree = [];
  }
  return {
    path: repo.path,
    description: repo.description,
    claudeMd: repo.claude_md_cache,
    readmeExcerpt: repo.readme_excerpt_cache,
    fileTree,
  };
}

// POST /api/chat — stream one spec-chat turn over SSE (PRD F2.1, ARCH §9).
// The user message is persisted before streaming so it is never lost (S4).
chatRouter.post("/", async (req, res) => {
  const body = req.body ?? {};
  const message = body.message;
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "`message` is required" });
    return;
  }

  const repo = getRepo(Number(body.repo_id));
  if (!repo) {
    res.status(404).json({ error: "Repo not found" });
    return;
  }

  let chat = body.chat_id != null ? getChat(Number(body.chat_id)) : undefined;
  if (body.chat_id != null && !chat) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }
  if (!chat) chat = createChat(repo.id, new Date().toISOString());

  const transcript = appendMessage(chat.id, { role: "user", content: message });
  const system = buildSystemPrompt(toContext(repo));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  send({ type: "chat", chat_id: chat.id });

  try {
    let text = "";
    const stream = streamMessage(system, transcript);
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        text += event.delta.text;
        send({ type: "delta", text: event.delta.text });
      }
    }
    appendMessage(chat.id, { role: "assistant", content: text });
    send({ type: "done" });
  } catch (err) {
    // The user's message is already persisted; the client keeps its input box.
    send({ type: "error", message: safeMessage(err) });
  } finally {
    res.end();
  }
});

// GET /api/chat/:id — fetch a draft transcript (for resuming a chat / board link).
chatRouter.get("/:id", (req, res) => {
  const chat = getChat(Number(req.params.id));
  if (!chat) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }
  res.json({ id: chat.id, repo_id: chat.repo_id, status: chat.status, transcript: getTranscript(chat.id) });
});
