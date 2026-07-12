import { Router } from "express";
import { getRepo } from "../db/repos.js";
import { getTicket } from "../db/tickets.js";
import { getStatus } from "../db/status.js";
import { ticketSpend, type TicketSpend } from "../db/spend.js";
import { getProviderForRepo } from "../providers/index.js";
import type { ProviderId, RepoRef } from "../providers/index.js";
import { computeActionsCost, type ActionsCost } from "../providers/run-cost.js";
import type { RunTiming } from "../providers/types.js";
import type { StatusPayload } from "../poller/reconcile.js";
import { safeMessage } from "../lib/redaction.js";

// T2-4 (ticket #14) — GET /api/tickets/:id/cost.
//
// "What did this ticket cost to build?" — Claude tokens from the spend ledger
// plus GitHub Actions minutes from the runs linked to its PR. It is a DERIVED,
// disposable view: tokens come from the (non-disposable) spend table, minutes
// from the provider on demand. Wiping any cache and recomputing changes nothing.
//
// Lazy, like the summary/diff: fetched when a card is opened, not on every poll,
// and the run-timing calls go through the provider's conditional-request cache.
//
// Two honesty rules: a run whose timing we cannot fetch is `unknown` (counted,
// never $0), and a provider with no GitHub-Actions billing (GitLab) degrades to
// tokens-only rather than reporting a number in the wrong unit.

export interface CostResponse {
  tokens: TicketSpend;
  /** null when the provider has no GitHub-Actions billing (GitLab). */
  actions: ActionsCost | null;
  /** The runner class the Actions price assumes — surfaced so the UI can say so. */
  runnerAssumption: "standard-linux";
}

export const costRouter = Router();

function readPayload(ticketId: number): StatusPayload | null {
  const row = getStatus(ticketId);
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json) as StatusPayload;
  } catch {
    return null;
  }
}

costRouter.get("/:id/cost", async (req, res) => {
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

  const tokens = ticketSpend(ticket.id);

  // GitLab has no GitHub-Actions billing model, so it degrades to tokens-only
  // (AC) — no provider calls, no fabricated minutes.
  if (repo.provider !== "github") {
    res.json({ tokens, actions: null, runnerAssumption: "standard-linux" } satisfies CostResponse);
    return;
  }

  const ref: RepoRef = {
    provider: repo.provider as ProviderId,
    host: repo.host,
    path: repo.path,
    defaultBranch: repo.default_branch,
  };
  const runs = readPayload(ticket.id)?.runs ?? [];
  const provider = getProviderForRepo(ref);

  // One timing call per run linked to the PR. A lookup that throws is `unknown`
  // (null), never a fabricated zero — one un-priceable run must not fail the
  // whole cost, nor understate it.
  const timings: (RunTiming | null)[] = await Promise.all(
    runs.map(async (r) => {
      try {
        return await provider.getRunTiming(ref, r.id);
      } catch (err) {
        console.warn(`[cost] run ${r.id} timing failed: ${safeMessage(err)}`);
        return null;
      }
    })
  );

  const actions = computeActionsCost(timings);
  res.json({ tokens, actions, runnerAssumption: "standard-linux" } satisfies CostResponse);
});
