import { useState } from "react";
import { ConfirmModal } from "./ConfirmModal.js";
import { ticketsApi, type PRStatus, type RevertRef } from "../api/tickets.js";
import { ApiError } from "../api/client.js";

// Revert (T1-8): the recovery path for a card that shipped something bad.
//
// Dispatch does NOT perform the revert (ADR-0004). It resolves the provider's
// own revert affordance and opens it. The modal says so plainly rather than
// implying the click undoes anything by itself — the user is about to leave the
// app, and finding that out after the click is worse than before it.
//
// Once they finish, the poller detects the revert PR and it appears below.
export function RevertButton({
  ticketId,
  pr,
  repoPath,
  provider,
  revertPr,
}: {
  ticketId: number;
  pr: PRStatus;
  repoPath: string;
  provider: string;
  revertPr: RevertRef | null;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A revert already exists — link to it rather than offering to start another.
  if (revertPr && revertPr.state !== "closed") {
    return (
      <div className="mt-2 text-label">
        <span className="text-gray-500">Revert:</span>{" "}
        <a className="underline" href={revertPr.url} target="_blank" rel="noreferrer">
          #{revertPr.number} {revertPr.state === "merged" ? "merged" : "open"} ↗
        </a>
      </div>
    );
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await ticketsApi.revertUrl(ticketId);
      // Opened from the click handler's async continuation; some browsers treat
      // this as a popup. noopener is still correct — we never need the handle.
      window.open(url, "_blank", "noopener,noreferrer");
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const where = provider === "gitlab" ? "GitLab" : "GitHub";

  return (
    <div className="mt-2">
      <button
        className="rounded border border-status-fail/50 px-3 py-1.5 text-label font-semibold text-status-fail hover:bg-status-fail/10"
        onClick={() => setOpen(true)}
      >
        ↩︎ Revert
      </button>
      {error && <div className="mt-1 text-label text-status-fail">{error}</div>}
      <ConfirmModal
        open={open}
        title="Revert this change?"
        confirmLabel={`Open ${where}`}
        busy={busy}
        onCancel={() => setOpen(false)}
        onConfirm={confirm}
      >
        <div className="space-y-1 text-body">
          <div>
            <span className="text-gray-500">Repo:</span> {repoPath}
          </div>
          <div>
            <span className="text-gray-500">Reverting:</span> #{pr.number} — {pr.title}
          </div>
          <p className="pt-1 text-gray-500">
            This opens {where} in a new tab, where you confirm the revert. Nothing changes until you
            do. The revert will then show up on this card.
          </p>
        </div>
      </ConfirmModal>
    </div>
  );
}
