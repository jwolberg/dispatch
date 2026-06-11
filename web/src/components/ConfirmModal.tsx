import type { ReactNode } from "react";

// Reusable confirmation modal for destructive actions (S5). Used for untrack
// here and ship/merge later (P4-T3).
export function ConfirmModal({
  open,
  title,
  children,
  confirmLabel = "Confirm",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-[15px] font-semibold text-white">{title}</h2>
        <div className="mb-5 text-body text-gray-300">{children}</div>
        <div className="flex justify-end gap-2">
          <button
            className="rounded border border-border px-3 py-1.5 text-body text-gray-200 hover:bg-surface-2"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className={`rounded px-3 py-1.5 text-body font-medium text-white ${
              danger ? "bg-red-600 hover:bg-red-500" : "bg-blue-600 hover:bg-blue-500"
            } disabled:opacity-50`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
