import { getDb } from "./migrate.js";
import type { ChangeSummary } from "../anthropic/summary.js";

// T1-5 — disposable cache for the plain-language change summary.
//
// Keyed by head SHA. A summary of a force-pushed-away commit is not stale data,
// it is wrong data delivered confidently, and the reader has no way to tell.
//
// Deliberately NOT status_cache: that table's only writer is the poller
// (ARCH §8), it has no SHA column, and this is written from a request path.

interface Row {
  head_sha: string;
  payload_json: string;
}

/** The cached summary for this exact commit, or undefined on any miss. */
export function getSummary(ticketId: number, headSha: string): ChangeSummary | undefined {
  const row = getDb()
    .prepare("SELECT head_sha, payload_json FROM summary_cache WHERE ticket_id = ?")
    .get(ticketId) as Row | undefined;

  if (!row || row.head_sha !== headSha) return undefined;

  try {
    return JSON.parse(row.payload_json) as ChangeSummary;
  } catch {
    // Corrupt row → a miss, as in http_cache (T0-9). Costs one re-summarize.
    return undefined;
  }
}

/** Upsert this ticket's summary. One row per ticket; a new SHA replaces the old. */
export function putSummary(
  ticketId: number,
  headSha: string,
  summary: ChangeSummary,
  nowIso: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO summary_cache (ticket_id, head_sha, payload_json, updated_at)
       VALUES (@ticket_id, @head_sha, @payload, @updated_at)
       ON CONFLICT(ticket_id) DO UPDATE SET
         head_sha = @head_sha,
         payload_json = @payload,
         updated_at = @updated_at`,
    )
    .run({
      ticket_id: ticketId,
      head_sha: headSha,
      payload: JSON.stringify(summary),
      updated_at: nowIso,
    });
}

export function clearSummaries(): void {
  getDb().exec("DELETE FROM summary_cache");
}
