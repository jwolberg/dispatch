import { useState } from "react";
import { ticketsApi, type HandoffResponse } from "../api/tickets.js";
import { ApiError } from "../api/client.js";

// #38 — hand this ticket to a local TerMinal session. The laptop never talks to
// Dispatch: the transcript goes onto the issue, and the human carries one
// command across.

const TRANSCRIPT_NOTE: Record<HandoffResponse["transcript"], string> = {
  posted: "Spec chat posted to the issue.",
  "already-present": "Spec chat was already on the issue.",
  none: "No spec chat to carry — the issue body is the whole spec.",
};

export function TerminalHandoff({ ticketId }: { ticketId: number }) {
  const [result, setResult] = useState<HandoffResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      setResult(await ticketsApi.handoff(ticketId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.pickup);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (insecure context, denied permission). The
      // command is on screen and selectable, so this is not worth an error.
      setCopied(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-1 text-body font-semibold text-gray-200">Send to TerMinal</h2>
      <p className="mb-3 text-label text-gray-500">
        Pushes the spec chat onto the issue, then gives you a command to run inside your local
        clone. It files a backlog ticket — it does not start a session or an agent.
      </p>

      {error && (
        <div className="mb-2 rounded border border-status-fail/40 bg-status-fail/10 px-3 py-2 text-body text-status-fail">
          {error}
        </div>
      )}

      {result ? (
        <>
          <div className="mb-2 flex items-center gap-2">
            <code className="flex-1 select-all overflow-x-auto whitespace-nowrap rounded border border-border bg-bg px-2.5 py-1.5 font-mono text-label text-gray-100">
              {result.pickup}
            </code>
            <button
              className="rounded border border-border px-2.5 py-1.5 text-label text-gray-300 hover:bg-bg"
              onClick={copy}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-label text-gray-500">
            {TRANSCRIPT_NOTE[result.transcript]} Run it from inside the repo — the ticket is
            filed where you run it.
          </p>
        </>
      ) : (
        <button
          className="rounded bg-blue-600 px-3 py-1.5 text-body font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          disabled={busy}
          onClick={send}
        >
          {busy ? "Preparing…" : "Send to TerMinal"}
        </button>
      )}
    </section>
  );
}
