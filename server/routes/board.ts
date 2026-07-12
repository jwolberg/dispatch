import { Router } from "express";
import { listTickets } from "../db/tickets.js";
import { getRepo, type RepoRow } from "../db/repos.js";
import { getStatus } from "../db/status.js";
import { listDraftChats, getTranscript } from "../db/chats.js";
import type { StatusPayload } from "../poller/reconcile.js";

export const boardRouter = Router();

const COLUMNS = ["Spec", "Queued", "Building", "Ready to test", "Merged", "Deployed", "Blocked"];

function repoBrief(repo: RepoRow) {
  return { id: repo.id, path: repo.path, provider: repo.provider, host: repo.host };
}

function snippet(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

// GET /api/board — all cards with derived column read from status_cache (F4.1).
// The frontend only renders; it never derives (ARCH §7). Just-filed tickets with
// no cache yet default to Queued (issue open, no PR) until the next poll.
boardRouter.get("/", (_req, res) => {
  const cards: unknown[] = [];

  // Spec column: local draft chats not yet filed.
  for (const chat of listDraftChats()) {
    const repo = getRepo(chat.repo_id);
    if (!repo) continue;
    const firstUser = getTranscript(chat.id).find((m) => m.role === "user");
    cards.push({
      kind: "draft",
      id: chat.id,
      column: "Spec",
      repo: repoBrief(repo),
      title: firstUser ? snippet(firstUser.content) : "Untitled draft",
      created_at: chat.created_at,
    });
  }

  // Filed tickets, column from the poller's cached payload.
  for (const ticket of listTickets()) {
    const repo = getRepo(ticket.repo_id);
    if (!repo) continue;
    const row = getStatus(ticket.id);
    let payload: StatusPayload | null = null;
    if (row) {
      try {
        payload = JSON.parse(row.payload_json) as StatusPayload;
      } catch {
        payload = null;
      }
    }
    cards.push({
      kind: "ticket",
      id: ticket.id,
      issue_number: ticket.issue_number,
      column: payload?.column ?? "Queued",
      title: payload?.issue.title ?? `#${ticket.issue_number}`,
      repo: repoBrief(repo),
      pr: payload?.pr ? { number: payload.pr.number, url: payload.pr.url } : null,
      has_progress: Boolean(payload?.progressComment),
      updated_at: row?.updated_at ?? null,
    });
  }

  res.json({ columns: COLUMNS, cards });
});
