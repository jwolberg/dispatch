import { getDb } from "./migrate.js";

export interface StatusCacheRow {
  ticket_id: number;
  payload_json: string;
  updated_at: string;
}

/**
 * Upsert a ticket's polled status snapshot. This table is disposable cache —
 * never authoritative (ARCH §6). The poller is its only writer (ARCH §8).
 * ETags are NOT stored here; see db/http-cache.ts (T0-9).
 */
export function upsertStatus(ticketId: number, payload: unknown, nowIso: string): void {
  getDb()
    .prepare(
      `INSERT INTO status_cache (ticket_id, payload_json, updated_at)
       VALUES (@ticket_id, @payload, @updated_at)
       ON CONFLICT(ticket_id) DO UPDATE SET
         payload_json = @payload,
         updated_at = @updated_at`
    )
    .run({
      ticket_id: ticketId,
      payload: JSON.stringify(payload),
      updated_at: nowIso,
    });
}

export function getStatus(ticketId: number): StatusCacheRow | undefined {
  return getDb()
    .prepare("SELECT * FROM status_cache WHERE ticket_id = ?")
    .get(ticketId) as StatusCacheRow | undefined;
}
