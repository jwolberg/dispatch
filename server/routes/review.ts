import { Router } from "express";
import { getRepo } from "../db/repos.js";
import { getTicket } from "../db/tickets.js";
import { getStatus } from "../db/status.js";
import { getProviderForRepo } from "../providers/index.js";
import type { ProviderId, RepoRef } from "../providers/index.js";
import { fetchReview } from "../review/fetch.js";
import { evaluateShipGate, type ReviewArtifact, type ShipGate } from "../review/artifact.js";
import type { StatusPayload } from "../poller/reconcile.js";
import { safeMessage } from "../lib/redaction.js";

// T2-5 (ticket #15) — GET /api/tickets/:id/review.
//
// Renders the PR's code-review artifact on the card and reports the ship gate.
// The gate here is for DISPLAY (disable the button, show why); the merge route
// re-validates it server-side, because a client that hides the button is not a
// gate (AC). Fail-closed: any failure to read the artifact is a blocked gate,
// never a silent allow.

export interface ReviewResponse {
  review: ReviewArtifact | null;
  gate: ShipGate;
  /** Why there is nothing to review yet. */
  unavailable: "no-pr" | null;
}

export const reviewRouter = Router();

function readPayload(ticketId: number): StatusPayload | null {
  const row = getStatus(ticketId);
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json) as StatusPayload;
  } catch {
    return null;
  }
}

reviewRouter.get("/:id/review", async (req, res) => {
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
  if (!pr || !pr.headSha) {
    res.json({
      review: null,
      gate: evaluateShipGate(null),
      unavailable: "no-pr",
    } satisfies ReviewResponse);
    return;
  }

  const ref: RepoRef = {
    provider: repo.provider as ProviderId,
    host: repo.host,
    path: repo.path,
    defaultBranch: repo.default_branch,
  };

  let review: ReviewArtifact | null = null;
  try {
    review = await fetchReview(getProviderForRepo(ref), ref, pr.number, pr.headSha);
  } catch (err) {
    // A failure to read the artifact must not read as "approved". It is logged
    // and the gate stays closed (review = null).
    console.warn(`[review] ticket ${ticket.id} fetch failed: ${safeMessage(err)}`);
  }

  res.json({ review, gate: evaluateShipGate(review), unavailable: null } satisfies ReviewResponse);
});
