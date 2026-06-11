import type { Ticket } from "../api/chat.js";

// Minimal preview (read-only). Editable fields + File action land in P2-T5/P3-T1.
export function TicketPreviewModal({
  open,
  ticket,
  onClose,
}: {
  open: boolean;
  ticket: Ticket | null;
  chatId: number | null;
  repoId: number | null;
  onClose: () => void;
}) {
  if (!open || !ticket) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-lg border border-border bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-[15px] font-semibold text-white">Ticket preview</h2>
        <div className="mb-2 text-body font-medium text-white">{ticket.title}</div>
        <pre className="mb-3 max-h-[50vh] overflow-auto whitespace-pre-wrap rounded bg-bg p-3 text-label text-gray-200">
          {ticket.body_markdown}
        </pre>
        <div className="flex justify-end">
          <button
            className="rounded border border-border px-3 py-1.5 text-body text-gray-200 hover:bg-surface-2"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
