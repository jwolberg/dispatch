import { useNavigate } from "react-router-dom";
import { Page } from "../components/Page.js";
import { StatusChip } from "../components/StatusChip.js";
import { usePolling } from "../hooks/usePolling.js";
import { boardApi, type BoardCard } from "../api/board.js";

export function BoardPage() {
  const navigate = useNavigate();
  const { data, error } = usePolling(() => boardApi.get(), 10_000);

  const columns = data?.columns ?? ["Spec", "Queued", "Building", "Ready to test", "Shipped", "Blocked"];
  const cards = data?.cards ?? [];

  function open(card: BoardCard) {
    if (card.kind === "ticket") navigate(`/tickets/${card.id}`);
    else navigate("/chat");
  }

  return (
    <Page title="Automated Workflow Tracking Board">
      {error && (
        <div className="mb-3 rounded border border-status-fail/40 bg-status-fail/10 px-3 py-2 text-body text-status-fail">
          {error}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        {columns.map((col) => {
          const colCards = cards.filter((c) => c.column === col);
          return (
            <div key={col} className="rounded-lg border border-border bg-surface/50 p-2">
              <div className="mb-2 flex items-center justify-between px-1">
                <StatusChip column={col} />
                <span className="text-label text-gray-500">{colCards.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {colCards.map((card) => (
                  <button
                    key={`${card.kind}-${card.id}`}
                    onClick={() => open(card)}
                    className="rounded-md border border-border bg-surface p-2.5 text-left hover:border-gray-500"
                  >
                    <div className="mb-1 text-label text-gray-500">
                      {card.repo.path}
                      {card.kind === "ticket" && ` · #${card.issue_number}`}
                    </div>
                    <div className="text-body text-gray-100">{card.title}</div>
                    {card.kind === "ticket" && (
                      <div className="mt-1 flex gap-2 text-label text-gray-400">
                        {card.pr && <span>PR #{card.pr.number}</span>}
                        {card.has_progress && <span className="text-status-info">↳ progress</span>}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Page>
  );
}
