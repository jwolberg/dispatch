import { useState } from "react";
import { ticketsApi, type HandoffResponse } from "../api/tickets.js";
import { ApiError } from "../api/client.js";

// #38/#42 — hand this ticket to a local TerMinal session. The transcript goes
// onto the issue, and you paste the import prompt into a Claude/Codex tab in
// TerMinal; the agent files a backlog ticket from the issue. Nothing on the
// TerMinal side has to change, and Dispatch hosts nothing.

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
      await navigator.clipboard.writeText(result.importPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (insecure context, denied permission). The
      // prompt is on screen and selectable, so this is not worth an error.
      setCopied(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-1 text-body font-semibold text-gray-200">Send to TerMinal</h2>
      <p className="mb-3 text-label text-gray-500">
        Posts the spec chat to the issue, then gives you a prompt to paste into a Claude or Codex
        tab in TerMinal. The agent reads the issue and files a backlog ticket — no setup on the
        TerMinal side.
      </p>

      {error && (
        <div className="mb-2 rounded border border-status-fail/40 bg-status-fail/10 px-3 py-2 text-body text-status-fail">
          {error}
        </div>
      )}

      {result ? (
        <>
          <div className="mb-2 flex items-start gap-2">
            <pre className="flex-1 select-all overflow-x-auto whitespace-pre-wrap rounded border border-border bg-bg px-2.5 py-1.5 font-mono text-label text-gray-100">
              {result.importPrompt}
            </pre>
            <button
              className="rounded border border-border px-2.5 py-1.5 text-label text-gray-300 hover:bg-bg"
              onClick={copy}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-label text-gray-500">
            {TRANSCRIPT_NOTE[result.transcript]} Paste into a TerMinal agent tab opened in the
            target repo — the ticket is filed there. Or just open the{" "}
            <a
              className="text-status-info underline"
              href={result.issueUrl}
              target="_blank"
              rel="noreferrer"
            >
              issue ↗
            </a>
            .
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
