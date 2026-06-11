import { getDb } from "./migrate.js";

export interface ActivityRow {
  id: number;
  ticket_id: number | null;
  type: string;
  summary: string;
  url: string | null;
  occurred_at: string;
}

export interface NewActivity {
  ticket_id: number | null;
  type: string;
  summary: string;
  url?: string | null;
  occurred_at: string;
}

export function insertActivity(event: NewActivity): void {
  getDb()
    .prepare(
      `INSERT INTO activity (ticket_id, type, summary, url, occurred_at)
       VALUES (@ticket_id, @type, @summary, @url, @occurred_at)`
    )
    .run({
      ticket_id: event.ticket_id,
      type: event.type,
      summary: event.summary,
      url: event.url ?? null,
      occurred_at: event.occurred_at,
    });
}

export function recentActivity(limit = 50): ActivityRow[] {
  return getDb()
    .prepare("SELECT * FROM activity ORDER BY occurred_at DESC, id DESC LIMIT ?")
    .all(limit) as ActivityRow[];
}
