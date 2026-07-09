import { Router } from "express";
import { getRepo } from "../db/repos.js";
import { getTicket } from "../db/tickets.js";
import { getStatus } from "../db/status.js";
import { getSummary, putSummary } from "../db/summary-cache.js";
import { assertWithinBudget, BudgetExceededError } from "../anthropic/budget.js";
import { summarizeChange, type ChangeSummary } from "../anthropic/summary.js";
import { getProviderForRepo } from "../providers/index.js";
import type { ProviderId, RepoRef } from "../providers/index.js";
import type { StatusPayload } from "../poller/reconcile.js";
import { safeMessage } from "../lib/redaction.js";

// T1-5 — GET /api/tickets/:id/summary.
//
// Lazy on purpose (approved 2026-07-09): the poller runs every 5 minutes across
// every tracked ticket, so summarizing there would bill for cards nobody opens,
// and #10's daily cap takes that money straight out of the user's chat budget.
// Lazy costs a spinner on first view.
//
// This route never 500s and never returns a partial card. Every way it can fail
// — no PR yet, budget exhausted, Anthropic down, a response we cannot parse —
// resolves to `summary: null` with a reason the card can render as a quiet line.

/** Why there is no summary. Never a raw error message: this reaches the browser. */
export type Unavailable = "no-pr" | "budget" | "error";

interface SummaryResponse {
  summary: ChangeSummary | null;
  unavailable: Unavailable | null;
}

export const summaryRouter = Router();

/**
 * In-flight summarize calls, keyed by `${ticketId}:${headSha}`.
 *
 * The card polls every 10s and React strict mode double-mounts, so without this
 * the first open of a card fires two Anthropic calls before either finishes and
 * writes the cache. Coalescing is what makes "exactly one call per (ticket, head
 * SHA)" true rather than merely intended.
 */
const inflight = new Map<string, Promise<ChangeSummary>>();

function coalesce(key: string, work: () => Promise<ChangeSummary>): Promise<ChangeSummary> {
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = work().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

function readPayload(ticketId: number): StatusPayload | null {
  const row = getStatus(ticketId);
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json) as StatusPayload;
  } catch {
    return null;
  }
}

summaryRouter.get("/:id/summary", async (req, res) => {
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

  const pr = readPayload(ticket.id)?.pr ?? null;
  // No PR, or a provider that gave us no head SHA: there is nothing to summarize
  // and nothing to key a cache by. Both are "not yet", not "broken".
  if (!pr || !pr.headSha) {
    res.json({ summary: null, unavailable: "no-pr" } satisfies SummaryResponse);
    return;
  }

  const cached = getSummary(ticket.id, pr.headSha);
  if (cached) {
    res.json({ summary: cached, unavailable: null } satisfies SummaryResponse);
    return;
  }

  const ref: RepoRef = {
    provider: repo.provider as ProviderId,
    host: repo.host,
    path: repo.path,
    defaultBranch: repo.default_branch,
  };

  try {
    // Checked before the diff fetch, not just inside createMessage: being over
    // budget should not also cost a provider request to discover.
    assertWithinBudget(new Date());

    const summary = await coalesce(`${ticket.id}:${pr.headSha}`, async () => {
      const diff = await getProviderForRepo(ref).getPRDiff(ref, pr.number);
      const generated = await summarizeChange(pr.title, diff, ticket.id);
      putSummary(ticket.id, pr.headSha, generated, new Date().toISOString());
      return generated;
    });

    res.json({ summary, unavailable: null } satisfies SummaryResponse);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      res.json({ summary: null, unavailable: "budget" } satisfies SummaryResponse);
      return;
    }
    // A summary is a nicety. Losing it must never cost the user their card, so
    // the failure is logged for us and rendered as one quiet line for them.
    console.warn(`[summary] ticket ${ticket.id} failed: ${safeMessage(err)}`);
    res.json({ summary: null, unavailable: "error" } satisfies SummaryResponse);
  }
});
