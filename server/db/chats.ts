import { getDb } from "./migrate.js";
import { markDirty } from "./snapshot.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRow {
  id: number;
  repo_id: number;
  created_at: string;
  transcript_json: string;
  status: "draft" | "filed";
}

export function createChat(repoId: number, nowIso: string): ChatRow {
  const info = getDb()
    .prepare(
      `INSERT INTO chats (repo_id, created_at, transcript_json, status)
       VALUES (?, ?, '[]', 'draft')`
    )
    .run(repoId, nowIso);
  markDirty();
  return getChat(Number(info.lastInsertRowid))!;
}

export function getChat(id: number): ChatRow | undefined {
  return getDb().prepare("SELECT * FROM chats WHERE id = ?").get(id) as ChatRow | undefined;
}

export function getTranscript(id: number): ChatMessage[] {
  const row = getChat(id);
  if (!row) return [];
  try {
    return JSON.parse(row.transcript_json) as ChatMessage[];
  } catch {
    return [];
  }
}

export function setTranscript(id: number, messages: ChatMessage[]): void {
  getDb()
    .prepare("UPDATE chats SET transcript_json = ? WHERE id = ?")
    .run(JSON.stringify(messages), id);
  markDirty();
}

export function appendMessage(id: number, message: ChatMessage): ChatMessage[] {
  const messages = getTranscript(id);
  messages.push(message);
  setTranscript(id, messages);
  return messages;
}

export function setChatStatus(id: number, status: "draft" | "filed"): void {
  getDb().prepare("UPDATE chats SET status = ? WHERE id = ?").run(status, id);
  markDirty();
}

export function listDraftChats(): ChatRow[] {
  return getDb()
    .prepare("SELECT * FROM chats WHERE status = 'draft' ORDER BY created_at DESC")
    .all() as ChatRow[];
}

export function deleteChat(id: number): void {
  getDb().prepare("DELETE FROM chats WHERE id = ?").run(id);
  markDirty();
}
