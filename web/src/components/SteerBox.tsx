import { useState } from "react";
import { ticketsApi } from "../api/tickets.js";
import { ApiError } from "../api/client.js";

// Steer: post a comment to the issue or PR to course-correct mid-build (F4.5).
// Include @claude to re-trigger the build.
export function SteerBox({ ticketId, hasPR }: { ticketId: number; hasPR: boolean }) {
  const [text, setText] = useState("");
  const [target, setTarget] = useState<"issue" | "pr">("issue");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    setNote(null);
    try {
      await ticketsApi.comment(ticketId, { body: text, target });
      setText("");
      setNote("Comment posted.");
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-2 text-body font-semibold text-gray-200">Steer</h2>
      <p className="mb-2 text-label text-gray-500">
        Comment to course-correct. Include <code>@claude</code> to re-trigger the build.
      </p>
      <textarea
        className="mb-2 min-h-[70px] w-full resize-y rounded border border-border bg-bg px-2.5 py-1.5 text-body text-gray-100"
        placeholder="@claude also handle the empty-state case…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <select
          className="rounded border border-border bg-bg px-2 py-1.5 text-label text-gray-200"
          value={target}
          onChange={(e) => setTarget(e.target.value as "issue" | "pr")}
        >
          <option value="issue">Issue</option>
          <option value="pr" disabled={!hasPR}>
            PR
          </option>
        </select>
        <button
          className="rounded bg-blue-600 px-3 py-1.5 text-label font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          onClick={send}
          disabled={busy || !text.trim()}
        >
          {busy ? "Posting…" : "Post comment"}
        </button>
        {note && <span className="text-label text-gray-400">{note}</span>}
      </div>
    </section>
  );
}
