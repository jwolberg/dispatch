import { getDb } from "./migrate.js";
import { markDirty } from "./snapshot.js";

export interface TicketRow {
  id: number;
  repo_id: number;
  chat_id: number | null;
  issue_number: number;
  created_at: string;
}

export function createTicket(
  repoId: number,
  issueNumber: number,
  chatId: number | null,
  nowIso: string
): TicketRow {
  const info = getDb()
    .prepare(
      `INSERT INTO tickets (repo_id, chat_id, issue_number, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(repoId, chatId, issueNumber, nowIso);
  markDirty(); // shipped tickets are not re-adopted by discover.ts (#20)
  return getTicket(Number(info.lastInsertRowid))!;
}

export function getTicket(id: number): TicketRow | undefined {
  return getDb().prepare("SELECT * FROM tickets WHERE id = ?").get(id) as
    | TicketRow
    | undefined;
}

export function listTickets(): TicketRow[] {
  return getDb()
    .prepare("SELECT * FROM tickets ORDER BY created_at DESC")
    .all() as TicketRow[];
}

export function deleteTicket(id: number): boolean {
  const deleted = getDb().prepare("DELETE FROM tickets WHERE id = ?").run(id).changes > 0;
  if (deleted) markDirty();
  return deleted;
}
