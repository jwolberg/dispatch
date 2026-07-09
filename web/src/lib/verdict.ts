// T1-6 — the single verdict chip.
//
// A non-engineer reading a card should see one verdict, not seven check names.
//
// The verdict is derived from `column` and nothing else. `column` is what
// deriveColumn() (server/poller/reconcile.ts) already decided by looking at the
// checks and the runs, applying T0-2's precedence table. Re-inspecting
// `pr.checks` here would be a second implementation of "are we green", and the
// two would drift — most likely at the moment they disagree most.

/** Mirrors `Column` in server/poller/reconcile.ts. Hand-synced, as api/types.ts is. */
export const COLUMNS = [
  "Spec",
  "Queued",
  "Building",
  "Ready to test",
  "Shipped",
  "Blocked",
] as const;

export type Column = (typeof COLUMNS)[number];

/**
 * `pending` is a first-class third state, not a shade of green. `Building` means
 * a check is still running; showing that as green tells the user to ship.
 */
export type Tone = "pass" | "fail" | "pending";

export interface Verdict {
  tone: Tone;
  label: string;
  /** Color is never the only signal (PRD §4). */
  icon: string;
}

const VERDICTS: Record<Column, Verdict> = {
  Spec: { tone: "pending", label: "Still a draft", icon: "◷" },
  Queued: { tone: "pending", label: "Not started", icon: "•" },
  Building: { tone: "pending", label: "Still running", icon: "◐" },
  "Ready to test": { tone: "pass", label: "Checks passed", icon: "✓" },
  Shipped: { tone: "pass", label: "Shipped", icon: "🚀" },
  Blocked: { tone: "fail", label: "Something failed", icon: "✕" },
};

/** An unrecognized column fails safe: pending, never pass. */
const UNKNOWN: Verdict = { tone: "pending", label: "Unknown", icon: "?" };

export function verdictFor(column: Column): Verdict {
  return VERDICTS[column] ?? UNKNOWN;
}

export const TONE_CLS: Record<Tone, string> = {
  pass: "border-status-ok/40 bg-status-ok/10 text-status-ok",
  fail: "border-status-fail/40 bg-status-fail/10 text-status-fail",
  pending: "border-status-wait/40 bg-status-wait/10 text-status-wait",
};
