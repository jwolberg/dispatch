import { Router } from "express";
import { getRepo } from "../db/repos.js";
import { getTicket } from "../db/tickets.js";
import { getStatus } from "../db/status.js";
import { getProviderForRepo } from "../providers/index.js";
import type { ProviderId, RepoRef } from "../providers/index.js";
import { boundDiff, type BoundedDiff } from "../anthropic/bound-diff.js";
import type { StatusPayload } from "../poller/reconcile.js";
import { safeMessage } from "../lib/redaction.js";

// T2-1 (ticket #11) — GET /api/tickets/:id/diff.
//
// The view that keeps a professional from bouncing to github.com to read the
// change. It serves the unified diff #6's getPRDiff() already fetches — which
// goes through the provider seam's conditional-request cache, so re-reading an
// unchanged PR costs no fresh diff download (AC #5). This route adds no new
// Octokit/gitbeaker import; it only calls the seam.
//
// Like the summary route, it never 500s and never returns a partial card. No PR,
// no head SHA, or a provider that fails all resolve to `diff: null` with a reason
// the card can render as one quiet line — deep review still links out.

/**
 * Bytes of patch text we serve to the browser. Far larger than the summarizer's
 * 24 KB Anthropic budget (DEFAULT_PATCH_BUDGET_BYTES): a human wants the whole
 * real PR, not a token-frugal excerpt. 256 KB renders essentially any
 * hand-reviewed diff whole while still bounding the payload; a pathological
 * generated diff is clipped and the truncation is shown, never dropped silently.
 */
export const DIFF_VIEW_PATCH_BUDGET_BYTES = 256_000;

/** Why there is no diff. Never a raw error message: this reaches the browser. */
export type DiffUnavailable = "no-pr" | "error";

export interface DiffResponse {
  diff: BoundedDiff | null;
  unavailable: DiffUnavailable | null;
}

export const diffRouter = Router();

function readPayload(ticketId: number): StatusPayload | null {
  const row = getStatus(ticketId);
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json) as StatusPayload;
  } catch {
    return null;
  }
}

diffRouter.get("/:id/diff", async (req, res) => {
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
  // No PR, or a provider that gave us no head SHA: there is nothing to render.
  // "Not yet", not "broken".
  if (!pr || !pr.headSha) {
    res.json({ diff: null, unavailable: "no-pr" } satisfies DiffResponse);
    return;
  }

  const ref: RepoRef = {
    provider: repo.provider as ProviderId,
    host: repo.host,
    path: repo.path,
    defaultBranch: repo.default_branch,
  };

  try {
    const raw = await getProviderForRepo(ref).getPRDiff(ref, pr.number);
    const diff = boundDiff(raw, DIFF_VIEW_PATCH_BUDGET_BYTES);
    res.json({ diff, unavailable: null } satisfies DiffResponse);
  } catch (err) {
    // The diff is the point of this route, but losing it must never cost the
    // user their card. Logged for us, one quiet line for them.
    console.warn(`[diff] ticket ${ticket.id} failed: ${safeMessage(err)}`);
    res.json({ diff: null, unavailable: "error" } satisfies DiffResponse);
  }
});
