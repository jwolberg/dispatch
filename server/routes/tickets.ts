import { Router } from "express";
import { getRepo } from "../db/repos.js";
import { createTicket } from "../db/tickets.js";
import { setChatStatus } from "../db/chats.js";
import { insertActivity } from "../db/activity.js";
import { getProvider } from "../providers/index.js";
import type { ProviderId, RepoRef } from "../providers/index.js";
import { safeMessage } from "../lib/redaction.js";
import { httpStatus } from "../lib/errors.js";

export const ticketsRouter = Router();

// POST /api/tickets — file the issue via the repo's provider adapter (F3).
ticketsRouter.post("/", async (req, res) => {
  const body = req.body ?? {};
  const repo = getRepo(Number(body.repo_id));
  if (!repo) {
    res.status(404).json({ error: "Repo not found" });
    return;
  }
  if (typeof body.title !== "string" || typeof body.body_markdown !== "string") {
    res.status(400).json({ error: "`title` and `body_markdown` are required" });
    return;
  }

  const ref: RepoRef = {
    provider: repo.provider as ProviderId,
    host: repo.host,
    path: repo.path,
    defaultBranch: repo.default_branch,
  };

  try {
    const issue = await getProvider(repo.provider as ProviderId, repo.host).createIssue(ref, {
      title: body.title,
      body_markdown: body.body_markdown,
      labels: Array.isArray(body.labels) ? body.labels : [],
    });

    const now = new Date().toISOString();
    const chatId = body.chat_id != null ? Number(body.chat_id) : null;
    const ticket = createTicket(repo.id, issue.number, chatId, now);
    if (chatId != null) setChatStatus(chatId, "filed");
    insertActivity({
      ticket_id: ticket.id,
      type: "issue_created",
      summary: `Filed #${issue.number}: ${body.title}`,
      url: issue.url,
      occurred_at: now,
    });

    res.status(201).json({ ticket: { id: ticket.id, issue_number: issue.number, url: issue.url } });
  } catch (err) {
    res.status(httpStatus(err) ?? 502).json({ error: safeMessage(err) });
  }
});
