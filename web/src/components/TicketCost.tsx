import { useEffect, useState } from "react";
import { ticketsApi, type CostResponse } from "../api/tickets.js";
import { usd, compactTokens } from "../lib/formatCost.js";

// T2-4 (ticket #14) — "what did this ticket cost to build?"
//
// Claude tokens (from the spend ledger) + GitHub Actions minutes (from provider
// run timing). Fetched once per card open, not polled — the run-timing calls are
// conditional-cached, so a re-open costs 304s. GitLab repos show tokens only.
//
// Honesty carries through from the server: a run we could not price is shown as
// "+N runs unpriced", never folded in as $0. The Actions figure assumes the
// standard Linux runner and says so, rather than under-reporting a big runner.

export function TicketCost({ ticketId, headSha }: { ticketId: number; headSha: string | null }) {
  const [cost, setCost] = useState<CostResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    ticketsApi
      .cost(ticketId)
      .then((res) => active && setCost(res))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
    // headSha is in the deps so the cost refreshes when a new commit lands.
  }, [ticketId, headSha]);

  if (failed || !cost) return null; // a cost is a nicety; never block the card on it

  const { tokens, actions } = cost;
  const total = tokens.usd + (actions?.usd ?? 0);
  const tokenCount = tokens.inputTokens + tokens.outputTokens;

  return (
    <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-label text-gray-400">
      <span className="font-semibold text-gray-300">Cost {usd(total)}</span>
      <span title={`${tokens.calls} Claude call${tokens.calls === 1 ? "" : "s"}`}>
        {usd(tokens.usd)} tokens ({compactTokens(tokenCount)})
      </span>
      {actions ? (
        <span title="Assumes the standard Linux runner">
          {usd(actions.usd)} Actions ({actions.minutes.toFixed(1)} min)
          {actions.unknownRuns > 0 && (
            <span className="text-status-wait">
              {" "}
              · +{actions.unknownRuns} run{actions.unknownRuns === 1 ? "" : "s"} unpriced
            </span>
          )}
        </span>
      ) : (
        <span className="text-gray-500">Actions minutes n/a for this provider</span>
      )}
    </div>
  );
}
