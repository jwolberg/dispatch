import { getDb } from "./migrate.js";

export interface ActivityRow {
  id: number;
  ticket_id: number | null;
  type: string;
  summary: string;
  url: string | null;
  occurred_at: string;
  // Enrichment for grouping (derived via joins; null when unlinked).
  repo_path: string | null;
  issue_number: number | null;
  task_title: string | null;
}

function titleFromPayload(json: string | null): string | null {
  if (!json) return null;
  try {
    const payload = JSON.parse(json) as { issue?: { title?: string } };
    return payload?.issue?.title ?? null;
  } catch {
    return null;
  }
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
  const rows = getDb()
    .prepare(
      `SELECT a.id, a.ticket_id, a.type, a.summary, a.url, a.occurred_at,
              r.path AS repo_path, t.issue_number AS issue_number,
              s.payload_json AS payload_json
       FROM activity a
       LEFT JOIN tickets t ON a.ticket_id = t.id
       LEFT JOIN repos r ON t.repo_id = r.id
       LEFT JOIN status_cache s ON s.ticket_id = t.id
       ORDER BY a.occurred_at DESC, a.id DESC
       LIMIT ?`
    )
    .all(limit) as Array<Omit<ActivityRow, "task_title"> & { payload_json: string | null }>;
  return rows.map(({ payload_json, ...row }) => ({
    ...row,
    task_title: titleFromPayload(payload_json),
  }));
}
