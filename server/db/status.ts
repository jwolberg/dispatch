import { getDb } from "./migrate.js";

export interface StatusCacheRow {
  ticket_id: number;
  payload_json: string;
  etag_map_json: string;
  updated_at: string;
}

/**
 * Upsert a ticket's polled status snapshot. This table is disposable cache —
 * never authoritative (ARCH §6). The poller is its only writer (ARCH §8).
 */
export function upsertStatus(
  ticketId: number,
  payload: unknown,
  etagMap: Record<string, string>,
  nowIso: string
): void {
  getDb()
    .prepare(
      `INSERT INTO status_cache (ticket_id, payload_json, etag_map_json, updated_at)
       VALUES (@ticket_id, @payload, @etags, @updated_at)
       ON CONFLICT(ticket_id) DO UPDATE SET
         payload_json = @payload,
         etag_map_json = @etags,
         updated_at = @updated_at`
    )
    .run({
      ticket_id: ticketId,
      payload: JSON.stringify(payload),
      etags: JSON.stringify(etagMap),
      updated_at: nowIso,
    });
}

export function getStatus(ticketId: number): StatusCacheRow | undefined {
  return getDb()
    .prepare("SELECT * FROM status_cache WHERE ticket_id = ?")
    .get(ticketId) as StatusCacheRow | undefined;
}

export function getEtagMap(ticketId: number): Record<string, string> {
  const row = getStatus(ticketId);
  if (!row) return {};
  try {
    return JSON.parse(row.etag_map_json) as Record<string, string>;
  } catch {
    return {};
  }
}
