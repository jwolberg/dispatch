import { Router } from "express";
import { getRepo, type RepoRow } from "../db/repos.js";
import { getChat, createChat, appendMessage, getTranscript } from "../db/chats.js";
import {
  buildSystemPrompt,
  GENERATE_TICKET_INSTRUCTION,
  GENERATE_TICKET_RETRY,
  type InjectableContext,
} from "../anthropic/prompts.js";
import { streamMessage, createMessage } from "../anthropic/client.js";
import { safeMessage } from "../lib/redaction.js";
import { tryParseTicket } from "../lib/ticket-json.js";

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

  let text = "";
  let emitted = false;
  const runStream = async () => {
    const stream = streamMessage(system, transcript);
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        text += event.delta.text;
        emitted = true;
        send({ type: "delta", text: event.delta.text });
      }
    }
  };

  try {
    try {
      await runStream();
    } catch (err) {
      // S4: retry once with backoff, but only if nothing was streamed yet (so we
      // never duplicate partial output). The user's message is already persisted.
      if (emitted) throw err;
      await new Promise((r) => setTimeout(r, 800));
      text = "";
      await runStream();
    }
    appendMessage(chat.id, { role: "assistant", content: text });
    send({ type: "done" });
  } catch (err) {
    send({ type: "error", message: safeMessage(err) });
  } finally {
    res.end();
  }
});

// POST /api/chat/:id/generate-ticket — transcript → strict ticket JSON (F2.3).
// Strips fences, validates; on parse failure retries once with a correction
// prompt (acceptance #3: 10 generations, 0 unhandled parse failures).
chatRouter.post("/:id/generate-ticket", async (req, res) => {
  const chat = getChat(Number(req.params.id));
  if (!chat) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }
  const repo = getRepo(chat.repo_id);
  if (!repo) {
    res.status(404).json({ error: "Repo not found" });
    return;
  }

  const system = buildSystemPrompt(toContext(repo));
  const base = getTranscript(chat.id);
  const messages = [...base, { role: "user" as const, content: GENERATE_TICKET_INSTRUCTION }];

  try {
    let text = await createMessage(system, messages);
    let ticket = tryParseTicket(text);
    if (!ticket) {
      const retry = [
        ...messages,
        { role: "assistant" as const, content: text },
        { role: "user" as const, content: GENERATE_TICKET_RETRY },
      ];
      text = await createMessage(system, retry);
      ticket = tryParseTicket(text);
    }
    if (!ticket) {
      res.status(502).json({ error: "Model did not return parseable ticket JSON" });
      return;
    }
    res.json({ ticket });
  } catch (err) {
    res.status(502).json({ error: safeMessage(err) });
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
