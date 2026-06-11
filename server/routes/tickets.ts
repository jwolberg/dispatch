import { Router } from "express";
import { getRepo } from "../db/repos.js";
import { createTicket, getTicket } from "../db/tickets.js";
import { setChatStatus } from "../db/chats.js";
import { insertActivity } from "../db/activity.js";
import { getStatus } from "../db/status.js";
import { safeReconcile, type StatusPayload } from "../poller/reconcile.js";
import { getProvider } from "../providers/index.js";
import type { CommentTarget, MergeMethod, ProviderId, RepoRef } from "../providers/index.js";
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

// GET /api/tickets/:id — card detail: issue, progress comment, PR + checks,
// runs, timestamps (F4.3). Reads from status_cache; reconciles on demand if the
// ticket hasn't been polled yet (e.g. just filed) so the card isn't empty.
ticketsRouter.get("/:id", async (req, res) => {
  const ticket = getTicket(Number(req.params.id));
  if (!ticket) {
    res.status(404).json({ error: "Ticket not found" });
    return;
  }
  const repo = getRepo(ticket.repo_id);
  if (!repo) {
    res.status(404).json({ error: "Repo not found" });
    return;
  }

  let row = getStatus(ticket.id);
  if (!row) {
    await safeReconcile(ticket);
    row = getStatus(ticket.id);
  }
  let status: StatusPayload | null = null;
  if (row) {
    try {
      status = JSON.parse(row.payload_json) as StatusPayload;
    } catch {
      status = null;
    }
  }

  res.json({
    ticket: {
      id: ticket.id,
      issue_number: ticket.issue_number,
      chat_id: ticket.chat_id,
      created_at: ticket.created_at,
    },
    repo: {
      id: repo.id,
      path: repo.path,
      provider: repo.provider,
      host: repo.host,
      preview_url_pattern: repo.preview_url_pattern,
      merge_method: repo.merge_method,
      default_branch: repo.default_branch,
      web_url: repo.web_url,
    },
    status,
    updated_at: row?.updated_at ?? null,
  });
});

// POST /api/tickets/:id/comment — Steer: comment on the issue or PR (F4.5). A
// comment containing @claude re-triggers the provider's build job.
ticketsRouter.post("/:id/comment", async (req, res) => {
  const ticket = getTicket(Number(req.params.id));
  if (!ticket) {
    res.status(404).json({ error: "Ticket not found" });
    return;
  }
  const repo = getRepo(ticket.repo_id);
  if (!repo) {
    res.status(404).json({ error: "Repo not found" });
    return;
  }
  const body = req.body ?? {};
  if (typeof body.body !== "string" || !body.body.trim()) {
    res.status(400).json({ error: "`body` is required" });
    return;
  }

  const kind: "issue" | "pr" = body.target === "pr" ? "pr" : "issue";
  let number = ticket.issue_number;
  if (kind === "pr") {
    const row = getStatus(ticket.id);
    let pr: { number: number } | null = null;
    if (row) {
      try {
        pr = (JSON.parse(row.payload_json) as StatusPayload).pr;
      } catch {
        pr = null;
      }
    }
    if (!pr) {
      res.status(400).json({ error: "No linked PR to comment on" });
      return;
    }
    number = pr.number;
  }

  const ref: RepoRef = {
    provider: repo.provider as ProviderId,
    host: repo.host,
    path: repo.path,
    defaultBranch: repo.default_branch,
  };
  const target: CommentTarget = { repo: ref, kind, number };

  try {
    await getProvider(repo.provider as ProviderId, repo.host).postComment(target, body.body);
    insertActivity({
      ticket_id: ticket.id,
      type: "steer",
      summary: `Steered ${kind} #${number}`,
      url: null,
      occurred_at: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(httpStatus(err) ?? 502).json({ error: safeMessage(err) });
  }
});

// POST /api/tickets/:id/merge — Ship (F6). Enabled only when the PR is open,
// mergeable, and all checks are green; merges via the adapter, then reconciles.
ticketsRouter.post("/:id/merge", async (req, res) => {
  const ticket = getTicket(Number(req.params.id));
  if (!ticket) {
    res.status(404).json({ error: "Ticket not found" });
    return;
  }
  const repo = getRepo(ticket.repo_id);
  if (!repo) {
    res.status(404).json({ error: "Repo not found" });
    return;
  }

  const row = getStatus(ticket.id);
  let payload: StatusPayload | null = null;
  if (row) {
    try {
      payload = JSON.parse(row.payload_json) as StatusPayload;
    } catch {
      payload = null;
    }
  }
  const pr = payload?.pr ?? null;

  // Server-side re-validation of the ship gate (F6.1).
  if (!pr || pr.state !== "open") {
    res.status(409).json({ error: "No open PR to merge" });
    return;
  }
  if (pr.mergeable === false) {
    res.status(409).json({ error: "PR is not mergeable (conflicts or branch protection)" });
    return;
  }
  if (pr.checks.some((c) => c.state === "failure" || c.state === "pending")) {
    res.status(409).json({ error: "Not all checks are green" });
    return;
  }

  const method = (
    ["squash", "merge", "rebase"].includes(req.body?.method) ? req.body.method : repo.merge_method
  ) as MergeMethod;
  const ref: RepoRef = {
    provider: repo.provider as ProviderId,
    host: repo.host,
    path: repo.path,
    defaultBranch: repo.default_branch,
  };

  try {
    const result = await getProvider(repo.provider as ProviderId, repo.host).mergePR(
      ref,
      pr.number,
      method
    );
    if (!result.merged) {
      res.status(409).json({ error: result.message ?? "Merge failed", pr_url: pr.url });
      return;
    }
    insertActivity({
      ticket_id: ticket.id,
      type: "merged",
      summary: `Merged PR #${pr.number}`,
      url: pr.url,
      occurred_at: new Date().toISOString(),
    });
    await safeReconcile(ticket); // flip to Shipped without waiting for the next poll
    res.json({ merged: true, sha: result.sha });
  } catch (err) {
    // Surface the provider error verbatim with a PR link (F6.4).
    res.status(httpStatus(err) ?? 502).json({ error: safeMessage(err), pr_url: pr.url });
  }
});
