import type { RunTiming } from "./types.js";

// T2-4 (ticket #14) — turn provider run-timing into an Actions cost.
//
// Pure, so the unknown-vs-zero rule is pinned in isolation from the adapters.

/**
 * GitHub-hosted **standard** Linux runner, USD per billable minute (verified
 * 2026-07-11). Larger runners bill a per-minute multiplier; we assume the
 * standard runner and the card says so, rather than quietly under-reporting a
 * big-runner job (T2-4 AC). macOS/Windows also bill more — same caveat.
 */
export const ACTIONS_USD_PER_MINUTE_STANDARD = 0.008;

export interface ActionsCost {
  minutes: number;
  usd: number;
  /** Runs whose timing the provider could not give us — counted, never priced $0. */
  unknownRuns: number;
}

/**
 * Sum billable minutes across `timings`, pricing them at the standard runner.
 *
 * A `null` entry is a run we could not price (the provider returned no timing):
 * it is reported as `unknownRuns`, never folded in as zero. A run that billed a
 * real 0 ms (skipped/cached) is a known zero and is simply counted.
 */
export function computeActionsCost(timings: (RunTiming | null)[]): ActionsCost {
  let billableMs = 0;
  let unknownRuns = 0;
  for (const t of timings) {
    if (t === null) {
      unknownRuns++;
      continue;
    }
    billableMs += t.billableMs;
  }
  const minutes = billableMs / 60_000;
  return { minutes, usd: minutes * ACTIONS_USD_PER_MINUTE_STANDARD, unknownRuns };
}
