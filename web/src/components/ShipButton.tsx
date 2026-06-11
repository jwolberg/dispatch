import { useState } from "react";
import { ConfirmModal } from "./ConfirmModal.js";
import { ticketsApi, type PRStatus } from "../api/tickets.js";
import { ApiError } from "../api/client.js";

// Ship: one-click merge gated on a green, mergeable PR, behind a confirmation
// modal summarizing the change (F6, S5).
export function ShipButton({
  ticketId,
  pr,
  repoPath,
  mergeMethod,
  ready,
  onMerged,
}: {
  ticketId: number;
  pr: PRStatus;
  repoPath: string;
  mergeMethod: string;
  ready: boolean;
  onMerged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await ticketsApi.merge(ticketId);
      setOpen(false);
      onMerged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const enabled = ready && pr.mergeable !== false;

  return (
    <div className="mt-2">
      <button
        className="rounded bg-status-ok/90 px-3 py-1.5 text-label font-semibold text-black hover:bg-status-ok disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!enabled}
        onClick={() => setOpen(true)}
        title={enabled ? "" : "Enabled when the PR is open, mergeable, and all checks are green"}
      >
        🚀 Ship
      </button>
      {error && (
        <div className="mt-1 text-label text-status-fail">
          {error}{" "}
          <a className="underline" href={pr.url} target="_blank" rel="noreferrer">
            open PR ↗
          </a>
        </div>
      )}
      <ConfirmModal
        open={open}
        title="Ship this PR?"
        confirmLabel="Merge & ship"
        busy={busy}
        onCancel={() => setOpen(false)}
        onConfirm={confirm}
      >
        <div className="space-y-1 text-body">
          <div>
            <span className="text-gray-500">Repo:</span> {repoPath}
          </div>
          <div>
            <span className="text-gray-500">PR:</span> #{pr.number} — {pr.title}
          </div>
          <div>
            <span className="text-gray-500">Target:</span> {pr.baseBranch}
          </div>
          <div>
            <span className="text-gray-500">Diff:</span> {pr.changedFiles ?? "?"} files, +
            {pr.additions ?? "?"}/-{pr.deletions ?? "?"}
          </div>
          <div>
            <span className="text-gray-500">Merge method:</span> {mergeMethod}
          </div>
        </div>
      </ConfirmModal>
    </div>
  );
}
