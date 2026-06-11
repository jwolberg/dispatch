import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Ticket } from "../api/chat.js";
import { ticketsApi } from "../api/tickets.js";
import { ApiError } from "../api/client.js";

// Editable preview before filing (PRD F2.4). On File, creates the issue via
// POST /api/tickets (backend in P3-T1) and navigates to the board.
export function TicketPreviewModal({
  open,
  ticket,
  chatId,
  repoId,
  onClose,
}: {
  open: boolean;
  ticket: Ticket | null;
  chatId: number | null;
  repoId: number | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const [filing, setFiling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ticket) {
      setTitle(ticket.title);
      setBody(ticket.body_markdown);
      setLabels(ticket.labels.join(", "));
      setError(null);
    }
  }, [ticket]);

  if (!open || !ticket) return null;

  async function file() {
    if (repoId == null) return;
    setFiling(true);
    setError(null);
    try {
      await ticketsApi.file({
        repo_id: repoId,
        chat_id: chatId,
        title: title.trim(),
        body_markdown: body,
        labels: labels
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean),
      });
      navigate("/board");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setFiling(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-[15px] font-semibold text-white">Review &amp; file ticket</h2>

        {error && (
          <div className="mb-3 rounded border border-status-fail/40 bg-status-fail/10 px-3 py-2 text-label text-status-fail">
            {error}
          </div>
        )}

        <label className="mb-1 text-label text-gray-400">Title</label>
        <input
          className="mb-3 rounded border border-border bg-bg px-2.5 py-1.5 text-body text-gray-100"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <label className="mb-1 text-label text-gray-400">Body (markdown)</label>
        <textarea
          className="mb-3 min-h-[200px] flex-1 resize-y rounded border border-border bg-bg px-2.5 py-1.5 font-mono text-label text-gray-100"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />

        <label className="mb-1 text-label text-gray-400">Labels (comma-separated)</label>
        <input
          className="mb-4 rounded border border-border bg-bg px-2.5 py-1.5 text-body text-gray-100"
          value={labels}
          onChange={(e) => setLabels(e.target.value)}
        />

        <div className="flex justify-end gap-2">
          <button
            className="rounded border border-border px-3 py-1.5 text-body text-gray-200 hover:bg-surface-2"
            onClick={onClose}
            disabled={filing}
          >
            Cancel
          </button>
          <button
            className="rounded bg-blue-600 px-3 py-1.5 text-body font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            onClick={file}
            disabled={filing || !title.trim()}
          >
            {filing ? "Filing…" : "File ticket"}
          </button>
        </div>
      </div>
    </div>
  );
}
